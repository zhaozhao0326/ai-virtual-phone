// lib/character-emotion.ts
// 角色持续情绪状态引擎（借鉴 companion-emergence 的情绪向量思路，落成小手机自己的轻量形态）。
//
// 核心：每个角色维护一个「情绪维度向量 + 精力值」的持续状态。
// - 情绪维度：开心/低落/生气/紧张/安心/孤独/思念/期待，各 0-1 强度
// - 状态随「时间」衰减漂移（向中性回归，不同维度衰减率不同）：
//   生气消得快（半衰 3h）、安心持久（半衰 24h）、开心中等（半衰 6h）
// - 对话事件小幅扰动：收到用户消息 → 开心+安心微升、精力消耗；一起听 → 开心+思念
// - 精力：聊天消耗、时间恢复；精力低时角色会显疲惫（prompt 提示 + UI 展示）
// - 状态持久化在 kv（每角色一档），读取时惰性衰减

import { kvGet, kvSet } from "./kv-db";

export const EMOTION_DIMS = [
    "happy",      // 开心
    "down",       // 低落
    "angry",      // 生气
    "tense",      // 紧张
    "calm",       // 安心
    "lonely",     // 孤独
    "miss",       // 思念
    "expect",     // 期待
] as const;
export type EmotionDim = (typeof EMOTION_DIMS)[number];

export const EMOTION_LABELS: Record<EmotionDim, string> = {
    happy: "开心",
    down: "低落",
    angry: "生气",
    tense: "紧张",
    calm: "安心",
    lonely: "孤独",
    miss: "思念",
    expect: "期待",
};

export const EMOTION_ICONS: Record<EmotionDim, string> = {
    happy: "😊",
    down: "😔",
    angry: "😤",
    tense: "😰",
    calm: "😌",
    lonely: "🥺",
    miss: "💭",
    expect: "✨",
};

export type CharacterEmotionState = {
    dims: Record<EmotionDim, number>;   // 0-1 强度
    energy: number;                      // 0-1 精力
    lastUpdate: number;                  // 上次状态更新时间戳
    lastNote?: string;                   // 最近一次情绪事件的说明（可选）
};

const KEY_PREFIX = "ai_phone_char_emotion_";
/** 各维度衰减半衰期（ms）。生气消得快、安心持久。 */
const HALF_LIFE: Record<EmotionDim, number> = {
    happy: 6 * 3600_000,
    down: 12 * 3600_000,
    angry: 3 * 3600_000,
    tense: 4 * 3600_000,
    calm: 24 * 3600_000,
    lonely: 10 * 3600_000,
    miss: 18 * 3600_000,
    expect: 8 * 3600_000,
};
const ENERGY_DECAY_PER_CHAT = 0.03;   // 每轮对话消耗精力
const ENERGY_RECOVER_PER_HOUR = 0.08; // 每小时恢复精力

function emptyDims(): Record<EmotionDim, number> {
    const dims = {} as Record<EmotionDim, number>;
    for (const d of EMOTION_DIMS) dims[d] = 0;
    return dims;
}

export function loadEmotionState(characterId: string): CharacterEmotionState | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(KEY_PREFIX + characterId);
        if (!raw) return null;
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== "object" || typeof parsed.dims !== "object") return null;
        const state = parsed as CharacterEmotionState;
        state.dims = { ...emptyDims(), ...state.dims };
        return state;
    } catch {
        return null;
    }
}

function saveEmotionState(characterId: string, state: CharacterEmotionState): void {
    if (typeof window === "undefined") return;
    try {
        kvSet(KEY_PREFIX + characterId, JSON.stringify(state));
    } catch {
        // ignore
    }
}

function decayDim(value: number, halfLife: number, elapsedMs: number): number {
    if (value <= 0 || elapsedMs <= 0) return value;
    return Math.max(0, value * Math.exp(-Math.LN2 * elapsedMs / halfLife));
}

/** 读取并触发惰性衰减（返回"当下"的状态；若从未有过状态则返回默认中性状态）。 */
export function getCharacterEmotion(characterId: string): CharacterEmotionState {
    const state = loadEmotionState(characterId);
    const now = Date.now();
    if (!state) {
        return { dims: emptyDims(), energy: 1, lastUpdate: now };
    }
    const elapsed = now - state.lastUpdate;
    if (elapsed > 0) {
        for (const d of EMOTION_DIMS) {
            state.dims[d] = decayDim(state.dims[d] || 0, HALF_LIFE[d], elapsed);
        }
        // 精力随时间恢复
        state.energy = Math.min(1, (state.energy || 1) + ENERGY_RECOVER_PER_HOUR * (elapsed / 3600_000));
        state.lastUpdate = now;
        saveEmotionState(characterId, state);
    }
    return state;
}

