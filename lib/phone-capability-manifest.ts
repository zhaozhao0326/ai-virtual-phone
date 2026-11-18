/**
 * 本机实况能力清单（两个助手共用）
 *
 * 为什么需要：
 * - 产品知识库讲的是「这个项目理论上有什么」，但用户跑的是自己部署的这份；
 * - 两个助手如果按上游宣传册说话，就会推荐根本不存在的功能、或去改没挂载的入口。
 *
 * 所以这里只回答一件事：**你现在这台小手机里，真实存在什么**。
 * 数据来源必须真实：
 * - App 清单 = components/desktop-shell.tsx 的 renderAppBody() 里真实有分支的 appId
 *   （注意：lib/desktop-config.ts 的 ICONS 里有、但 renderAppBody 没分支的，等于空壳，不算）。
 * - 空间入口 = lib/couple-space-menu.ts（UI 与助手同一份数据源，不会漂移）。
 * - 情侣空间是否开启 / 绑了谁 = 运行时真实读取 theme profile。
 *
 * 维护约定：上面的 appId 列表增删时，必须同步 renderAppBody 的分支。
 * 本文件只产出紧凑文本，不参与任何 UI 渲染。
 */

import { APP_VERSION } from "./changelog";
import { describeCoupleSpaceMenu } from "./couple-space-menu";
import { readThemeProfile } from "./theme-storage";

type MountedApp = { id: string; label: string };

/**
 * 当前部署里真实挂载的 App（与 renderAppBody 分支一一对应）。
 * 不含朋友圈/群聊——它们不是独立 App，而是在「聊天」里以会话/标签形式存在。
 */
const MOUNTED_APPS: MountedApp[] = [
  { id: "chat", label: "聊天" },
  { id: "characters", label: "角色" },
  { id: "theme", label: "主题" },
  { id: "settings", label: "设置" },
  { id: "letters", label: "信箱" },
  { id: "resources", label: "资源库" },
  { id: "resource_hub", label: "资源集市" },
  { id: "music", label: "音乐" },
  { id: "calendar", label: "日历" },
  { id: "realitybridge", label: "iOS 现实桥" },
  { id: "qa", label: "工坊" },
  { id: "diary", label: "手记" },
  { id: "xiaohongshu", label: "小红书" },
  { id: "story", label: "剧情" },
  { id: "vnmode", label: "漫卷" },
  { id: "reading", label: "阅读" },
  { id: "mapmode", label: "冒险" },
  { id: "dwelling", label: "栖所" },
  { id: "checkphone", label: "查手机" },
  { id: "shopping", label: "购物" },
  { id: "game", label: "游戏" },
  { id: "mixology", label: "独家特调" },
  { id: "appmarket", label: "应用市场" },
  { id: "interview_magazine", label: "在场" },
  { id: "cocreate", label: "共创" },
];

/** App 清单一行版：`聊天(chat)、角色(characters)、…` */
export function describeMountedApps(): string {
  return MOUNTED_APPS.map((app) => `${app.label}(${app.id})`).join("、");
}

/** 情侣空间当前的真实状态（开启了吗、绑了谁、绑定角色名） */
function describeCoupleSpaceState(): string {
  if (typeof window === "undefined") return "";
  try {
    const profile = readThemeProfile();
    if (!profile.coupleEnabled) return "情侣空间：未开启（桌面还是原生图标网格）。";
    if (!profile.coupleCharacterId) return "情侣空间：已开启，但还没绑定角色。";
    return `情侣空间：已开启，绑定角色 id=${profile.coupleCharacterId}。`;
  } catch {
    return "";
  }
}

/**
 * 注入两个助手 system prompt 的实况清单。
 * 刻意写得很短：它每轮都会随 system prompt 发一次，越长越费 token。
 */
export function buildPhoneCapabilityPrompt(): string {
  const lines: string[] = [];
  lines.push("===== 本机实况（用户自己部署的这份，以此为准） =====");
  lines.push(`版本 ${APP_VERSION}。真实挂载的 App：${describeMountedApps()}。`);
  lines.push("朋友圈、群聊不是独立 App，在「聊天」里以标签/会话形式存在。");
  lines.push("清单里没有的 App 一律不存在：不要推荐、不要声称能打开、也不要写代码去改它。");
  lines.push(`专属空间（桌面可被替换成手账风）里的真实入口 → ${describeCoupleSpaceMenu()}。`);
  const coupleState = describeCoupleSpaceState();
  if (coupleState) lines.push(coupleState);
  lines.push("助手边界：小卷负责创作与美化（角色卡/世界书/预设/正则/CSS/组件/图像素材/情侣空间）；工坊负责排障、改代码与内容、装 App、查仓库。两者都能改情侣空间，读写走同一套本地数据。");
  lines.push("数据都在浏览器本地（localStorage + IndexedDB）。说「已经改好」之前，必须有工具结果作证；没有工具结果就说没做。");
  return lines.join("\n");
}
