/**
 * 情侣空间 · 空间入口菜单（唯一数据源）
 *
 * 为什么单独抽出来：
 * - 情侣空间 UI 要渲染它（components/couple-space.tsx）；
 * - 两个助手（小工坊 / 小卷）要知道「这个空间里有哪些真实入口」，否则会凭空编造不存在的地方；
 * - 两处各写一份必然漂移，所以这里只存「纯数据」，图标用 iconKey 表示，
 *   由 UI 侧映射成 lucide 组件，lib 侧不引入任何 React 依赖。
 *
 * 铁律：每一项 appId 必须能在 components/desktop-shell.tsx 的 renderAppBody() 里找到分支，
 * 或由情侣空间自己处理（letters → 私藏短笺浮层）。没有真实落点的入口一律不加。
 */

export type CoupleSpaceMenuIconKey =
  | "chat"
  | "profile"
  | "album"
  | "reading"
  | "diary"
  | "calendar"
  | "music"
  | "dwelling"
  | "letter"
  | "memory"
  | "workshop";

export type CoupleSpaceMenuEntry = {
  appId: string;
  title: string;
  en: string;
  iconKey: CoupleSpaceMenuIconKey;
  tone: string;
};

export type CoupleSpaceMenuGroup = {
  label: string;
  entries: CoupleSpaceMenuEntry[];
};

export const COUPLE_SPACE_MENU: CoupleSpaceMenuGroup[] = [
  {
    label: "小日子",
    entries: [
      { appId: "chat", title: "说说话", en: "CHAT", iconKey: "chat", tone: "warm" },
      { appId: "characters", title: "TA 的档案", en: "PROFILE", iconKey: "profile", tone: "rose" },
      { appId: "checkphone", title: "照片·查手机", en: "ALBUM", iconKey: "album", tone: "warm" },
    ],
  },
  {
    label: "一起做的事",
    entries: [
      { appId: "reading", title: "共读", en: "READING", iconKey: "reading", tone: "ink" },
      { appId: "diary", title: "手记", en: "DIARY", iconKey: "diary", tone: "rose" },
      { appId: "calendar", title: "日程", en: "CALENDAR", iconKey: "calendar", tone: "ink" },
      { appId: "music", title: "音乐", en: "MUSIC", iconKey: "music", tone: "warm" },
    ],
  },
  {
    label: "同住的世界",
    entries: [
      { appId: "dwelling", title: "栖所", en: "DWELLING", iconKey: "dwelling", tone: "ink" },
      { appId: "letters", title: "情书", en: "LETTERS", iconKey: "letter", tone: "rose" },
      { appId: "resources", title: "认知档案", en: "MEMORY", iconKey: "memory", tone: "warm" },
      { appId: "qa", title: "小工坊", en: "WORKSHOP", iconKey: "workshop", tone: "ink" },
    ],
  },
];

/** 给助手看的「空间里有什么」纯文本清单（一行一组，省 token） */
export function describeCoupleSpaceMenu(): string {
  return COUPLE_SPACE_MENU
    .map((g) => `${g.label}：${g.entries.map((e) => `${e.title}(${e.appId})`).join("、")}`)
    .join("；");
}
