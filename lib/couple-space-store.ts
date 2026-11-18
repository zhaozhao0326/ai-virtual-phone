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

/** 从任意文本里解析隐藏装修标记。返回命中项与去掉标记后的干净文本。 */
export function parseSpaceMarkers(text: string): {
  mood?: string;
  thought?: string;
  weather?: string;
  cleanText: string;
  hasMarker: boolean;
} {
  if (!text) return { cleanText: "", hasMarker: false };
  let mood: string | undefined;
  let thought: string | undefined;
  let weather: string | undefined;
  const grab = (key: string): string | undefined => {
    // 宽松匹配：<!--SET_SPACE_MOOD:xxx--> / <!-- SET_SPACE_MOOD ： xxx -->
    const re = new RegExp(`<!--\\s*SET_SPACE_${key}\\s*[:：]\\s*([\\s\\S]*?)\\s*-->`, "i");
    const m = text.match(re);
    if (!m) return undefined;
    const cleaned = cleanDisplayText(m[1]);
    return cleaned || undefined;
  };
  mood = grab("MOOD");
  thought = grab("THOUGHT");
  weather = grab("WEATHER");
  return {
    mood,
    thought,
    weather,
    cleanText: cleanDisplayText(text),
    hasMarker: Boolean(mood || thought || weather),
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
      mood: typeof parsed.mood === "string" ? cleanDisplayText(parsed.mood) : "",
      thought: typeof parsed.thought === "string" ? cleanDisplayText(parsed.thought) : "",
      weather: typeof parsed.weather === "string" ? cleanDisplayText(parsed.weather) : "",
      audio_src: typeof parsed.audio_src === "string" ? parsed.audio_src : "",
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
      last_applied_marker_at: typeof parsed.last_applied_marker_at === "string" ? parsed.last_applied_marker_at : "",
    };
  } catch {
    return emptyStatus(characterId);
  }
}

/** 合并写入空间状态（只覆盖传入字段） */
export function saveSpaceStatus(characterId: string, patch: Partial<SpaceStatus>): SpaceStatus {
  const prev = loadSpaceStatus(characterId);
  const next: SpaceStatus = {
    ...prev,
    character_id: characterId,
    mood: patch.mood !== undefined ? cleanDisplayText(patch.mood) : prev.mood,
    thought: patch.thought !== undefined ? cleanDisplayText(patch.thought) : prev.thought,
    weather: patch.weather !== undefined ? cleanDisplayText(patch.weather) : prev.weather,
    audio_src: patch.audio_src !== undefined ? patch.audio_src : prev.audio_src,
    last_applied_marker_at: patch.last_applied_marker_at !== undefined
      ? patch.last_applied_marker_at : prev.last_applied_marker_at,
    updated_at: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(STATUS_KEY(characterId), JSON.stringify(next));
  } catch {
    // 存储不可用时静默降级，本次改动仍在返回对象里
  }
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
