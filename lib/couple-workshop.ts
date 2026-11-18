/**
 * 情侣空间 · 改造执行器（小工坊 / 小卷 共用）
 *
 * 设计原则：
 * - 一份实现，两个入口。小工坊是「一个工具 + action 参数」，小卷是「一个套件 + 动作」，
 *   两边都只做参数适配，真正的读写全在这里，避免两套逻辑各自跑偏。
 * - 只改「绑定角色」的那一个空间：空间是专属的，改错人比不改更糟。传了别的角色会被拒绝。
 * - 只做「简单的改造」：心情/碎碎念/天气、小世界小物、壁纸、黑胶音源。
 *   不做结构变更（不加菜单、不换布局），那些是代码的事，不是数据的事。
 * - 内容写入前统一清洗（裸 markdown / 注释标记不外泄），长度有上限，宁短不长。
 * - 不调用任何大模型：改造本身零 token。
 */

import { loadCharacters } from "./character-storage";
import { readThemeProfile } from "./theme-storage";
import {
  cleanDisplayText,
  cleanFreeText,
  loadSpaceItems,
  loadSpaceStatus,
  loadSpaceWallpaper,
  saveSpaceStatus,
  setSpaceWallpaper,
  unlockItem,
  type SpaceItem,
  type SpaceStatus,
} from "./couple-space-store";

/** 单次可写的文本上限：空间卡片排版就那么大，写太长会挤 */
const MOOD_MAX = 30;
const THOUGHT_MAX = 60;
const WEATHER_MAX = 12;
const ITEM_LABEL_MAX = 20;
const ITEM_LIMIT = 12;

export type CoupleWorkshopResult = {
  ok: boolean;
  /** 给人/给模型看的一句话结论 */
  text: string;
};

/** 空间是否已启用、绑定的是谁 */
export type CoupleBinding = {
  enabled: boolean;
  characterId: string;
  characterName: string;
  reason?: string;
};

/** 解析当前绑定的角色（严格只认绑定角色，不接受随便指定别人） */
export function resolveCoupleBinding(): CoupleBinding {
  if (typeof window === "undefined") {
    return { enabled: false, characterId: "", characterName: "", reason: "当前环境没有本地数据" };
  }
  const profile = readThemeProfile();
  if (!profile.coupleEnabled) {
    return { enabled: false, characterId: "", characterName: "", reason: "情侣空间还没开启（桌面 → 主题 → 情侣空间打开，并绑定一个角色）" };
  }
  const characterId = profile.coupleCharacterId || "";
  if (!characterId) {
    return { enabled: false, characterId: "", characterName: "", reason: "情侣空间已开启但还没绑定角色" };
  }
  const character = loadCharacters().find((c) => c.id === characterId);
  if (!character) {
    return { enabled: false, characterId, characterName: "", reason: "绑定的角色已经不在了（可能被删除）" };
  }
  return { enabled: true, characterId, characterName: character.name || "TA" };
}

