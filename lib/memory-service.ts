// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";

// ── 情感加权召回（IB-Mobile 评分公式移植，v88 系） ──
// score = importance(1-10) × activationFactor(软饱和) × exp(-λ·天) × emotionFactor(情绪唤醒)
// - 未解决记忆衰减更慢（λ=0.05 vs 0.12）：没做完的事更容易被想起
// - 高唤醒记忆权重更高（arousal×0.8）：情绪强烈的时刻更值得浮现
// - 激活软饱和（ac/(ac+300)）：越常被想起越稳，但不无限放大
// - 反疲劳：2h 内激活 >5 次降权 0.7，防止同一段记忆刷屏
const EMOTION_RECALL_WEIGHT = 0.15;      // 向量分支中情感分的权重（语义相似度仍主导）
const FATIGUE_ACTIVATIONS = 5;
const FATIGUE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** 一条记忆的「情感加权分」（0-10 量级），用于排序提升高情绪/未解决记忆。 */
export function computeEmotionalScore(entry: MemoryEntry, now = Date.now()): number {
    const importance = 1 + (entry.importance ?? 0.5) * 9; // 小手机 0-1 → IB 1-10
    const ac = Math.max(0, entry.activationCount || 0);
    const activationFactor = 1 + ac / (ac + 300);
    const rawCreated = entry.lastActivated || entry.createdAt || String(now);
    const createdMs = new Date(rawCreated).getTime();
    const daysSince = Number.isFinite(createdMs) ? Math.max(0, (now - createdMs) / 86_400_000) : 0;
    const lambda = entry.resolved ? 0.12 : 0.05;
    const emotionFactor = 1 + (entry.arousal ?? 0.3) * 0.8;
    let score = importance * activationFactor * Math.exp(-lambda * daysSince) * emotionFactor;
    // 反疲劳：短时间高频激活降权
    const lastAct = entry.lastActivated ? new Date(entry.lastActivated).getTime() : 0;
    if ((ac) > FATIGUE_ACTIVATIONS && Number.isFinite(lastAct) && now - lastAct < FATIGUE_WINDOW_MS) {
        score *= 0.7;
    }
    return Math.round(score * 100) / 100;
}

/** 把情感分归一化到 0-1（用于与余弦相似度相加）。 */
function emotionScore01(entry: MemoryEntry): number {
    return Math.min(1, computeEmotionalScore(entry) / 10);
}

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → relation-boosted emotional ranking, fill until budget
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
        touchActivation(longTermEntries);
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
                        + (mentioned.size ? RELATION_RECALL_WEIGHT * relationRelevanceScore(entry, mentioned) : 0)
                        + EMOTION_RECALL_WEIGHT * emotionScore01(entry),
                }));
                scored.sort((a, b) => b.score - a.score);
                const picked = fillByBudget(scored.map(s => s.entry), budget);
                touchActivation(picked);
                return picked;
            }
        }
    }

    // Strategy 3: no embedding support → relation-boosted emotional ranking, fill by budget
    // 排序键：关系命中 > 情感加权分（含时间衰减）> 创建时间。高情绪/未解决的旧记忆不再沉底。
    let sorted: MemoryEntry[] | undefined;
    if (config.relationRecallEnabled) {
        const mentioned = findMentionedRelationEntities(longTermEntries, currentContext);
        if (mentioned.size > 0) {
            sorted = [...longTermEntries].sort((a, b) => {
                const ra = relationRelevanceScore(a, mentioned);
                const rb = relationRelevanceScore(b, mentioned);
                if (ra !== rb) return rb - ra;
                const ea = computeEmotionalScore(a);
                const eb = computeEmotionalScore(b);
                if (ea !== eb) return eb - ea;
                return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            });
        }
    }
    sorted = sorted ?? [...longTermEntries].sort((a, b) => {
        const ea = computeEmotionalScore(a);
        const eb = computeEmotionalScore(b);
        if (ea !== eb) return eb - ea;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    const picked = fillByBudget(sorted, budget);
    touchActivation(picked);
    return picked;
}

/** 被召回的记忆激活计数 +1（fire-and-forget，best-effort；供软饱和/反疲劳用）。 */
function touchActivation(entries: MemoryEntry[]): void {
    if (!entries || entries.length === 0) return;
    const now = new Date().toISOString();
    for (const entry of entries) {
        if (!entry.id) continue;
        const updated: MemoryEntry = {
            ...entry,
            activationCount: (entry.activationCount || 0) + 1,
            lastActivated: now,
        };
        saveMemoryEntry(updated).catch(() => { /* best-effort */ });
    }
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
