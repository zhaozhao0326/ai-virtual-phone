/**
 * 情侣空间 · 私藏短笺（love_letters）
 *
 * 铁律：
 * - 数据落在 localStorage 的单一数组 `love_letters`，每条按 character_id 归属，
 *   读取时只取当前绑定角色的那几张——独立空间只属于一个人。
 * - 内容由被绑定的角色在对话里亲自投递：回复中出现隐藏标记 <!--WRITE_LETTER: 文字-->
 *   时，本地扫描捕获后自动叠进信箱。零 LLM 额外调用、零 token。
 * - 只读展示：不提供编辑/已读未读，只有「合上」。避免任何退不出去的状态。
 * - 同一角色的同一句话不会重复入库（按文本指纹幂等），所以反复扫描是安全的。
 */

import { cleanFreeText } from "./couple-space-store";

/** 一张短笺 */
export type LoveLetter = {
  id: string;
  character_id: string;
  text: string;
  created_at: string;
};

const KEY = "love_letters";
/** 上限保护：只保留最近这么多张，避免 localStorage 无限膨胀 */
const MAX_PER_CHARACTER = 120;

/** 文本指纹（幂等用）：同角色同内容只入一次 */
function fingerprint(characterId: string, text: string): string {
  let h = 2166136261;
  const s = characterId + "\u0001" + text;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `ll-${(h >>> 0).toString(36)}`;
}

function safeParse(raw: string | null): LoveLetter[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is LoveLetter =>
        Boolean(x) && typeof x === "object"
        && typeof (x as LoveLetter).id === "string"
        && typeof (x as LoveLetter).character_id === "string"
        && typeof (x as LoveLetter).text === "string"
      )
      .map((x) => ({
        id: x.id,
        character_id: x.character_id,
        text: x.text,
        created_at: typeof x.created_at === "string" ? x.created_at : "",
      }));
  } catch {
    return [];
  }
}

/** 读全部短笺（所有角色） */
export function loadLoveLetters(): LoveLetter[] {
  if (typeof window === "undefined") return [];
  try {
    return safeParse(window.localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

function persist(all: LoveLetter[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存储不可用时静默降级
  }
}

/** 只取某个角色的短笺，新的在前 */
export function loadLoveLettersFor(characterId: string): LoveLetter[] {
  if (!characterId) return [];
  return loadLoveLetters()
    .filter((l) => l.character_id === characterId && l.text.trim())
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
}

/**
 * 追加一张短笺（幂等）。
 * @returns 真正新增时返回该条，已存在或空内容返回 null。
 */
export function appendLoveLetter(characterId: string, rawText: string): LoveLetter | null {
  if (!characterId || typeof window === "undefined") return null;
  const text = cleanFreeText(rawText).slice(0, 280);
  if (!text) return null;

  const all = loadLoveLetters();
  const id = fingerprint(characterId, text);
  if (all.some((l) => l.id === id)) return null;

  const entry: LoveLetter = {
    id,
    character_id: characterId,
    text,
    created_at: new Date().toISOString(),
  };

  // 同角色只保留最近 MAX_PER_CHARACTER 张，其他角色原样保留
  const mine = [entry, ...all.filter((l) => l.character_id === characterId)]
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    .slice(0, MAX_PER_CHARACTER);
  const others = all.filter((l) => l.character_id !== characterId);
  persist([...mine, ...others]);
  return entry;
}

/** 从一段文本里解析所有 <!--WRITE_LETTER: 文字--> 标记（一条回复可写多张） */
export function parseWriteLetterMarkers(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /<!--\s*WRITE_LETTER\s*[:：]\s*([\s\S]*?)\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cleaned = cleanFreeText(m[1]).slice(0, 280);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/**
 * 扫描该角色的聊天记录，把 WRITE_LETTER 标记投递的短笺写进信箱。
 * - 只看绑定角色的单聊（由调用方传入扫描源）；
 * - 幂等：重复扫描不会重复入库；
 * - 零 token、纯本地。
 * @returns 本次真正新增的短笺
 */
export function applyChatLoveLetters(
  characterId: string,
  scan: () => Array<{ content: string }>,
): LoveLetter[] {
  if (!characterId || typeof window === "undefined") return [];
  const added: LoveLetter[] = [];
  try {
    for (const msg of scan()) {
      if (!msg.content || !msg.content.includes("WRITE_LETTER")) continue;
      for (const text of parseWriteLetterMarkers(msg.content)) {
        const entry = appendLoveLetter(characterId, text);
        if (entry) added.push(entry);
      }
    }
  } catch {
    // 扫描失败保持原样
  }
  return added;
}