/** 空间是否可用（有绑定角色）：工具是否暴露给助手，就看这一条 */
export function isCoupleSpaceEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return resolveCoupleBinding().enabled;
  } catch {
    return false;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function clip(value: string, max: number): string {
  const text = cleanFreeText(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** 空间现状快照 → 一段紧凑文本（给助手看，也给人看） */
export function describeSpace(characterId: string, characterName: string): string {
  const status = loadSpaceStatus(characterId);
  const items = loadSpaceItems(characterId);
  const wallpaper = loadSpaceWallpaper();
  const lines: string[] = [];
  lines.push(`空间主人：${characterName}`);
  lines.push(`今日心情：${status.mood || "（还空着）"}`);
  lines.push(`碎碎念：${status.thought || "（还空着）"}`);
  lines.push(`天气：${status.weather || "（未设置，界面按常态显示）"}`);
  lines.push(`黑胶音源：${status.audio_src ? "已配置" : "（未配置，唱片是静态装饰）"}`);
  lines.push(items.length
    ? `小世界小物（${items.length}/${ITEM_LIMIT}）：${items.map((i) => `${i.icon}${i.label}`).join("、")}`
    : "小世界小物：（还空着）");
  lines.push(`壁纸：${wallpaper.current ? `已铺（assetId=${wallpaper.current}）` : "默认宣纸底"}`);
  lines.push(wallpaper.library.length
    ? `可选壁纸 assetId：${wallpaper.library.join("、")}`
    : "可选壁纸：壁纸库为空，需要用户先在空间里上传一张");
  return lines.join("\n");
}

function ensureReady(): CoupleWorkshopResult | null {
  const binding = resolveCoupleBinding();
  if (!binding.enabled) {
    return { ok: false, text: `没有可改造的空间：${binding.reason}。` };
  }
  return null;
}

/** 读：空间现状 */
export function readSpace(): CoupleWorkshopResult {
  const blocked = ensureReady();
  if (blocked) return blocked;
  const binding = resolveCoupleBinding();
  return { ok: true, text: describeSpace(binding.characterId, binding.characterName) };
}

/** 写：心情 / 碎碎念 / 天气（至少给一项） */
export function setSpaceMood(args: {
  mood?: unknown;
  thought?: unknown;
  weather?: unknown;
}): CoupleWorkshopResult {
  const blocked = ensureReady();
  if (blocked) return blocked;
  const binding = resolveCoupleBinding();

  const patch: Partial<SpaceStatus> = {};
  const applied: string[] = [];
  const mood = str(args.mood);
  const thought = str(args.thought);
  const weather = str(args.weather);
  if (mood) {
    patch.mood = clip(mood, MOOD_MAX);
    applied.push(`心情「${patch.mood}」`);
  }
  if (thought) {
    patch.thought = clip(thought, THOUGHT_MAX);
    applied.push(`碎碎念「${patch.thought}」`);
  }
  if (weather) {
    patch.weather = clip(weather, WEATHER_MAX);
    applied.push(`天气「${patch.weather}」`);
  }
  if (!applied.length) {
    return { ok: false, text: "没给内容。心情/碎碎念/天气至少写一项。" };
  }
  const next = saveSpaceStatus(binding.characterId, patch);
  const detail = [
    next.mood ? `心情：${next.mood}` : "",
    next.thought ? `碎碎念：${next.thought}` : "",
    next.weather ? `天气：${next.weather}` : "",
  ].filter(Boolean).join("；");
  return { ok: true, text: `已写进${binding.characterName}的空间，现在${applied.join("、")}。\n当前：${detail}` };
}

/** 写：往小世界添置小物（可一次多件） */
export function addSpaceItems(input: unknown): CoupleWorkshopResult {
  const blocked = ensureReady();
  if (blocked) return blocked;
  const binding = resolveCoupleBinding();

  const raw = Array.isArray(input) ? input : [input];
  const wanted = raw
    .map((entry) => {
      if (typeof entry === "string") return { icon: "✧", label: cleanDisplayText(entry).slice(0, ITEM_LABEL_MAX) };
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const label = cleanDisplayText(str(record.label) || str(record.name)).slice(0, ITEM_LABEL_MAX);
        const icon = cleanDisplayText(str(record.icon)).slice(0, 4) || "✧";
        return label ? { icon, label } : null;
      }
      return null;
    })
    .filter((x): x is { icon: string; label: string } => Boolean(x));

  if (!wanted.length) {
    return { ok: false, text: "没给东西。要告诉我添什么（名字，最好带一个 emoji 当图标）。" };
  }

  const before = loadSpaceItems(binding.characterId);
  if (before.length >= ITEM_LIMIT) {
    return {
      ok: false,
      text: `小世界已经放了 ${before.length} 件东西（上限 ${ITEM_LIMIT}），再加会挤。先让用户清掉几件旧的，或者这次就别添了。`,
    };
  }

  const added: SpaceItem[] = [];
  for (const item of wanted) {
    const next = unlockItem(binding.characterId, item.icon, item.label);
    const matched = next.find((x) => x.label === item.label && x.icon === item.icon);
    if (matched && !before.some((x) => x.id === matched.id)) added.push(matched);
    if (next.length >= ITEM_LIMIT) break;
  }

  const after = loadSpaceItems(binding.characterId);
  if (!added.length) {
    return { ok: true, text: `这些东西本来就在小世界里，没有重复添加。现在共 ${after.length} 件。` };
  }
  return {
    ok: true,
    text: `${binding.characterName}的空间里添了：${added.map((i) => `${i.icon}${i.label}`).join("、")}。现在共 ${after.length} 件。`,
  };
}

/** 写：换壁纸（只能用宿主壁纸库里已有的资产；default = 恢复默认宣纸底） */
export function applySpaceWallpaper(assetIdInput: unknown): CoupleWorkshopResult {
  const blocked = ensureReady();
  if (blocked) return blocked;
  const binding = resolveCoupleBinding();

  const assetId = str(assetIdInput);
  if (!assetId) {
    return { ok: false, text: "没给壁纸。要么给一个壁纸库里的 assetId，要么传 default 恢复默认宣纸底。" };
  }
  const result = setSpaceWallpaper(binding.characterId, assetId);
  if (!result.ok) {
    return { ok: false, text: result.error || "换壁纸失败。" };
  }
  return {
    ok: true,
    text: result.assetId
      ? `空间壁纸已换成 ${result.assetId}（壁纸来自宿主壁纸库，与桌面壁纸互不影响）。`
      : "空间已恢复默认宣纸底。",
  };
}

/** 写：黑胶唱片音源（问卷式：只接受 http(s) 或 data:audio，避免写入非法值） */
export function setSpaceAudio(urlInput: unknown): CoupleWorkshopResult {
  const blocked = ensureReady();
  if (blocked) return blocked;
  const binding = resolveCoupleBinding();

  const url = str(urlInput);
  if (!url) {
    return { ok: false, text: "没给音源地址。要么给一个 http(s) 音频直链，要么传 clear 清空（清空后唱片回到静态装饰）。" };
  }
  if (url === "clear") {
    saveSpaceStatus(binding.characterId, { audio_src: "" });
    return { ok: true, text: "黑胶的音源已清空，唱片回到静态装饰。" };
  }
  if (!/^https?:\/\//i.test(url) && !/^data:audio\//i.test(url)) {
    return { ok: false, text: "这个地址不能用：只接受 http(s) 直链或 data:audio 数据，且必须是浏览器能直接播放的音频文件。" };
  }
  saveSpaceStatus(binding.characterId, { audio_src: url });
  return { ok: true, text: "黑胶音源已写入，用户点唱片就能播放/暂停。" };
}

export type CoupleWorkshopAction = "read" | "mood" | "item" | "wallpaper" | "audio";

/** 统一入口：小工坊与小卷都走这里 */
export function runCoupleSpaceAction(
  action: string,
  args: Record<string, unknown>,
): CoupleWorkshopResult {
  switch (action) {
    case "read":
      return readSpace();
    case "mood":
      return setSpaceMood({ mood: args.mood, thought: args.thought, weather: args.weather });
    case "item":
      return addSpaceItems(args.items ?? args.item ?? args.label);
    case "wallpaper":
      return applySpaceWallpaper(args.assetId ?? args.asset_id ?? args.wallpaper);
    case "audio":
      return setSpaceAudio(args.url ?? args.audio_src);
    default:
      return {
        ok: false,
        text: `未知改造动作「${action}」。可用：read（看现状）、mood（心情/碎碎念/天气）、item（添小物）、wallpaper（换壁纸）、audio（黑胶音源）。`,
      };
  }
}
