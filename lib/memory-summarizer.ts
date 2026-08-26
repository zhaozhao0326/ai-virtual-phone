// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry, MemoryConfig, MemoryRelation, MemoryRelationEntityType } from "./memory-types";
import type { ApiConfig } from "./settings-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
    getGroupRelationCursor,
    setGroupRelationCursor,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "./settings-storage";
import { loadCharacters } from "./character-storage";
import { loadChatSessions } from "./chat-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources, type NativeTimelineEntry } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    // Use user-editable prompt template from config, with placeholder substitution
    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    // Call LLM for summarization — compatible with all providers
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: summaryPrompt }],
        { temperature: 0.3, purpose: "memory-summary", characterName },
    );

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    const summary = result.content;

    // 关系图谱抽取（best-effort，不阻断主流程）：长期记忆落地关系维度
    // 设计：群聊「整群只抽一次」（群1次），结果分发回各成员记忆；
    //       纯 1:1 才按角色逐人抽（单聊本就 1 次，无 N 倍浪费）。
    let relations: MemoryRelation[] | undefined;
    if (config.relationRecallEnabled) {
        try {
            const hasGroup = allEntries.some(e => e.sourceApp === "chat" && e.sourceDetail === "group");
            if (hasGroup) {
                // 群聊：整群一次抽取（含本角色 1:1 部分），分发到各成员；
                // 本角色总结 entry 不再挂 relations（由群抽取统一分发，避免重复）。
                await runGroupRelationExtraction(characterId, characterName, allEntries, config, apiConfig);
            } else {
                // 纯 1:1：按角色抽一次（必要，非浪费）
                const extracted = await extractRelationsFromSummary(
                    summary,
                    characterName,
                    apiConfig,
                    config.relationMinConfidence,
                );
                if (extracted.length > 0) relations = extracted;
            }
        } catch {
            /* 关系抽取失败不影响主流程 */
        }
    }

    // 情感坐标抽取（best-effort，不阻断主流程）：长期记忆落地 valence/arousal
    // 高唤醒/未解决的记忆在召回时权重更高（见 memory-service computeEmotionalScore）
    let emotionCoords: { valence: number; arousal: number; resolved: boolean } | undefined;
    if (config.emotionEnabled) {
        try {
            const emo = await extractEmotionFromSummary(summary, apiConfig);
            if (emo) emotionCoords = emo;
        } catch {
            /* 情感抽取失败不影响主流程 */
        }
    }

    // Generate embedding for the summary (only if vector recall is enabled)
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const emb = await generateEmbedding(summary, embeddingApiConfig);
            if (emb) embedding = emb;
        } catch { /* ignore */ }
    }

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    // Save as long-term memory
    const now = new Date().toISOString();
    const longTermEntry: MemoryEntry = {
        id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSource as MemoryEntry["sourceApp"],
        type: "long_term",
        content: summary,
        embedding,
        importance: 0.8,
        relations,
        valence: emotionCoords?.valence,
        arousal: emotionCoords?.arousal,
        resolved: emotionCoords?.resolved,
        createdAt: now,
        updatedAt: now,
        metadata: {
            summarizedEvents: allEntries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(longTermEntry);

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → 1 long-term memory`);
    return { success: true };
}

/**
 * 从长期记忆总结中抽取关系事实（人物/地点/事物/事件/概念等）。
 * 仅 best-effort：任何失败都返回空数组，绝不阻断主总结流程。
 * 用置信度阈值过滤玩笑、比喻、一次性情绪等不可信关系。
 */
export async function extractRelationsFromSummary(
    summary: string,
    characterName: string,
    apiConfig: ApiConfig,
    minConfidence: number,
): Promise<MemoryRelation[]> {
    const prompt = `你是关系抽取助手。从下方角色记忆总结中，抽取其中涉及的"关系事实"——即角色与某个人/地点/事物/事件/概念之间的稳定关系，或不同实体之间的关系。

角色：${characterName}
记忆总结：
${summary}

要求：
- 只抽取明确、稳定、可信的关系（如"认识小明""小明是用户的弟弟""常去某咖啡馆"），不要抽取玩笑、比喻、一次性情绪或推测。
- 每条关系输出四个字段：entity（实体名，如"小明""公司楼下咖啡馆"）、entityType（person / place / thing / event / concept 之一）、relation（关系简述，如"用户弟弟""常去地点"）、confidence（0-1 数字，你对该关系真实稳定的置信度）。
- 只输出 JSON 数组，不要任何额外文字或解释。置信度低于 ${minConfidence} 的关系不要输出。
- 最多 8 条。
格式示例：[{"entity":"小明","entityType":"person","relation":"用户弟弟","confidence":0.9}]`;

    try {
        const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.2, purpose: "memory-relations", characterName });
        if (!result.content) return [];
        const parsed = parseRelationJsonArray(result.content);
        if (!parsed) return [];
        return parsed
            .filter(r => r && typeof r.entity === "string" && typeof r.confidence === "number")
            .map(r => ({
                entity: String(r.entity).trim(),
                entityType: (["person", "place", "thing", "event", "concept"].includes(r.entityType) ? r.entityType : "thing") as MemoryRelationEntityType,
                relation: typeof r.relation === "string" ? r.relation.trim() : "",
                confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
            }))
            .filter(r => r.entity.length >= 1 && r.relation.length >= 1 && r.confidence >= minConfidence)
            .slice(0, 8);
    } catch {
        return [];
    }
}

/** 从 LLM 可能夹带的解释文字中提纯 JSON 数组。 */
function parseRelationJsonArray(text: string): any[] | null {
    try {
        const match = text.match(/\[[\s\S]*\]/);
        const json = match ? match[0] : text.trim();
        const data = JSON.parse(json);
        return Array.isArray(data) ? data : null;
    } catch {
        return null;
    }
}

/**
 * 群聊关系抽取（群1次）：整群只抽一次，结果分发回各成员记忆。
 * - 去重：进程内锁（groupExtractingSet）+ 每群水位线（getGroupRelationCursor），避免 N 个成员各抽一遍。
 * - 1:1 私聊部分也并入同一次抽取（若该角色同时有私聊），不另起调用。
 * - 只写 relations、不生成 embedding（靠关系召回即可），省 token。
 * - best-effort：任何失败都静默跳过，绝不阻断主总结流程，也不动基础记忆三件套。
 */
const groupExtractingSet = new Set<string>();

type GroupRelationResult = {
    subjects: { name: string; relations: MemoryRelation[] }[];
    interRelations: { from: string; to: string; relation: string; confidence: number }[];
};

async function runGroupRelationExtraction(
    characterId: string,
    _characterName: string,
    allEntries: NativeTimelineEntry[],
    config: MemoryConfig,
    apiConfig: ApiConfig,
): Promise<void> {
    const groupSessions = new Map<string, { name?: string; entries: NativeTimelineEntry[] }>();
    for (const e of allEntries) {
        if (e.sourceApp === "chat" && e.sourceDetail === "group" && e.groupSessionId) {
            if (!groupSessions.has(e.groupSessionId)) {
                groupSessions.set(e.groupSessionId, { name: e.groupName, entries: [] });
            }
            groupSessions.get(e.groupSessionId)!.entries.push(e);
        }
    }
    if (groupSessions.size === 0) return;

    const chars = loadCharacters();
    const userName = resolveUserIdentity(characterId)?.name ?? "用户";

    for (const [groupId, info] of groupSessions) {
        if (groupExtractingSet.has(groupId)) continue; // 其他成员正在抽，跳过
        const cursor = getGroupRelationCursor(groupId);
        const newEntries = cursor ? info.entries.filter(e => e.timestamp > cursor) : info.entries;
        if (newEntries.length < 4) continue; // 新群消息过少不抽，省 token

        groupExtractingSet.add(groupId);
        try {
            const formatted = formatTimelineForSummarization(newEntries);
            if (!formatted) continue;
            const session = loadChatSessions().find(s => s.id === groupId);
            const memberNames = (session?.participantIds ?? [])
                .map(id => chars.find(c => c.id === id)?.name)
                .filter((n): n is string => Boolean(n));
            const result = await extractGroupRelations(
                formatted.eventsText,
                memberNames,
                userName,
                apiConfig,
                config.relationMinConfidence,
            );
            const latestTs = newEntries[newEntries.length - 1].timestamp;
            // 无论是否抽到关系，只要 LLM 已成功处理过这段群消息就推进水位线，
            // 避免下次触发对同一段群消息重复抽取、重复计费（实打实的 token 浪费）。
            setGroupRelationCursor(groupId, latestTs);
            if (result && (result.subjects.length > 0 || result.interRelations.length > 0)) {
                await distributeGroupRelations(result, chars, groupId, info.name, config);
            }
        } catch {
            /* best-effort */
        } finally {
            groupExtractingSet.delete(groupId);
        }
    }
}

/**
 * 从群聊记录中抽取「归属到各角色」的关系 + 角色之间的关系。
 * 仅 best-effort：任何失败返回 null，绝不阻断主流程。
 */
async function extractGroupRelations(
    eventsText: string,
    memberNames: string[],
    userName: string,
    apiConfig: ApiConfig,
    minConfidence: number,
): Promise<GroupRelationResult | null> {
    const memberLine = memberNames.length > 0 ? `群成员角色：${memberNames.join("、")}` : "";
    const prompt = `你是关系抽取助手。从下方聊天记录中，抽取稳定的"关系事实"。
${memberLine}
用户名为：${userName}

聊天记录：
${eventsText}

要求：
- 只抽取明确、稳定、可信的关系（如"小明是用户的弟弟""A 与 B 是冤家"），不要抽取玩笑、比喻、一次性情绪或推测。
- 输出严格 JSON 对象（不要任何其他文字）：
{
  "subjects": [ { "name": "角色名或用户", "relations": [ {"entity":"实体名","entityType":"person|place|thing|event|concept","relation":"关系简述","confidence":0-1} ] } ],
  "interRelations": [ {"from":"角色A名","to":"角色B名","relation":"两者关系","confidence":0-1} ]
}
- subjects 里每个 name 是「关系归属者」，relations 是该归属者与某人/地点/事物之间的稳定关系。
- interRelations 是两个角色之间的关系（如冤家、情侣、上下级），需互惠。
- 置信度低于 ${minConfidence} 的不输出。subjects / interRelations 都可能为空数组。
- subjects 最多 12 条 relations，interRelations 最多 8 条。`;

    try {
        const result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.2, purpose: "memory-group-relations" },
        );
        if (!result.content) return null;
        const match = result.content.match(/\{[\s\S]*\}/);
        const json = match ? match[0] : result.content.trim();
        const data = JSON.parse(json);
        if (!data || typeof data !== "object") return null;

        const normRel = (r: any): MemoryRelation | null => {
            if (!r || typeof r.entity !== "string" || typeof r.relation !== "string") return null;
            const confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0));
            if (confidence < minConfidence) return null;
            return {
                entity: String(r.entity).trim(),
                entityType: (["person", "place", "thing", "event", "concept"].includes(r.entityType) ? r.entityType : "thing") as MemoryRelationEntityType,
                relation: String(r.relation).trim(),
                confidence,
            };
        };

        const subjects = Array.isArray(data.subjects)
            ? data.subjects
                .map((s: any) => ({
                    name: String(s?.name ?? "").trim(),
                    relations: Array.isArray(s?.relations) ? s.relations.map(normRel).filter(Boolean as any) : [],
                }))
                .filter((s: any) => s.name && s.relations.length > 0)
            : [];
        const interRelations = Array.isArray(data.interRelations)
            ? data.interRelations
                .map((r: any) => ({
                    from: String(r?.from ?? "").trim(),
                    to: String(r?.to ?? "").trim(),
                    relation: typeof r?.relation === "string" ? String(r.relation).trim() : "",
                    confidence: Math.max(0, Math.min(1, Number(r?.confidence) || 0)),
                }))
                .filter((r: any) => r.from && r.to && r.relation && r.confidence >= minConfidence)
                .slice(0, 8)
            : [];
        return { subjects, interRelations };
    } catch {
        return null;
    }
}

/**
 * 把群抽取结果写回各成员记忆：
 * - subjects：每个归属者的 relations 写入该角色的一条「群关系快照」长期记忆（靠 relations 做关系召回，不生成 embedding 省 token）。
 * - interRelations：互惠写入双方（A 记"B是冤家"、B 记"A是冤家"），可被任一方召回。
 * 用户（userName）不在角色列表，跳过不写。每角色最多保留 60 条快照，超出删最旧。
 */
async function distributeGroupRelations(
    result: GroupRelationResult,
    chars: ReturnType<typeof loadCharacters>,
    groupId: string,
    groupName: string | undefined,
    config: MemoryConfig,
): Promise<void> {
    const nameToId = new Map<string, string>();
    for (const c of chars) nameToId.set(c.name, c.id);

    const writeForSubject = async (subjectName: string, relations: MemoryRelation[]): Promise<void> => {
        const cid = nameToId.get(subjectName);
        if (!cid) return; // 不在角色列表（如"用户"）跳过
        const content = `群聊「${groupName || "群聊"}」关系快照（自动抽取）：${relations.map(r => `${r.entity}(${r.relation})`).join("、")}`;
        const now = new Date().toISOString();
        const entry: MemoryEntry = {
            id: `mem_grprel_${groupId}_${cid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            characterId: cid,
            sourceApp: "chat",
            type: "long_term",
            content,
            importance: 0.7,
            relations,
            createdAt: now,
            updatedAt: now,
            metadata: { groupRelationSnapshot: true, groupSessionId: groupId, groupName },
        };
        await saveMemoryEntry(entry);
    };

    for (const s of result.subjects) {
        await writeForSubject(s.name, s.relations);
    }
    for (const ir of result.interRelations) {
        const relFrom: MemoryRelation = { entity: ir.to, entityType: "person", relation: ir.relation, confidence: ir.confidence };
        const relTo: MemoryRelation = { entity: ir.from, entityType: "person", relation: ir.relation, confidence: ir.confidence };
        await writeForSubject(ir.from, [relFrom]);
        await writeForSubject(ir.to, [relTo]);
    }

    const affected = new Set<string>();
    for (const s of result.subjects) {
        const id = nameToId.get(s.name);
        if (id) affected.add(id);
    }
    for (const ir of result.interRelations) {
        const a = nameToId.get(ir.from);
        const b = nameToId.get(ir.to);
        if (a) affected.add(a);
        if (b) affected.add(b);
    }
    for (const cid of affected) {
        await enforceGroupRelationCap(cid, 60);
    }
}

