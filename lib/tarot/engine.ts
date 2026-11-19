// 迷恋塔罗 · 引擎层（TS 移植自 LegoPhone modules/milian-tarot/core.js，上游引擎 ISC 许可见 upstream/ 目录）
// 会话模型：洗牌 → 逐张选牌 → 全部翻开 → 解读 / 角色陪伴视角。
// 本层不含任何 UI 与 LLM 调用，纯函数 + localStorage 持久化，便于回归测试。

import { DECK, byId, type TarotCard } from "./upstream/tarot/cards.js";
import { SPREADS, autoSpread, type TarotSpread } from "./upstream/tarot/spreads.js";
import { canonicalDraw } from "./upstream/companion/result.js";

export { DECK, SPREADS, autoSpread };
export type { TarotCard, TarotSpread };

export const TAROT_VERSION = 1;
export const TAROT_MAX_RECORDS = 200;
export const TAROT_MAX_QUESTION = 1000;
export const TAROT_STORAGE_KEY = "ai_phone_tarot_sessions_v1";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

export function tarotUid(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return "tp_" + crypto.randomUUID().replaceAll("-", "");
    }
    return "tp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/** 均匀随机整数（拒绝采样，避免取模偏差） */
export function tarotRandomInt(max: number, source: (arr: Uint32Array) => void = arr => crypto.getRandomValues(arr)): number {
    if (!Number.isInteger(max) || max < 1 || max > 0x100000000) throw new Error("随机范围无效");
    const limit = Math.floor(0x100000000 / max) * max;
    const buffer = new Uint32Array(1);
    do { source(buffer); } while (buffer[0] >= limit);
    return buffer[0] % max;
}

export type TarotDraw = { cardId: string; reversed: boolean };

export type TarotReadingState = {
    status: "idle" | "running" | "succeeded" | "failed";
    text: string;
};

export type TarotSession = {
    id: string;
    characterId: string;
    createdAt: number;
    question: string;
    spreadId: string;
    deck: TarotDraw[];
    selected: number[];
    revealed: boolean;
    reading: TarotReadingState;
    companion: TarotReadingState;
};

/** 洗整副 78 张牌（可选正逆位），Fisher–Yates */
export function shuffleDeck(reversals = true, random: (max: number) => number = tarotRandomInt): TarotDraw[] {
    const cards = DECK.map(card => ({ cardId: card.id, reversed: reversals && random(2) === 1 }));
    for (let i = cards.length - 1; i > 0; i--) {
        const j = random(i + 1);
        [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
}

export function findSpread(spreadId: string): TarotSpread {
    const spread = SPREADS.find(s => s.id === spreadId);
    if (!spread) throw new Error("请选择有效牌阵");
    return spread;
}

export function createSession(characterId: string, question: string, spreadId: string, reversals = true): TarotSession {
    const trimmed = String(question || "").trim();
    if (!trimmed || trimmed.length > TAROT_MAX_QUESTION) throw new Error(`请写下问题，最多 ${TAROT_MAX_QUESTION} 字`);
    findSpread(spreadId);
    return {
        id: tarotUid(),
        characterId,
        createdAt: Date.now(),
        question: trimmed,
        spreadId,
        deck: shuffleDeck(reversals),
        selected: [],
        revealed: false,
        reading: { status: "idle", text: "" },
        companion: { status: "idle", text: "" },
    };
}

export function placedCards(session: TarotSession): Array<{ card: TarotCard; reversed: boolean; slot: { label: string; hint: string } }> {
    const spread = findSpread(session.spreadId);
    return session.selected.map((index, i) => ({
        card: byId[session.deck[index].cardId],
        reversed: session.deck[index].reversed,
        slot: spread.slots[i],
    }));
}

export function selectCard(session: TarotSession, index: number): TarotSession {
    const spread = findSpread(session.spreadId);
    if (session.revealed || session.selected.length >= spread.count) throw new Error("这组牌已抽齐");
    if (!Number.isInteger(index) || index < 0 || index >= 78 || session.selected.includes(index)) throw new Error("这张牌已经选过，请选另一张");
    return { ...session, selected: [...session.selected, index] };
}

/** 从未选中的牌里随机抽一张（无指定则均匀随机） */
export function drawRandomCard(session: TarotSession): TarotSession {
    const remaining: number[] = [];
    for (let i = 0; i < 78; i++) if (!session.selected.includes(i)) remaining.push(i);
    if (!remaining.length) throw new Error("这组牌已抽齐");
    const pick = remaining[tarotRandomInt(remaining.length)];
    return selectCard(session, pick);
}

export function revealCards(session: TarotSession): TarotSession {
    const placed = placedCards(session);
    // 用原引擎的核验合同校验整组牌（牌名/张数/位置），通过后才标记翻开
    canonicalDraw(
        {
            question: session.question,
            spread_id: session.spreadId,
            draws: placed.map((p, position) => ({ position, card_id: p.card.id, reversed: p.reversed })),
        },
        { deck: DECK, spreads: SPREADS },
    );
    return { ...session, revealed: true };
}

function requireValidSession(raw: unknown): void {
    if (!raw || typeof raw !== "object") throw new Error("记录格式无效");
}

export function normalizeSession(raw: unknown): TarotSession {
    requireValidSession(raw);
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !IDENTIFIER.test(r.id)) throw new Error("记录标识无效");
    if (typeof r.characterId !== "string" || r.characterId.length > 128) throw new Error("角色标识无效");
    const spread = findSpread(String(r.spreadId));
    if (!Array.isArray(r.deck) || r.deck.length !== 78) throw new Error("牌库不完整");
    const deck: TarotDraw[] = (r.deck as Array<Record<string, unknown>>).map(item => {
        if (!item || !byId[String(item.cardId)] || typeof item.reversed !== "boolean") throw new Error("存在未知牌名或无效正逆位");
        return { cardId: String(item.cardId), reversed: item.reversed };
    });
    if (new Set(deck.map(d => d.cardId)).size !== 78) throw new Error("牌库包含重复牌");
    if (!Array.isArray(r.selected) || r.selected.length > spread.count) throw new Error("抽牌数量错误");
    const selected = (r.selected as unknown[]).map(v => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 77) throw new Error("抽牌状态错误");
        return n;
    });
    if (new Set(selected).size !== selected.length || typeof r.revealed !== "boolean") throw new Error("抽牌状态错误");
    if (r.revealed && selected.length !== spread.count) throw new Error("尚未抽齐，不能揭示");
    const question = String(r.question || "");
    if (!question.trim() || question.length > TAROT_MAX_QUESTION) throw new Error("问题文字无效");
    const reading = normalizeReading(r.reading, r.revealed as boolean);
    const companion = normalizeReading(r.companion, r.revealed as boolean);
    return {
        id: r.id,
        characterId: r.characterId,
        createdAt: Number(r.createdAt) || Date.now(),
        question,
        spreadId: spread.id,
        deck,
        selected,
        revealed: r.revealed as boolean,
        reading,
        companion,
    };
}

