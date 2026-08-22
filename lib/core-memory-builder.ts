import type { MemoryEntry } from "./memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntries,
    getCoreMemoryCounter,
    resetCoreMemoryCounter,
    getLastCoreSummarizedTimestamp,
    setLastCoreSummarizedTimestamp,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";

const coreBuildingSet = new Set<string>();

type CoreTimelineItem = {
    id: string;
    timestamp: string;
    content: string;
    sourceApp: MemoryEntry["sourceApp"];
    sourceSessionIds: string[];
};

function formatCoreTimelineForSummarization(
    entries: CoreTimelineItem[],
): { eventsText: string; earliest: string; latest: string; count: number } | null {
    if (entries.length === 0) return null;
    return {
        eventsText: entries.map(entry => `- ${entry.content}`).join("\n"),
        earliest: entries[0].timestamp,
        latest: entries[entries.length - 1].timestamp,
        count: entries.length,
    };
}

export async function runCoreMemoryPipeline(
    characterId: string,
    characterName: string,
    options?: { force?: boolean },
): Promise<{ success: boolean; error?: string; rebuiltCount?: number }> {
    const config = loadMemoryConfig();
    const allLongTermEntries = await loadMemoryEntriesByType(characterId, "long_term");

    if (allLongTermEntries.length === 0) {
        return { success: false, error: "没有可用于总结核心记忆的长期记忆" };
    }

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    const afterTimestamp = options?.force ? undefined : (getLastCoreSummarizedTimestamp(characterId) ?? undefined);
    const entries = allLongTermEntries
        .filter(entry => !afterTimestamp || entry.createdAt > afterTimestamp)
        .map(entry => ({
            id: entry.id,
            timestamp: entry.createdAt,
            content: entry.content,
            sourceApp: entry.sourceApp,
            sourceSessionIds: Array.isArray(entry.metadata?.sourceSessionIds)
                ? entry.metadata.sourceSessionIds.map(String)
                : [],
        }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (entries.length === 0) {
        if (!options?.force) resetCoreMemoryCounter(characterId);
        return { success: false, error: "没有新的长期记忆需要总结" };
    }

    const formatted = formatCoreTimelineForSummarization(entries);
    if (!formatted) return { success: false, error: "格式化核心记忆数据失败" };

    const { eventsText, earliest, latest } = formatted;
    const promptTemplate = config.coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT;
    const prompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText)
        .replace(/\{\{longTermMemories\}\}/gi, eventsText);

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "核心记忆总结失败" };
    }
    if (result.wasTruncated) {
        return { success: false, error: "核心记忆总结结果疑似被截断，已取消入库，请稍后重试" };
    }

    const summary = result.content.trim();
    if (!summary) {
        return { success: false, error: "核心记忆总结结果为空" };
    }

    const now = new Date().toISOString();
    const sourceCounts = new Map<string, number>();
    for (const entry of entries) {
        sourceCounts.set(entry.sourceApp, (sourceCounts.get(entry.sourceApp) || 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) {
            dominantSource = src as MemoryEntry["sourceApp"];
            maxCount = count;
        }
    }
    const sourceSessionIds = Array.from(new Set(entries.flatMap(entry => entry.sourceSessionIds)));

    const coreEntry: MemoryEntry = {
        id: `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSource,
        type: "core",
        content: summary,
        importance: 0.95,
        createdAt: now,
        updatedAt: now,
        metadata: {
            summarizedLongTermEntries: entries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(coreEntry);

    setLastCoreSummarizedTimestamp(characterId, latest);
    if (!options?.force) {
        resetCoreMemoryCounter(characterId);
    }

    // 核心记忆封顶：超过上限时把最旧的若干条合并成一条压缩摘要，
    // 避免无限累积导致注入 prompt 膨胀、超出模型上下文窗口。
    await enforceCoreMemoryCap(characterId, characterName);

    return { success: true, rebuiltCount: 1 };
}

async function enforceCoreMemoryCap(characterId: string, characterName: string): Promise<void> {
    const config = loadMemoryConfig();
    const cap = config.maxCoreEntries && config.maxCoreEntries > 0 ? config.maxCoreEntries : 50;
    const allCore = await loadMemoryEntriesByType(characterId, "core");
    if (allCore.length <= cap) return;

    const overflow = allCore.length - cap;
    const sorted = allCore.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const oldest = sorted.slice(0, overflow);
    if (oldest.length === 0) return;

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        // 没有辅助 API 就直接丢弃最旧的，避免无限膨胀（内容已沉淀进更新的核心记忆）。
        await deleteMemoryEntries(oldest.map(e => e.id));
        return;
    }

    const mergedText = oldest.map(e => `- ${e.content}`).join("\n");
    const prompt = `你是一个核心记忆整理助手。以下是对${characterName}较早时期的多条核心记忆，请将它们压缩合并为一条更精炼的核心记忆，保留仍然成立的关键事实与关系状态，去掉已被后续记忆覆盖或重复的细节。\n\n${mergedText}\n\n合并后的核心记忆：`;

    const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.3 });
    if (!result.content || result.wasTruncated) {
        // 合并失败则保守丢弃最旧条目，不阻塞主流程。
        await deleteMemoryEntries(oldest.map(e => e.id));
        return;
    }

    const now = new Date().toISOString();
    const mergedEntry: MemoryEntry = {
        id: `mem_core_merged_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: oldest[0].sourceApp,
        type: "core",
        content: result.content.trim(),
        importance: 0.95,
        createdAt: now,
        updatedAt: now,
        metadata: {
            mergedFrom: oldest.length,
            timeSpan: `${oldest[0].createdAt} ~ ${oldest[oldest.length - 1].createdAt}`,
        },
    };
    await deleteMemoryEntries(oldest.map(e => e.id));
    await saveMemoryEntry(mergedEntry);
}

export async function maybeRunCoreMemoryPipeline(
    characterId: string,
    characterName: string,
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoBuildCoreEnabled) return;

    const counter = getCoreMemoryCounter(characterId);
    if (counter < config.coreSummarizationInterval) return;

    if (coreBuildingSet.has(characterId)) return;
    coreBuildingSet.add(characterId);
    try {
        const result = await runCoreMemoryPipeline(characterId, characterName);
        if (!result.success) {
            console.warn("[CoreMemory] Auto summary failed:", result.error);
        }
    } finally {
        coreBuildingSet.delete(characterId);
    }
}