/** 控制群关系快照数量：每角色最多 limit 条，超出删最旧。 */
async function enforceGroupRelationCap(characterId: string, limit: number): Promise<void> {
    try {
        const entries = (await loadMemoryEntries(characterId))
            .filter(e => e.metadata?.groupRelationSnapshot === true)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (entries.length > limit) {
            const excess = entries.slice(0, entries.length - limit);
            await deleteMemoryEntries(excess.map(e => e.id));
        }
    } catch {
        /* ignore */
    }
}

/**
 * 从长期记忆总结中抽取情感坐标（valence/arousal/resolved）。
 * 仅 best-effort：任何失败都返回 null，绝不阻断主总结流程。
 * 高唤醒、未解决的记忆会在召回排序中加权（memory-service.computeEmotionalScore）。
 */
async function extractEmotionFromSummary(
    summary: string,
    apiConfig: ApiConfig,
): Promise<{ valence: number; arousal: number; resolved: boolean } | null> {
    const prompt = `你是情绪标注助手。阅读下方角色记忆总结，判断这段经历的情绪基调与状态。

记忆总结：
${summary}

输出严格 JSON 对象（不要任何其他文字）：
{"valence": 0-1数字（情绪效价：0=消极/负面，1=积极/正面，中性约0.5）, "arousal": 0-1数字（唤醒度/情绪强度：0=平静平淡，1=强烈激烈）, "resolved": true或false（这段经历是否已告一段落/已解决；未完成的事、未化解的矛盾、悬而未决的约定为 false）}

示例：{"valence":0.8,"arousal":0.6,"resolved":true}`;

    try {
        const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.2, purpose: "memory-emotion" });
        if (!result.content) return null;
        const match = result.content.match(/\{[\s\S]*\}/);
        const json = match ? match[0] : result.content.trim();
        const data = JSON.parse(json);
        if (!data || typeof data !== "object") return null;
        const clamp = (v: unknown, fallback: number) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
        };
        return {
            valence: clamp(data.valence, 0.5),
            arousal: clamp(data.arousal, 0.3),
            resolved: data.resolved !== false,
        };
    } catch {
        return null;
    }
}
