// lib/chat-offline-memory.ts
// 线下「多人同框」记忆桥：把一次线下对话沉淀进【每个在场角色】的长期记忆（共同经历桶），
// 让被邀请的角色在之后的任何对话里都能「想起」这段线下时光。
//
// 设计要点：
// - 直接写 MemoryEntry（long_term），不复用 maybeRunSummarization（那条读的是线上 native timeline，看不到离线 turn）。
// - 不额外调 LLM：只把「用户说了什么 + 场景片段」拼成一条简明记忆，零 token 成本（仅本地存储写入）。
// - 仅在多人场景（有被邀请角色）时写，单人线下不动记忆（保持原有行为）。
// - 每角色最多保留最近 OFFLINE_MEMORY_CAP 条离线记忆，防本地存储无限增长。
// - 全部 best-effort：任何失败静默跳过，绝不阻断线下生成主流程。

import type { MemoryEntry } from "./memory-types";
import { saveMemoryEntry, loadMemoryEntries, deleteMemoryEntries } from "./memory-storage";
import { loadCharacters } from "./character-storage";

/** 每角色保留的离线记忆上限（超出删最旧）。 */
const OFFLINE_MEMORY_CAP = 50;

function clip(s: string, n = 220): string {
    const t = (s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * 把一次线下对话写进每个在场角色的长期记忆。
 * @param participantIds 在场角色 id 列表（含主角色）
 * @param mainId 主角色 id
 * @param userText 用户本轮输入
 * @param assistantText 模型生成的线下场景文本（含各角色台词）
 */
export async function recordOfflineSceneToMemory(opts: {
    sessionId: string;
    participantIds: string[];
    mainId: string;
    userText: string;
    assistantText: string;
}): Promise<void> {
    const { sessionId, participantIds, mainId, userText, assistantText } = opts;
    // 仅多人场景（存在被邀请角色）才写，避免改动单人线下行为
    if (participantIds.length < 2 || !assistantText.trim()) return;

    const chars = loadCharacters();
    const nameOf = (id: string) => chars.find((c) => c.id === id)?.name?.trim() || "某人";
    const now = new Date().toISOString();
    const clipUser = clip(userText, 120);
    const clipScene = clip(assistantText, 260);

    for (const pid of participantIds) {
        if (!pid) continue;
        const companions = participantIds.filter((id) => id !== pid).map(nameOf);
        const companionLine = companions.length ? companions.join("、") : "（独自）";
        const content =
            `【线下共同时光】曾与用户及${companionLine}一同线下相处：用户说"${clipUser}"；` +
            `当时场景里${clipScene}`;
        const entry: MemoryEntry = {
            id: `mem_off_${sessionId}_${pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            characterId: pid,
            sourceApp: "chat",
            type: "long_term",
            content,
            importance: 0.7,
            createdAt: now,
            updatedAt: now,
            metadata: { offlineScene: true, sessionId, sceneCompanions: companions },
        };
        try {
            await saveMemoryEntry(entry);
        } catch {
            /* best-effort */
        }
    }

    // 每角色至多保留最近 OFFLINE_MEMORY_CAP 条离线记忆
    for (const pid of participantIds) {
        if (!pid) continue;
        try {
            const all = (await loadMemoryEntries(pid))
                .filter((e) => e.metadata && e.metadata.offlineScene === true)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            if (all.length > OFFLINE_MEMORY_CAP) {
                const excess = all.slice(OFFLINE_MEMORY_CAP);
                await deleteMemoryEntries(excess.map((e) => e.id));
            }
        } catch {
            /* best-effort */
        }
    }
}
