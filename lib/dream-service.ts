// lib/dream-service.ts
// 角色的「内部生活」：深夜做梦 + 每日日记（借鉴 companion-emergence 的 off-conversation life）。
//
// - 梦（dream）：深夜（22:00-6:00）或用户离开超过 12h 时，角色基于最近的记忆、
//   此刻情绪、关系成长，生成一段"梦呓/梦"存入信箱（type: dream）
// - 日记（diary）：同上时机，生成"今天的心情"存入信箱（type: diary），每角色每天最多 1 条
// - 频率控制：每角色每天只检查一次（kv 记当日日期）；生成失败静默跳过，不打扰
// - 素材复用：长期记忆（情感分排序）+ 情绪状态 + 关系成长 + 认知档案（若开启）

import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveMemoriesForPrompt } from "./memory-service";
import { formatLongTermMemories } from "./memory-injector";
import { retrieveAutoMemoryForPrompt } from "./auto-memory-service";
import { computeRelationshipGrowth, relationshipStagePromptLine } from "./relationship-growth";
import { getCharacterEmotion, primaryEmotion, EMOTION_LABELS, energyLabel } from "./character-emotion";
import { loadAllLetters, saveLetter, type LetterEntry } from "./letter-storage";
import { kvGet, kvSet } from "./kv-db";

const CHECKED_KEY_PREFIX = "ai_phone_il_checked_";
const DREAM_SAMPLE = 6;      // 做梦取最近记忆条数
const DIARY_SAMPLE = 8;      // 日记取最近记忆条数

function todayKey(): string {
    return new Date().toDateString();
}

function lastActiveMs(characterId: string): number {
    try {
        const state = getCharacterEmotion(characterId);
        return state.lastUpdate || 0;
    } catch {
        return 0;
    }
}

/** 该角色今日是否已生成过 dream/diary（轻量读库）。 */
function hasTodayDreamOrDiary(entries: LetterEntry[], type: "dream" | "diary"): boolean {
    const today = todayKey();
    return entries.some(l => (l.type || "letter") === type && new Date(l.createdAt).toDateString() === today);
}

async function buildContext(characterId: string, characterName: string) {
    const userName = resolveUserIdentity(characterId, "chat")?.name || "用户";
    const memConfig = loadMemoryConfig();
    const memText = (await retrieveMemoriesForPrompt(characterId, `和${characterName}之间的共同经历、重要事件、彼此的关系与了解`, memConfig).catch(() => []));
    const longTermText = memText.length ? formatLongTermMemories(memText) : "";
    const growth = await computeRelationshipGrowth(characterId).catch(() => null);
    const growthText = growth ? relationshipStagePromptLine(growth) : "";
    const autoMemText = (await retrieveAutoMemoryForPrompt(characterId, `和${characterName}之间的共同经历、重要事件、彼此的关系与了解`).catch(() => null)) || "";
    return { userName, longTermText, growthText, autoMemText };
}

