"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * 对戒叠放微交互（纯 SVG + CSS，零 WebGL / 零 Canvas / 零大模型调用）
 *
 * 形态：一枚深钢男戒 + 一枚铂金细钻女戒，互相扣住，斜斜压在拍立得右下角。
 * 几何（viewBox 14 13 68 35，紧贴两环实际外框，不留空白）：
 * - 男戒 A（后，宽厚）：cx38 cy30 rx22 ry12 rotate(-22°)，带宽 4.4
 * - 女戒 B（前，纤细）：cx60 cy30 rx20 ry11.5 rotate(+20°)，带宽 3.6
 * - 两环交点 (52.3,16.9) 与 (49.7,37.3)。默认 B 压 A；
 *   再用「B 自己的环带」做遮罩把 A 在上交点重绘回最上层
 *   → 上交叉 A 在上、下交叉 B 在上，成为真正互扣的一对，而不是两个圈叠着。
 *   遮罩用环带而非矩形：切边自然落在环带的遮挡轮廓上，不会出现直线硬切口。
 *   遮罩必须挂在不带 transform 的 <g> 上，否则遮罩坐标会跟着旋转。
 * - 所有渐变全不透明：遮罩处重绘自身时若带透明度会叠加变深，留下色块。
 * - 文案全部来自真实数据（角色名 / 在一起天数 / 心情 / 窗外 / 签名），不写死任何城市、人名。
 * - 无持续动画，只在按下时给一次微颤，平时零重绘、不发热。
 */

type Props = {
  /** 绑定的角色名（真实数据） */
  name: string;
  /** 在一起的天数，无 coupleSince 时为 null */
  days: number | null;
  /** 空间状态里的心情（可能为空） */
  mood?: string;
  /** 已经算好的窗外天气标签 */
  weather?: string;
  /** 角色签名 */
  signature?: string;
};

/** 从真实状态拼出信物小纸条，避免任何写死文案 */
function buildRingNotes({ name, days, mood, weather, signature }: Props): string[] {
  const who = name?.trim() || "TA";
  const notes: string[] = [];

  notes.push(`两个闭合的轨道，在唯一的交汇点共享余生。`);
  if (days !== null && days > 0) {
    notes.push(`今天是我们一起的第 ${days} 天，绕多远都还在这一圈里。`);
  } else {
    notes.push(`绕多远都还在这一圈里，回过头，还是你。`);
  }
  if (weather) notes.push(`窗外${weather}，戒指搁在照片角上，凉凉的。`);
  if (mood) notes.push(`“${mood}”——这是 ${who} 今天的心绪，留在这一对上。`);
  if (signature) notes.push(`${who}：${signature}`);

  notes.push(`一枚是你的，一枚是 ${who} 的，谁也摘不下来。`);
  return notes;
}

