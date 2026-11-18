/**
 * 情侣空间 · 通用状态存储（技术返工版）
 *
 * 数据驱动铁律：
 * - 空间里所有「可写内容」统一落在 localStorage 的 space_status 结构，按角色 id 隔离；
 * - 任意绑定角色都能通过对话里的隐藏标记（SET_SPACE_MOOD / SET_SPACE_THOUGHT / SET_SPACE_WEATHER）
 *   静默装修这个空间；用户也能从早报卡片手动编辑（兜底）；
 * - 所有文本入库前清洗裸 markdown / yaml / 代码块标记，杜绝标记泄漏到界面。
 *
 * 零 token：解析与扫描全是本地正则，不调用任何大模型。
 */

import { normalizeThemeProfile } from "./theme-types";
import { readThemeProfile, writeThemeProfile } from "./theme-storage";

/** 规范约定的单角色空间状态结构 */
export type SpaceStatus = {
  character_id: string;
  mood: string;      // 今日心情
  thought: string;   // 碎碎念 / 叮嘱
  weather: string;   // 天气（动态推算或常态文本）
  audio_src?: string; // 黑胶唱片的通用音频源（URL / data URL），留空则唱片为静态装饰
  updated_at: string;
  /** 已应用的最新一条「隐藏标记消息」时间，避免重复写入反复刷新 updated_at */
  last_applied_marker_at?: string;
};

/** 通用交互道具插槽（数据驱动，unlockItem 追加） */
export type SpaceItem = {
  id: string;
  icon: string;
  label: string;
  accent?: string;
  unlockedAt: string;
};

const STATUS_KEY = (characterId: string) => `space_status_v1_${characterId}`;
const ITEMS_KEY = (characterId: string) => `couple_space_items_v1_${characterId}`;

/**
 * 空间内容变更广播。
 * 为什么需要：内容可能由「空间自己」写（用户手动编辑），也可能由外部写
 * （小工坊 / 小卷 的改造工具直接落库）。后者的写入发生在组件之外，
 * 组件不重读就看不到变化 —— 所以写操作统一广播一次，空间与桌面各自刷新。
 * 零 token、纯本地事件。
 */
export const COUPLE_SPACE_UPDATED_EVENT = "couple-space:updated";

function broadcastSpaceUpdated(characterId: string): void {
  if (typeof window === "undefined" || !characterId) return;
  try {
    window.dispatchEvent(new CustomEvent(COUPLE_SPACE_UPDATED_EVENT, { detail: { characterId } }));
  } catch {
    // 广播失败不影响已写入的数据
  }
}

function emptyStatus(characterId: string): SpaceStatus {
  return {
    character_id: characterId,
    mood: "",
    thought: "",
    weather: "",
    updated_at: "",
  };
}

/** 兜底默认文案：仅当对应字段为空时给空间一个体面的初始态，不写死任何角色名 */
export function defaultStatus(characterName: string): Pick<SpaceStatus, "mood" | "thought" | "weather"> {
  return {
    mood: `今天想和 ${characterName} 说说话。`,
    thought: "窗外的光落下来了，随手记一笔。",
    weather: "",
  };
}

/**
 * 清洗裸 markdown / yaml / 代码块标记。
 * 只做「去掉标记符号、保留人类可读文本」，不解释、不渲染，避免任何标记裸露。
 */