/** 生成一段梦呓。 */
async function generateDream(characterId: string, char: Character): Promise<LetterEntry | null> {
    const apiConfig = resolveCharacterApi(characterId);
    if (!apiConfig) return null;
    const { userName, longTermText, growthText, autoMemText } = await buildContext(characterId, char.name || characterId);
    const emotion = getCharacterEmotion(characterId);
    const primary = primaryEmotion(emotion);
    const moodLine = primary
        ? `你此刻的情绪：${EMOTION_LABELS[primary.dim]}（${primary.value >= 0.6 ? "明显" : "轻微"}）`
        : "你此刻情绪平静";
    const system = `你是「${char.name || characterId}」。${char.persona || ""}\n现在是深夜。你做了一个梦，醒来后迷迷糊糊地记录下了它。`;
    const user = [
        `【你和 ${userName} 的关系】${growthText || "（相处中的关系）"}`,
        `【你此刻的状态】${moodLine}，精力${energyLabel(emotion.energy)}`,
        autoMemText ? `\n【你对 ${userName} 的了解】\n${autoMemText}` : "",
        longTermText ? `\n【你们最近的共同记忆】\n${longTermText}` : "",
        "\n【要求】",
        "- 写一段 120~300 字的「梦境记录」：由上面这些记忆碎片自然编织成梦——可以变形、可以荒诞、可以有情绪",
        "- 用第一人称，语气像刚醒来迷迷糊糊记下的梦话，不必讲逻辑，但要有一丝真实的情感温度",
        "- 可以直接提到 ${userName}，也可以不提；梦里的事不必是真的发生过",
        "- 只输出梦境内容本身，不要标题、不要解释",
    ].filter(Boolean).join("\n");
    const result = await simpleLLMCall(apiConfig, [
        { role: "system", content: system },
        { role: "user", content: user },
    ], { temperature: 1.0 });
    const text = (result.content || "").trim();
    if (!text) return null;
    return {
        id: `dream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        from: char.name || characterId,
        content: text,
        createdAt: new Date().toISOString(),
        read: false,
        source: "dream",
        type: "dream",
    };
}

/** 生成一天的心情日记。 */
async function generateDiary(characterId: string, char: Character): Promise<LetterEntry | null> {
    const apiConfig = resolveCharacterApi(characterId);
    if (!apiConfig) return null;
    const { userName, longTermText, growthText, autoMemText } = await buildContext(characterId, char.name || characterId);
    const emotion = getCharacterEmotion(characterId);
    const primary = primaryEmotion(emotion);
    const moodLine = primary
        ? `你此刻的情绪：${EMOTION_LABELS[primary.dim]}（${primary.value >= 0.6 ? "明显" : "轻微"}）`
        : "你此刻情绪平静";
    const system = `你是「${char.name || characterId}」。${char.persona || ""}\n一天快要结束了，你打开日记本，写下今天的心情。`;
    const user = [
        `【你和 ${userName} 的关系】${growthText || "（相处中的关系）"}`,
        `【你此刻的状态】${moodLine}，精力${energyLabel(emotion.energy)}`,
        autoMemText ? `\n【你对 ${userName} 的了解】\n${autoMemText}` : "",
        longTermText ? `\n【最近的记忆】\n${longTermText}` : "",
        "\n【要求】",
        "- 写一段 80~200 字的日记：今天的心情、想对 ${userName} 说的话、或者只是随口记一笔",
        "- 像真正日记的口气，口语化、自然，不必写给谁看；可以只写心情不写具体事",
        "- 只输出日记内容本身，不要日期、标题、解释",
    ].filter(Boolean).join("\n");
    const result = await simpleLLMCall(apiConfig, [
        { role: "system", content: system },
        { role: "user", content: user },
    ], { temperature: 0.9 });
    const text = (result.content || "").trim();
    if (!text) return null;
    return {
        id: `diary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        from: char.name || characterId,
        content: text,
        createdAt: new Date().toISOString(),
        read: false,
        source: "diary",
        type: "diary",
    };
}

/**
 * 每个角色的"内部生活"检查（挂在 follow-up 轮询上，每角色每天一次机会）：
 * - 深夜（22:00-6:00）或用户离开角色超过 12h 才触发
 * - 触发时按需补生成今日梦呓与今日日记（无 API 或失败静默跳过）
 */
export async function maybeRunCharacterInternalLife(characterId: string): Promise<void> {
    if (typeof window === "undefined") return;
    const chars = loadCharacters();
    const char = chars.find(c => c.id === characterId);
    if (!char) return;
    // 角色级开关：缺省开启
    if (char.dreamEnabled === false) return;

    // 每角色每天只检查一次
    const today = todayKey();
    try {
        if (kvGet(CHECKED_KEY_PREFIX + characterId) === today) return;
        kvSet(CHECKED_KEY_PREFIX + characterId, today);
    } catch {
        return;
    }

    // 时机：深夜 或 用户离开久
    const hour = new Date().getHours();
    const isDeepNight = hour >= 22 || hour < 6;
    const lastActive = lastActiveMs(characterId);
    const absentHours = lastActive ? (Date.now() - lastActive) / 3600_000 : 24;
    if (!isDeepNight && absentHours < 12) return;

    const name = char.name || characterId;
    const entries = await loadAllLetters();
    const needDream = !hasTodayDreamOrDiary(entries, "dream");
    const needDiary = !hasTodayDreamOrDiary(entries, "diary");
    if (!needDream && !needDiary) return;

    // 串行生成，避免并发 LLM 调用
    if (needDream) {
        const dream = await generateDream(characterId, char);
        if (dream) await saveLetter(dream);
    }
    if (needDiary) {
        const diary = await generateDiary(characterId, char);
        if (diary) await saveLetter(diary);
    }
}

/** 解析角色主 API（与聊天同源）。 */
function resolveCharacterApi(characterId: string) {
    try {
        const bindings = loadBindingConfig();
        const activeSlot = resolveBinding(bindings, characterId, "chat");
        return activeSlot.apiConfigId
            ? loadApiConfigs().find(c => c.id === activeSlot.apiConfigId) ?? null
            : null;
    } catch {
        return null;
    }
}