/** 应用一次情绪事件（对话/互动后调用）：按维度加量 + 可选记录。 */
export function applyEmotionEvent(
    characterId: string,
    deltas: Partial<Record<EmotionDim, number>>,
    options?: { energyDelta?: number; note?: string },
): void {
    const state = getCharacterEmotion(characterId);
    for (const d of EMOTION_DIMS) {
        const delta = deltas[d] ?? 0;
        if (delta !== 0) {
            state.dims[d] = Math.max(0, Math.min(1, (state.dims[d] || 0) + delta));
        }
    }
    if (options?.energyDelta) {
        state.energy = Math.max(0, Math.min(1, (state.energy || 1) + options.energyDelta));
    }
    state.lastUpdate = Date.now();
    if (options?.note) state.lastNote = options.note;
    saveEmotionState(characterId, state);
}

/** 一次聊天回复后的状态扰动：消耗精力 + 收到回应的安心/开心微升。 */
export function applyChatTurn(characterId: string): void {
    applyEmotionEvent(characterId, { calm: 0.03, happy: 0.02 }, { energyDelta: -ENERGY_DECAY_PER_CHAT });
}

/** 一起听：分享时刻 → 开心/思念微升。 */
export function applyListenTogether(characterId: string): void {
    applyEmotionEvent(characterId, { happy: 0.06, miss: 0.04 }, { note: "和 TA 一起听歌" });
}

/** 用户长时间没来 → 孤独/思念上升（供主动关心链路触发）。 */
export function applyUserAbsence(characterId: string, absentHours: number): void {
    if (absentHours < 6) return;
    const lonelyDelta = Math.min(0.3, absentHours / 200);
    const missDelta = Math.min(0.3, absentHours / 300);
    applyEmotionEvent(characterId, { lonely: lonelyDelta, miss: missDelta }, { note: `TA 离开 ${Math.round(absentHours)} 小时了` });
}

/** 当前最突出的情绪（强度最高且 > 0.25；没有则 null）。 */
export function primaryEmotion(state: CharacterEmotionState): { dim: EmotionDim; value: number } | null {
    let best: EmotionDim | null = null;
    let bestVal = 0;
    for (const d of EMOTION_DIMS) {
        const v = state.dims[d] || 0;
        if (v > bestVal) { bestVal = v; best = d; }
    }
    return best && bestVal > 0.25 ? { dim: best, value: bestVal } : null;
}

/** 精力档位描述。 */
export function energyLabel(energy: number): string {
    if (energy >= 0.85) return "精神饱满";
    if (energy >= 0.6) return "状态不错";
    if (energy >= 0.35) return "有点累了";
    return "很疲惫";
}

/** 生成注入给模型的「当前状态」段落；状态完全中性时返回 null（不注入）。 */
export function buildEmotionPromptLine(characterId: string): string | null {
    const state = getCharacterEmotion(characterId);
    const primary = primaryEmotion(state);
    if (!primary && state.energy >= 0.85) return null;
    const parts: string[] = [];
    if (primary) {
        const label = EMOTION_LABELS[primary.dim];
        const intensity = primary.value >= 0.6 ? "明显" : primary.value >= 0.4 ? "有些" : "一点";
        parts.push(`你此刻${intensity}${label}`);
    }
    if (state.energy < 0.85) {
        parts.push(`精力${energyLabel(state.energy)}`);
    }
    if (parts.length === 0) return null;
    return [
        `【你此刻的状态】${parts.join("，")}。`,
        "这是你当下自然的情绪与状态，请自然地带着它说话；但如果对话里发生了更重要的事，以当下情境为准。",
    ].join("\n");
}

/** 档案/聊天顶部展示用：短文本（如「😊 开心」）。 */
export function buildEmotionChipText(characterId: string): string | null {
    const state = getCharacterEmotion(characterId);
    const primary = primaryEmotion(state);
    if (!primary) return null;
    return `${EMOTION_ICONS[primary.dim]} ${EMOTION_LABELS[primary.dim]}`;
}
