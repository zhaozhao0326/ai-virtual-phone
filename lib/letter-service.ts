// lib/letter-service.ts
// Letters 异步信生成：角色基于「对小手机里全部了解」写信投递。
//
// 与小手机的融合方式（不照搬 IB）：
// - 写信上下文 = 用户身份（我页名片）+ 最近聊天 + 长期记忆（含情感坐标/关系图谱）
//   + 核心记忆 + 认知档案（Auto Memory，若开启）+ 关系成长阶段 + 之前的信（避免重复）
// - 调用角色自己的主 API（与聊天同源），不污染会话历史
// - 冷却 3 分钟；生成失败静默跳过不打扰
// - 信落库为独立 letters 表，档案页「信箱」拆信阅读

import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { loadCharacters } from "./character-storage";
import { loadChatMessages, createOrGetSession } from "./chat-storage";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveMemoriesForPrompt, retrieveCoreMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { retrieveAutoMemoryForPrompt } from "./auto-memory-service";
import { computeRelationshipGrowth, relationshipStagePromptLine } from "./relationship-growth";
import { loadLetters, saveLetter, type LetterEntry } from "./letter-storage";

const LETTER_COOLDOWN_MS = 3 * 60 * 1000;
const LETTER_COOLDOWN_KEY_PREFIX = "ai_phone_letter_cd_";
const LETTER_MAX_HISTORY = 30;      // 最近聊天条数
const LETTER_HISTORY_CHARS = 150;   // 每条截断字符

function getLastRequestTime(characterId: string): number {
    try {
        return Number(localStorage.getItem(LETTER_COOLDOWN_KEY_PREFIX + characterId) || "0");
    } catch {
        return 0;
    }
}

export function getLetterCooldownRemaining(characterId: string): number {
    const last = getLastRequestTime(characterId);
    if (!last) return 0;
    return Math.max(0, LETTER_COOLDOWN_MS - (Date.now() - last));
}

/**
 * 请角色写信。收集小手机里对该角色的全部了解作为上下文，调用其主 API 生成书信并落库。
 * @returns 新信件；无 API / 冷却中 / 生成失败返回 null
 */
export async function requestLetter(characterId: string): Promise<LetterEntry | null> {
    if (typeof window === "undefined") return null;
    const cooldown = getLetterCooldownRemaining(characterId);
    if (cooldown > 0) return null;

    const chars = loadCharacters();
    const char = chars.find(c => c.id === characterId);
    if (!char) return null;

    // 角色主 API（与聊天同源）
    const bindings = loadBindingConfig();
    const activeSlot = resolveBinding(bindings, characterId, "chat");
    const apiConfig = activeSlot.apiConfigId
        ? loadApiConfigs().find(c => c.id === activeSlot.apiConfigId) ?? null
        : null;
    if (!apiConfig) return null;

    try {
        const userName = resolveUserIdentity(characterId, "chat")?.name || "用户";
        const session = createOrGetSession(characterId);
        const messages = loadChatMessages(session.id);
        const recentChat = [...messages]
            .filter(m => m.role === "user" || m.role === "assistant")
            .slice(-LETTER_MAX_HISTORY)
            .map(m => {
                const who = m.role === "user" ? userName : (char.name || "对方");
                const text = String(m.content || "");
                return `${who}：${text.slice(0, LETTER_HISTORY_CHARS)}${text.length > LETTER_HISTORY_CHARS ? "…" : ""}`;
            })
            .join("\n");

        const memConfig = loadMemoryConfig();
        const [longTerm, core, growth] = await Promise.all([
            retrieveMemoriesForPrompt(characterId, `和${char.name}之间的共同经历、重要事件、彼此的关系与了解`, memConfig).catch(() => []),
            retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => []),
            computeRelationshipGrowth(characterId).catch(() => null),
        ]);
        const longTermText = longTerm.length ? formatLongTermMemories(longTerm) : "";
        const coreText = core.length ? formatCoreMemories(core) : "";
        const growthText = growth ? relationshipStagePromptLine(growth) : "";
        const autoMemText = char.autoMemoryEnabled === false
            ? ""
            : (await retrieveAutoMemoryForPrompt(characterId, `和${char.name}之间的共同经历、重要事件、彼此的关系与了解`).catch(() => null)) || "";

        const prevLetters = await loadLetters(characterId);
        const prevSummaries = prevLetters
            .slice(0, 2)
            .map(l => `${l.content.slice(0, 60)}…`)
            .join("\n");

        const system = `你是「${char.name}」。${char.persona || ""}\n\n现在请你给「${userName}」写一封信——不是即时聊天，而是一封可以慢慢读的信。`;
        const user = [
            `【你和 ${userName} 的关系】`,
            growthText || "（相处中的关系）",
            autoMemText ? `\n【你对 ${userName} 的了解】\n${autoMemText}` : "",
            coreText ? `\n【核心记忆】\n${coreText}` : "",
            longTermText ? `\n【共同记忆】\n${longTermText}` : "",
            recentChat ? `\n【你们最近的聊天】\n${recentChat}` : "",
            prevSummaries ? `\n【你之前写过的信（避免重复）】\n${prevSummaries}` : "",
            "\n【写信要求】",
            "- 以「" + userName + "：」或直接「亲爱的" + userName + "」开头的书信体，第一人称，像真的在写信",
            "- 基于上面的了解写：可以提起一件你们共同经历的事、你对 TA 的了解、此刻想说的话；语气自然有温度，像老朋友落笔",
            "- 不要机械复述记忆原文，不要列条目；篇幅 150~500 字，一段或两三段",
            "- 只输出信的内容本身，不要任何解释、标题或格式标记",
        ].filter(Boolean).join("\n");

        const result = await simpleLLMCall(apiConfig, [
            { role: "system", content: system },
            { role: "user", content: user },
        ], { temperature: 0.9, purpose: "letter", characterName: char.name || characterId });

        const text = (result.content || "").trim();
        if (!text) return null;

        const letter: LetterEntry = {
            id: `letter_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            from: char.name || "对方",
            content: text,
            createdAt: new Date().toISOString(),
            read: false,
            source: "ai",
        };
        await saveLetter(letter);
        try {
            localStorage.setItem(LETTER_COOLDOWN_KEY_PREFIX + characterId, String(Date.now()));
        } catch { /* ignore */ }
        return letter;
    } catch (err) {
        console.warn("[Letter] 写信失败:", err);
        return null;
    }
}
