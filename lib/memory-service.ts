// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                // 关系图谱召回：上下文提到已知实体时，对相关记忆做加权
                const mentioned = config.relationRecallEnabled
                    ? findMentionedRelationEntities(longTermEntries, currentContext)
                    : new Set<string>();
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding, entry.embedding!)
                        + (mentioned.size ? RELATION_RECALL_WEIGHT * relationRelevanceScore(entry, mentioned) : 0),
                }));
                scored.sort((a, b) => b.score - a.score);
                return fillByBudget(scored.map(s => s.entry), budget);
            }
        }
    }

    // Strategy 3: no embedding support → relation-boosted recency, fill by budget
    let sorted: MemoryEntry[] | undefined;
    if (config.relationRecallEnabled) {
        const mentioned = findMentionedRelationEntities(longTermEntries, currentContext);
        if (mentioned.size > 0) {
            sorted = [...longTermEntries].sort((a, b) => {
                const ra = relationRelevanceScore(a, mentioned);
                const rb = relationRelevanceScore(b, mentioned);
                if (ra !== rb) return rb - ra;
                return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            });
        }
    }
    sorted = sorted ?? [...longTermEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}

// ── Relationship-graph recall ──
// 关系图谱维度：长期记忆抽取出「人物/地点/事物…」关系实体后，若当前对话上下文
// 提到了某个已知实体，就把与之相关的记忆加权召回——即使语义向量相似度不高，
// 也能把"小明那件事""那家咖啡馆"一并带出来，强化关系连贯性。

const RELATION_RECALL_WEIGHT = 0.3;

/** 从全部长期记忆的关系中，找出在上下文里被提及的实体名集合。 */
function findMentionedRelationEntities(entries: MemoryEntry[], context: string): Set<string> {
    const mentioned = new Set<string>();
    for (const entry of entries) {
        const rels = entry.relations;
        if (!rels || rels.length === 0) continue;
        for (const r of rels) {
            const ent = r.entity;
            if (ent && ent.length >= 2 && context.includes(ent)) {
                mentioned.add(ent);
            }
        }
    }
    return mentioned;
}

/** 一条记忆对「已提及关系实体」的关联强度（0-1，取命中实体的最高置信度）。 */
function relationRelevanceScore(entry: MemoryEntry, mentioned: Set<string>): number {
    const rels = entry.relations;
    if (!rels || rels.length === 0 || mentioned.size === 0) return 0;
    let best = 0;
    for (const r of rels) {
        if (mentioned.has(r.entity)) best = Math.max(best, r.confidence);
    }
    return best;
}