function normalizeReading(value: unknown, revealed: boolean): TarotReadingState {
    const v = (value || {}) as Record<string, unknown>;
    const status = String(v.status || "idle");
    if (!["idle", "running", "succeeded", "failed"].includes(status)) throw new Error("解读状态错误");
    if (status !== "idle" && !revealed) throw new Error("未翻开的牌不能生成解读");
    const text = String(v.text || "");
    if (text.length > 32000) throw new Error("解读正文超长");
    return { status: status as TarotReadingState["status"], text };
}

// ── localStorage 持久化（按角色隔离） ──

type TarotStore = { [characterId: string]: TarotSession[] };

export function loadTarotSessions(characterId: string): TarotSession[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(TAROT_STORAGE_KEY);
        if (!raw) return [];
        const store = JSON.parse(raw) as TarotStore;
        const list = store[characterId] || [];
        // 逐条严格校验，坏记录直接丢弃不炸整表
        return list
            .map(s => { try { return normalizeSession(s); } catch { return null; } })
            .filter((s): s is TarotSession => Boolean(s))
            .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
        return [];
    }
}

export function saveTarotSession(characterId: string, session: TarotSession): void {
    if (typeof window === "undefined") return;
    const valid = normalizeSession(session);
    try {
        const raw = window.localStorage.getItem(TAROT_STORAGE_KEY);
        const store: TarotStore = raw ? JSON.parse(raw) : {};
        const list = (store[characterId] || []).filter(s => s.id !== valid.id);
        list.unshift(valid);
        if (list.length > TAROT_MAX_RECORDS) list.length = TAROT_MAX_RECORDS;
        store[characterId] = list;
        window.localStorage.setItem(TAROT_STORAGE_KEY, JSON.stringify(store));
    } catch { /* 存储失败不阻塞占卜流程 */ }
}

export function deleteTarotSession(characterId: string, sessionId: string): void {
    if (typeof window === "undefined") return;
    try {
        const raw = window.localStorage.getItem(TAROT_STORAGE_KEY);
        if (!raw) return;
        const store = JSON.parse(raw) as TarotStore;
        store[characterId] = (store[characterId] || []).filter(s => s.id !== sessionId);
        window.localStorage.setItem(TAROT_STORAGE_KEY, JSON.stringify(store));
    } catch { /* 忽略 */ }
}