export function CoupleRingPair(props: Props) {
  const { name, days, mood, weather, signature } = props;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notes = useMemo(
    () => buildRingNotes({ name, days, mood, weather, signature }),
    [name, days, mood, weather, signature],
  );

  // 卸载时清定时器，避免组件没了还在 setState
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const handleClick = () => {
    const pool = notes;
    setNote(pool[Math.floor(Math.random() * pool.length)] || "");
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 3600);
  };

  return (
    <button
      type="button"
      className={`cs-ring${open ? " is-open" : ""}`}
      onClick={(e) => {
        // 对戒是独立交互，不触发拍立得「打开档案」
        e.stopPropagation();
        handleClick();
      }}
      aria-label={`你和 ${name} 的对戒`}
    >
      <svg className="cs-ring-svg" viewBox="14 13 68 35" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          {/* 男戒：深邃精钢 + 冷冽高光 */}
          <linearGradient id="cs-band-male" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#334155" />
            <stop offset="25%" stopColor="#94A3B8" />
            <stop offset="50%" stopColor="#F1F5F9" />
            <stop offset="75%" stopColor="#475569" />
            <stop offset="100%" stopColor="#1E293B" />
          </linearGradient>
          <linearGradient id="cs-band-male-inner" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#0F172A" />
            <stop offset="50%" stopColor="#334155" />
            <stop offset="100%" stopColor="#64748B" />
          </linearGradient>

          {/* 女戒：高亮铂金（整体压暗一档，避免落在米白相纸上发白糊掉） */}
          <linearGradient id="cs-band-female" x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="30%" stopColor="#E3EAF1" />
            <stop offset="60%" stopColor="#B8C4D1" />
            <stop offset="85%" stopColor="#8695A6" />
            <stop offset="100%" stopColor="#F2F6FA" />
          </linearGradient>

          {/* 落在纸面上的接触阴影 */}
          <radialGradient id="cs-ring-contact" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#000000" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>

          {/* 互扣遮罩：女戒自己的环带。男戒只在这条环带范围内被重绘到最上层 */}
          <mask id="cs-ring-pass-over" maskUnits="userSpaceOnUse" x="14" y="13" width="68" height="35">
            <ellipse
              cx="60" cy="30" rx="20" ry="11.5"
              transform="rotate(20 60 30)"
              fill="none" stroke="#ffffff" strokeWidth="3.6"
            />
          </mask>
        </defs>

        <ellipse cx="50" cy="42.5" rx="30" ry="5.2" fill="url(#cs-ring-contact)" />

        <g fill="none" strokeLinecap="round">
          {/* 男戒（左，宽厚，斜 -22°） */}
          <g transform="rotate(-22 38 30)">
            {/* 内壁暗环：做出环的厚度 */}
            <ellipse cx="38" cy="31" rx="22" ry="12" stroke="url(#cs-band-male-inner)" strokeWidth="4.4" />
            <ellipse cx="38" cy="30" rx="22" ry="12" stroke="url(#cs-band-male)" strokeWidth="4.4" />
            {/* 内缘亮边（贴在环带内沿，做出金属转折） */}
            <ellipse cx="38" cy="30" rx="19.9" ry="9.9" stroke="#FFFFFF" strokeOpacity="0.34" strokeWidth="0.55" />
          </g>

          {/* 女戒（右，纤细，斜 +20°，带碎钻） */}
          <g transform="rotate(20 60 30)">
            <ellipse cx="60" cy="31.2" rx="20" ry="11.5" stroke="#0F172A" strokeOpacity="0.5" strokeWidth="3.6" />
            <ellipse cx="60" cy="30" rx="20" ry="11.5" stroke="url(#cs-band-female)" strokeWidth="3.6" />
            {/* 内缘亮边 */}
            <ellipse cx="60" cy="30" rx="18.1" ry="10.1" stroke="#FFFFFF" strokeOpacity="0.42" strokeWidth="0.45" />

            {/* 三颗排钻：坐标按椭圆参数落在环带中线上 */}
            <circle cx="55.84" cy="18.75" r="0.8" fill="#FFFFFF" />
            <circle cx="64.16" cy="18.75" r="0.8" fill="#FFFFFF" />
            <circle cx="60" cy="18.5" r="1.15" fill="#FFFFFF" />
            {/* 中间那颗的十字星芒 */}
            <g stroke="#FFFFFF" strokeOpacity="0.9" strokeWidth="0.45">
              <path d="M 60 16.9 L 60 20.1" />
              <path d="M 58.4 18.5 L 61.6 18.5" />
            </g>
          </g>

          {/* 把男戒在上交点压回最上层：上交叉男戒在上、下交叉女戒在上 → 真互扣 */}
          <g mask="url(#cs-ring-pass-over)">
            <ellipse cx="38" cy="30" rx="22" ry="12" transform="rotate(-22 38 30)" stroke="url(#cs-band-male)" strokeWidth="4.4" />
          </g>
        </g>
      </svg>

      <span className={`cs-ring-toast${open ? " is-open" : ""}`} role="status">
        {note}
      </span>
    </button>
  );
}