export function cleanDisplayText(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input);
  // 去掉 HTML 注释（含隐藏标记本身，防止 <!--...--> 裸露）
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // 去掉 fenced code block（保留里面的纯文本行）
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, "$1");
  s = s.replace(/~~~[a-zA-Z0-9_-]*\n?([\s\S]*?)~~~/g, "$1");
  // 去掉 yaml frontmatter 整块
  s = s.replace(/^\s*---\s*\n[\s\S]*?\n---\s*/m, "");
  // 残留的 yaml 文档分隔/结束标记（单独成行的 --- / ...），这是「裸露的 ...」的元凶
  s = s.replace(/^[ \t]*(?:-{3,}|\.{3,})[ \t]*$/gm, " ");
  // 残留的键值行：只删「典型设定行」，避免误伤正文。
  // ① 半角冒号（yaml 写法）：整行删
  s = s.replace(/^[ \t]*[\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_\- ·]{0,11}[ \t]*:[ \t]*\S.*$/gm, " ");
  // ② 全角冒号：必须「短键 + 短值 + 无句读无引号」，才认定为设定行（否则「备注：记得他怕冷。」这类正文会被吃掉）
  s = s.replace(/^[ \t]*[\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_\-·]{0,5}[ \t]*：[ \t]*[^。！？，、；：「」“”"'（）()\n]{1,18}[ \t]*$/gm, " ");
  // 列表项符号 / 花括号结构残渣
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  s = s.replace(/[{}[\]]/g, " ");
  s = s.replace(/\n/g, " ");
  // 行内 markdown 符号
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  // 裸 yaml 行 key: value —— 仅清除明显的键样式行，避免误伤正文
  s = s.replace(/(^|\s)[A-Za-z_][A-Za-z0-9_-]*\s*:\s*(?=\S)/g, "$1");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * 自由文本清洗（mood/thought/weather）：只去掉代码块、HTML 注释、加粗/行内码符号，
 * 不跑「裸 yaml 行」规则——那是给角色人设剪报用的，会误伤像「状态:开心」这样的正常句子。
 */
export function cleanFreeText(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, "$1");
  s = s.replace(/~~~[a-zA-Z0-9_-]*\n?([\s\S]*?)~~~/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\n/g, " ").replace(/[ \t]+/g, " ").trim();
  return s;
}

/** 从任意文本里解析隐藏装修标记。返回命中项与去掉标记后的干净文本。 */
export function parseSpaceMarkers(text: string): {
  mood?: string;
  thought?: string;
  weather?: string;
  /** 角色想往小世界添置的一件小物：icon|label */
  item?: { icon: string; label: string };
  cleanText: string;
  hasMarker: boolean;
} {
  if (!text) return { cleanText: "", hasMarker: false };
  let mood: string | undefined;
  let thought: string | undefined;
  let weather: string | undefined;
  let item: { icon: string; label: string } | undefined;
  const grab = (key: string): string | undefined => {
    // 宽松匹配：<!--SET_SPACE_MOOD:xxx--> / <!-- SET_SPACE_MOOD ： xxx -->
    const re = new RegExp(`<!--\\s*SET_SPACE_${key}\\s*[:：]\\s*([\\s\\S]*?)\\s*-->`, "i");
    const m = text.match(re);
    if (!m) return undefined;
    const cleaned = cleanFreeText(m[1]);
    return cleaned || undefined;
  };
  mood = grab("MOOD");
  thought = grab("THOUGHT");
  weather = grab("WEATHER");
  // 道具标记：<!--SET_SPACE_ITEM: 🍵|傍晚一起喝的茶-->，icon|label 用竖线分隔
  const itemRe = /<!--\s*SET_SPACE_ITEM\s*[:：]\s*([\s\S]*?)\s*-->/i;
  const itemMatch = text.match(itemRe);
  if (itemMatch) {
    const raw = cleanFreeText(itemMatch[1]);
    const sep = raw.indexOf("|");
    const icon = (sep > 0 ? raw.slice(0, sep) : "✧").trim().slice(0, 4);
    const label = (sep > 0 ? raw.slice(sep + 1) : raw).trim().slice(0, 24);
    if (label) item = { icon: icon || "✧", label };
  }
  return {
    mood,
    thought,
    weather,
    item,
    cleanText: cleanFreeText(text),
    hasMarker: Boolean(mood || thought || weather || item),
  };
}

export function loadSpaceStatus(characterId: string): SpaceStatus {
  if (!characterId || typeof window === "undefined") return emptyStatus(characterId);
  try {
    const raw = window.localStorage.getItem(STATUS_KEY(characterId));
    if (!raw) return emptyStatus(characterId);
    const parsed = JSON.parse(raw) as Partial<SpaceStatus>;
    return {
      character_id: characterId,
      mood: typeof parsed.mood === "string" ? cleanFreeText(parsed.mood) : "",
      thought: typeof parsed.thought === "string" ? cleanFreeText(parsed.thought) : "",
      weather: typeof parsed.weather === "string" ? cleanFreeText(parsed.weather) : "",
      audio_src: typeof parsed.audio_src === "string" ? parsed.audio_src : "",
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
      last_applied_marker_at: typeof parsed.last_applied_marker_at === "string" ? parsed.last_applied_marker_at : "",
    };
  } catch {
    return emptyStatus(characterId);
  }
}

/** 合并写入空间状态（只覆盖传入字段） */
export function saveSpaceStatus(characterId: string, patch: Partial<SpaceStatus>): SpaceStatus {  const prev = loadSpaceStatus(characterId);
  const next: SpaceStatus = {
    ...prev,
    character_id: characterId,
    mood: patch.mood !== undefined ? cleanFreeText(patch.mood) : prev.mood,
    thought: patch.thought !== undefined ? cleanFreeText(patch.thought) : prev.thought,
    weather: patch.weather !== undefined ? cleanFreeText(patch.weather) : prev.weather,
    audio_src: patch.audio_src !== undefined ? patch.audio_src : prev.audio_src,
    last_applied_marker_at: patch.last_applied_marker_at !== undefined
      ? patch.last_applied_marker_at : prev.last_applied_marker_at,
    updated_at: new Date().toISOString(),
  };
  // 无实际变化就不落库、不广播：避免「监听 → 重读 → 再写」形成空转循环
  const changed = next.mood !== prev.mood
    || next.thought !== prev.thought
    || next.weather !== prev.weather
    || next.audio_src !== prev.audio_src
    || next.last_applied_marker_at !== prev.last_applied_marker_at;
  if (!changed) return prev;
  try {
    window.localStorage.setItem(STATUS_KEY(characterId), JSON.stringify(next));
  } catch {
    // 存储不可用时静默降级，本次改动仍在返回对象里
  }
  broadcastSpaceUpdated(characterId);
  return next;
}

/**
 * 扫描该角色的聊天记录，应用角色回复里的隐藏装修标记（机制 A）。
 * - 只看单聊、只看 assistant / tool 之外的角色本人回复；
 * - 按时间倒序取最新一条含标记的消息，且比上次已应用时间更新才写入；
 * - 零 token、纯本地。
 */
export function applyChatSpaceMarkers(
  characterId: string,
  scan: () => Array<{ content: string; createdAt: string }>,
): { status: SpaceStatus; applied: boolean } {
  const current = loadSpaceStatus(characterId);
  let status = current;
  let applied = false;
  try {
    const messages = scan();
    const sorted = [...messages].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const lastAt = current.last_applied_marker_at || "";
    for (const msg of sorted) {
      if (!msg.content || (msg.createdAt || "") <= lastAt) continue;
      const parsed = parseSpaceMarkers(msg.content);
      if (!parsed.hasMarker) continue;
      const patch: Partial<SpaceStatus> = { last_applied_marker_at: msg.createdAt };
      if (parsed.mood) patch.mood = parsed.mood;
      if (parsed.thought) patch.thought = parsed.thought;
      if (parsed.weather) patch.weather = parsed.weather;
      status = saveSpaceStatus(characterId, patch);
      applied = true;
      break; // 只应用最新一条，避免旧消息回灌覆盖
    }
  } catch {
    // 扫描失败不影响当前状态
  }
  return { status, applied };
}

/**
 * 扫描该角色聊天里的「添置道具」隐藏标记，逐件解锁到小世界。
 * - 与心情的去重逻辑独立：每件道具都要过一遍 unlockItem（内部按 id 幂等去重，不会重复添加）；
 * - 零 token、纯本地；返回本次真正新解锁的道具，供 UI 弹提示。
 */
export function applyChatSpaceItems(
  characterId: string,
  scan: () => Array<{ content: string }>,
): SpaceItem[] {
  if (!characterId || typeof window === "undefined") return [];
  const before = loadSpaceItems(characterId);
  const beforeIds = new Set(before.map(i => i.id));
  try {
    for (const msg of scan()) {
      if (!msg.content || !msg.content.includes("SET_SPACE_ITEM")) continue;
      const parsed = parseSpaceMarkers(msg.content);
      if (parsed.item) {
        unlockItem(characterId, parsed.item.icon, parsed.item.label);
      }
    }
  } catch {
    // 扫描失败保持原样
  }
  const after = loadSpaceItems(characterId);
  return after.filter(i => !beforeIds.has(i.id));
}

/* ─────────────────────────────────────────────
   通用交互道具插槽（unlocked_items）
   - 默认空数组 + 空状态样式，不再有静态置灰死块；
   - unlockItem(icon, label) 为标准追加接口，供对话触发 / 系统任务通用调用。
   ───────────────────────────────────────────── */

export function loadSpaceItems(characterId: string): SpaceItem[] {
  if (!characterId || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ITEMS_KEY(characterId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is SpaceItem =>
      Boolean(x) && typeof x === "object" && typeof (x as SpaceItem).id === "string" && typeof (x as SpaceItem).label === "string"
    ).map((x) => ({
      id: x.id,
      icon: cleanDisplayText(x.icon) || "·",
      label: cleanDisplayText(x.label) || "小物",
      accent: typeof x.accent === "string" ? x.accent : undefined,
      unlockedAt: typeof x.unlockedAt === "string" ? x.unlockedAt : "",
    }));
  } catch {
    return [];
  }
}

function persistItems(characterId: string, items: SpaceItem[]): void {
  try {
    window.localStorage.setItem(ITEMS_KEY(characterId), JSON.stringify(items));
  } catch {
    // 静默降级
  }
  broadcastSpaceUpdated(characterId);
}

/** 标准追加接口：解锁一枚道具。重复 id 不重复追加，返回最新数组。 */
export function unlockItem(
  characterId: string,
  icon: string,
  label: string,
  opts?: { id?: string; accent?: string },
): SpaceItem[] {
  if (!characterId || typeof window === "undefined") return [];
  const items = loadSpaceItems(characterId);
  const id = opts?.id || `${icon}-${label}`;
  if (items.some((it) => it.id === id)) return items;
  const next = [...items, {
    id,
    icon: cleanDisplayText(icon) || "·",
    label: cleanDisplayText(label) || "小物",
    accent: opts?.accent,
    unlockedAt: new Date().toISOString(),
  }];
  persistItems(characterId, next);
  return next;
}

/** 把旧版 decor 解锁结果迁移为通用道具插槽（一次性，幂等） */
export function migrateDecorToItems(
  characterId: string,
  decors: Array<{ id: string; icon: string; title: string; accent?: string }>,
): SpaceItem[] {
  if (!characterId || typeof window === "undefined") return [];
  let items = loadSpaceItems(characterId);
  for (const d of decors) {
    if (items.some((it) => it.id === d.id)) continue;
    items = unlockItem(characterId, d.icon, d.title, { id: d.id, accent: d.accent });
  }
  return items;
}

/* ─────────────────────────────────────────────
   空间壁纸（复用宿主同一套壁纸资产库）
   - 只记 theme profile 里的 coupleWallpaperAssetId，与桌面壁纸互不干扰；
   - 壁纸资产本身由 theme-storage 管理，这里不新建任何存储机制。
   ───────────────────────────────────────────── */

/** 当前空间壁纸 / 可选壁纸库（供助手查看与选择） */
export function loadSpaceWallpaper(): { current: string | null; library: string[] } {
  if (typeof window === "undefined") return { current: null, library: [] };
  try {
    const profile = readThemeProfile();
    return {
      current: profile.coupleWallpaperAssetId || null,
      library: Array.isArray(profile.wallpaperLibrary) ? profile.wallpaperLibrary.filter(Boolean) : [],
    };
  } catch {
    return { current: null, library: [] };
  }
}

/**
 * 给空间换壁纸。
 * @param characterId 空间绑定角色（仅用于广播时定位刷新，壁纸本身是空间级设置）
 * @param assetId 宿主壁纸库里的资产 id；传 null / "" / "default" 表示恢复默认宣纸底。
 * @returns 是否成功 + 落地后的 assetId
 */
export function setSpaceWallpaper(
  characterId: string,
  assetId: string | null,
): { ok: boolean; assetId: string | null; error?: string } {
  if (typeof window === "undefined") return { ok: false, assetId: null, error: "当前环境不支持本地存储" };
  try {
    const profile = readThemeProfile();
    const normalizedId = !assetId || assetId === "default" ? null : assetId;
    if (normalizedId && !profile.wallpaperLibrary.includes(normalizedId)) {
      return {
        ok: false,
        assetId: profile.coupleWallpaperAssetId || null,
        error: `壁纸库里没有这张图（${normalizedId}）。只能用壁纸库里已有的 assetId，或让用户先在空间里上传一张。`,
      };
    }
    const next = writeThemeProfile(normalizeThemeProfile({
      ...profile,
      coupleWallpaperAssetId: normalizedId,
    }));
    broadcastSpaceUpdated(characterId);
    return { ok: true, assetId: next.coupleWallpaperAssetId || null };
  } catch (error) {
    return {
      ok: false,
      assetId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
