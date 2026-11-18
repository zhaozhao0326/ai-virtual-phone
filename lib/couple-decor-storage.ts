/**
 * 情侣空间 · 小世界装饰解锁（v1.7.153）
 *
 * 灵魂机制：C 在对话中达成关键事件（吃到红薯、写了电影海报、纪念日……），
 * 小空间里就悄悄「添置」一枚手绘风装饰。用户感到空间在被 C 慢慢装修。
 *
 * 性能与隐私铁律：
 * - 纯本地正则关键词扫描，零 LLM、零 token、零网络；
 * - 存 kv-db（IndexedDB 同步层），按角色 id 隔离；
 * - 只在情侣空间打开时惰性扫描一次，不在后台常驻。
 */

import { kvGet, kvSet } from "./kv-db";
import { loadChatSessions, loadChatMessages } from "./chat-storage";

const DECOR_KEY = (characterId: string) => `couple_decor_v1_${characterId}`;

/** 一枚可被解锁的小世界装饰。icon 用 emoji 手绘感字符，零图片资源。 */
export type CoupleDecor = {
  id: string;
  icon: string;        // 手绘风符号
  title: string;       // 解锁后展示名
  hint: string;        // 未解锁的模糊提示
  keywords: string[];  // 命中任一即解锁
  accent: string;      // 暖金/墨青等点缀色
};

/** 装饰图鉴（南宁初冬 + 文人书卷气）。关键词保守，避免误解锁。 */
export const COUPLE_DECORS: CoupleDecor[] = [
  { id: "red_sweet_potato", icon: "🍠", title: "一起烤的红薯", hint: "某个冬夜的甜", keywords: ["烤红薯", "烤地瓜", "红薯", "地瓜"], accent: "#c98a4b" },
  { id: "movie_poster", icon: "🎬", title: "那张电影海报", hint: "一起写过的银幕", keywords: ["电影海报", "写了海报", "海报", "看电影", "电影票"], accent: "#b8605f" },
  { id: "anniversary", icon: "💗", title: "定情纪念日", hint: "被记住的日子", keywords: ["纪念日", "在一起", "定情", "周年", "相恋"], accent: "#d98f92" },
  { id: "chestnut", icon: "🌰", title: "糖炒栗子", hint: "街角的热气", keywords: ["糖炒栗子", "栗子", "炒栗"], accent: "#b5793e" },
  { id: "book", icon: "📖", title: "共读的那本书", hint: "书页间的批注", keywords: ["一起看书", "共读", "这本书", "读了", "书名"], accent: "#6f8a7a" },
  { id: "rain", icon: "🌧️", title: "那天的雨", hint: "同撑一把伞", keywords: ["下雨", "那天的雨", "雨天", "淋雨", "雨伞"], accent: "#7a9ba8" },
  { id: "coffee", icon: "☕", title: "窗台的热可可", hint: "初冬的一杯暖", keywords: ["热可可", "咖啡", "拿铁", "热饮"], accent: "#a5744b" },
  { id: "orange", icon: "🍊", title: "剥开的橘子", hint: "沙发上的果香", keywords: ["橘子", "砂糖橘", "桔子", "剥橘子"], accent: "#d69a4b" },
];

export type DecorState = {
  unlocked: string[];       // 已解锁的 decor id
  lastScanAt: string;       // 上次扫描时间
};

function emptyState(): DecorState {
  return { unlocked: [], lastScanAt: "" };
}

export function loadDecorState(characterId: string): DecorState {
  if (!characterId || typeof window === "undefined") return emptyState();
  try {
    const raw = kvGet(DECOR_KEY(characterId));
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<DecorState>;
    return {
      unlocked: Array.isArray(parsed.unlocked) ? parsed.unlocked.filter(x => typeof x === "string") : [],
      lastScanAt: typeof parsed.lastScanAt === "string" ? parsed.lastScanAt : "",
    };
  } catch {
    return emptyState();
  }
}

function saveDecorState(characterId: string, state: DecorState): void {
  try {
    kvSet(DECOR_KEY(characterId), JSON.stringify(state));
  } catch {
    // 存储不可用时静默降级：本次解锁只存在于内存中
  }
}

/**
 * 扫描该角色的单聊记录，把命中的关键词解锁为装饰。
 * 返回 { state, newlyUnlocked } —— newlyUnlocked 用于触发一次轻提示。
 */
export function scanAndUnlockDecor(characterId: string): { state: DecorState; newlyUnlocked: CoupleDecor[] } {
  const state = loadDecorState(characterId);
  if (!characterId || typeof window === "undefined") return { state, newlyUnlocked: [] };

  const unlockedSet = new Set(state.unlocked);
  const newlyUnlocked: CoupleDecor[] = [];

  try {
    const sessions = loadChatSessions().filter(s => !s.isGroup && s.contactId === characterId);
    // 只扫最近 400 条消息，够用且省内存
    const texts: string[] = [];
    for (const s of sessions) {
      const msgs = loadChatMessages(s.id, 400);
      for (const m of msgs) {
        if (m.role === "assistant" || m.role === "user") {
          if (m.content) texts.push(m.content);
        }
      }
    }
    const joined = texts.join("\n");

    for (const decor of COUPLE_DECORS) {
      if (unlockedSet.has(decor.id)) continue;
      const hit = decor.keywords.some(kw => joined.includes(kw));
      if (hit) {
        unlockedSet.add(decor.id);
        newlyUnlocked.push(decor);
      }
    }
  } catch {
    // 扫描失败不影响已有状态
  }

  state.unlocked = Array.from(unlockedSet);
  state.lastScanAt = new Date().toISOString();
  saveDecorState(characterId, state);
  return { state, newlyUnlocked };
}
