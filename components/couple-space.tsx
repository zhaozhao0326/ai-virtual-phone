"use client";
/**
 * 情侣空间 · 通用数据驱动主题（v1.7.154 技术返工版）
 *
 * 返工铁律：
 * 1) 绝不硬编码入口：侧滑菜单由 MENU_GROUPS 配置驱动，每一项都映射到宿主真实 app id，
 *    通过 onOpenApp(appId) 打开真实实例；未实现的入口一律不渲染（宁缺毋滥，无死链）。
 * 2) 角色实体完全解耦：头像/名字/签名/状态/标签全部从绑定的 Character 动态读取；
 *    coupleSince 有值才算关系天数，无则隐藏（选配隐藏）。
 * 3) 早报可写双向驱动：mood/thought/weather 存 localStorage 的 space_status 结构；
 *    角色对话隐藏标记静默写入（机制 A）+ 用户点卡片手动编辑（机制 B）；
 *    所有文本 cleanDisplayText 后再显示，杜绝裸 markdown / yaml / 代码块泄漏。
 * 4) 黑胶唱片绑定真实 HTML5 <audio>：旋转/唱臂严格跟随 play/pause/ended 生命周期；
 *    音源可配置（存 space_status.audio_src），无音源时是可点的配置入口而非死块。
 * 5) 小世界插槽通用化：unlock_items 数组数据驱动 + 空状态样式，unlockItem(icon,label)
 *    标准追加接口；旧 decor 关键词解锁结果迁移进来，零 token。
 *
 * 性能：零 WebGL/Three；纯 CSS3 + 低频 2D Canvas；静止/打字/隐藏页休眠；卸载全清理。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Heart,
  Home,
  Image as ImageIcon,
  MessageCircle,
  Settings2,
  Smile,
  Sparkles,
  Sun,
  Cloud,
  CloudRain,
  BookOpen,
  CalendarDays,
  Music2,
  Brain,
  PenLine,
  X,
  Compass,
  Play,
  Pause,
  Disc3,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Character } from "@/lib/character-types";
import type { ThemeProfile } from "@/lib/theme-types";
import {
  cleanDisplayText,
  defaultStatus,
  loadSpaceStatus,
  saveSpaceStatus,
  applyChatSpaceMarkers,
  loadSpaceItems,
  migrateDecorToItems,
  type SpaceStatus,
  type SpaceItem,
} from "@/lib/couple-space-store";
import {
  COUPLE_DECORS,
  scanAndUnlockDecor,
} from "@/lib/couple-decor-storage";
import { loadChatSessions, loadChatMessages } from "@/lib/chat-storage";

type CoupleSpaceProps = {
  profile: ThemeProfile;
  character: Character | null;
  onOpenChat: () => void;
  onOpenTheme: () => void;
  onOpenCharacter: () => void;
  onOpenApp: (id: string) => void;
};

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * 侧滑菜单配置：只列宿主 renderAppBody 中真实存在的 app id。
 * 每一项的 appId 必须是 openApp() 能打开的 id；无真实支撑的入口（醒来记录/屏幕时间/
 * 街角/小客厅/梗库/表情包等）已移除，绝不渲染死链。
 */
type MenuEntry = { appId: string; title: string; en: string; icon: LucideIcon; tone: string };
type MenuGroup = { label: string; entries: MenuEntry[] };

const MENU_GROUPS: MenuGroup[] = [
  {
    label: "小日子",
    entries: [
      { appId: "chat", title: "说说话", en: "CHAT", icon: MessageCircle, tone: "warm" },
      { appId: "characters", title: "TA 的档案", en: "PROFILE", icon: Smile, tone: "rose" },
      { appId: "checkphone", title: "照片·查手机", en: "ALBUM", icon: ImageIcon, tone: "warm" },
    ],
  },
  {
    label: "一起做的事",
    entries: [
      { appId: "reading", title: "共读", en: "READING", icon: BookOpen, tone: "ink" },
      { appId: "diary", title: "手记", en: "DIARY", icon: PenLine, tone: "rose" },
      { appId: "calendar", title: "日程", en: "CALENDAR", icon: CalendarDays, tone: "ink" },
      { appId: "music", title: "音乐", en: "MUSIC", icon: Music2, tone: "warm" },
    ],
  },
  {
    label: "同住的世界",
    entries: [
      { appId: "dwelling", title: "栖所", en: "DWELLING", icon: Home, tone: "ink" },
      { appId: "letters", title: "情书", en: "LETTERS", icon: Compass, tone: "rose" },
      { appId: "resources", title: "认知档案", en: "MEMORY", icon: Brain, tone: "warm" },
      { appId: "qa", title: "小酒吧", en: "TAVERN", icon: Sun, tone: "ink" },
    ],
  },
];

/** 关系天数：仅当 coupleSince 存在时计算；无起始日 → 返回 null → 顶栏隐藏，不硬编码兜底 */
function daysTogether(since: string | null): number | null {
  if (!since) return null;
  const start = new Date(since + "T00:00:00");
  if (isNaN(start.getTime())) return null;
  const diff = Math.floor((Date.now() - start.getTime()) / 86400000);
  return diff >= 0 ? diff : null;
}

/** 早报剪报：优先用空间状态里的真实文本，缺省给动态兜底（带角色名），全部清洗后再显示 */
function buildClips(status: SpaceStatus, name: string, persona: string | undefined): string[] {
  const fallbacks = [
    `和 ${name} 一起，把日子过成诗。`,
    "窗边的光，刚好落在你身上。",
    "把细碎的日常，都收进这本册子里。",
  ];
  const mood = cleanDisplayText(status.mood) || fallbacks[0];
  const thought = cleanDisplayText(status.thought) || fallbacks[1];
  // 第三格取人设里的一句（清洗后），没有则用兜底
  let third = fallbacks[2];
  const personaLine = (persona || "")
    .split(/[。！？\n；;]/)
    .map((s) => cleanDisplayText(s))
    .find((s) => s.length >= 6 && s.length <= 40);
  if (personaLine) third = personaLine;
  return [mood, thought, third];
}

/* ═══════════════════════════════════════════
   轻量 2D Canvas 粒子（静止 5s / 打字 / 隐藏页休眠，卸载全清理）
   ═══════════════════════════════════════════ */
type Dust = { x: number; y: number; r: number; vy: number; vx: number; a: number; gold: boolean };

function DustCanvas({ reduced }: { reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (reduced) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    let width = 0, height = 0, dpr = 1;
    let dusts: Dust[] = [];
    let raf = 0, running = false, lastActive = Date.now(), lastFrame = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = rect.width; height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(34, Math.max(12, Math.floor((width * height) / 9000)));
      dusts = Array.from({ length: count }, () => ({
        x: Math.random() * width, y: Math.random() * height,
        r: Math.random() * 1.6 + 0.5,
        vy: -(Math.random() * 0.14 + 0.04),
        vx: (Math.random() - 0.5) * 0.08,
        a: Math.random() * 0.32 + 0.08,
        gold: Math.random() > 0.55,
      }));
    };
    const draw = (t: number) => {
      if (!running) return;
      if (t - lastActive > 5000) { running = false; ctx.clearRect(0, 0, width, height); raf = 0; return; }
      if (t - lastFrame >= 42) {
        lastFrame = t;
        ctx.clearRect(0, 0, width, height);
        for (const p of dusts) {
          p.y += p.vy; p.x += p.vx;
          if (p.y < -4) { p.y = height + 4; p.x = Math.random() * width; }
          if (p.x < -4) p.x = width + 4;
          if (p.x > width + 4) p.x = -4;
          const twinkle = 0.75 + 0.25 * Math.sin(t / 900 + p.x);
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fillStyle = p.gold
            ? `rgba(201,160,90,${p.a * twinkle})`
            : `rgba(150,178,168,${p.a * 0.7 * twinkle})`;
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    const wake = () => {
      lastActive = Date.now();
      if (!running) { running = true; lastFrame = 0; raf = requestAnimationFrame(draw); }
    };
    const onType = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0; ctx.clearRect(0, 0, width, height); lastActive = Date.now();
    };
    resize(); wake();
    const onResize = () => { resize(); };
    const onVisibility = () => {
      if (document.hidden) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
      else wake();
    };
    window.addEventListener("resize", onResize);
    canvas.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", onType);
    window.addEventListener("input", onType, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", onType);
      window.removeEventListener("input", onType, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced]);
  return <canvas ref={canvasRef} className="cs-dust" aria-hidden />;
}

/** 天气：优先用空间状态里的文本（角色可写/用户可编辑），无则本地时段推算，零联网 */
function weatherLabel(statusWeather: string): { label: string; night: boolean } {
  const custom = cleanDisplayText(statusWeather);
  if (custom) return { label: custom, night: false };
  const hour = new Date().getHours();
  const night = hour < 6 || hour >= 19;
  return { label: night ? "夜色渐深" : hour < 11 ? "晨光正好" : hour < 17 ? "日光清亮" : "暮色四合", night };
}

/* ── 早报卡片编辑浮层（机制 B：用户手动编辑兜底） ── */
type EditField = "mood" | "thought" | "weather" | "audio_src";
function StatusEditor({
  initial,
  field,
  characterName,
  onSave,
  onClose,
}: {
  initial: SpaceStatus;
  field: EditField;
  characterName: string;
  onSave: (field: EditField, value: string) => void;
  onClose: () => void;
}) {
  const titles: Record<EditField, string> = {
    mood: "今日心情",
    thought: "碎碎念",
    weather: "窗外天气",
    audio_src: "唱片音源",
  };
  const hints: Record<EditField, string> = {
    mood: `写下此刻和 ${characterName} 的心情`,
    thought: "一句叮嘱、一段碎碎念",
    weather: "例：初冬微晴 18°，留空自动按时段显示",
    audio_src: "粘贴音频网址（http/https）或本地地址，留空则唱片为静态装饰",
  };
  const [value, setValue] = useState(() => {
    if (field === "mood") return initial.mood || defaultStatus(characterName).mood;
    if (field === "thought") return initial.thought || defaultStatus(characterName).thought;
    if (field === "weather") return initial.weather || "";
    return initial.audio_src || "";
  });
  return (
    <div className="cs-edit-mask" onClick={onClose}>
      <div className="cs-edit-card" onClick={(e) => e.stopPropagation()}>
        <div className="cs-edit-head">
          <span>{titles[field]}</span>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <textarea
          className="cs-edit-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={hints[field]}
          rows={field === "audio_src" ? 2 : 3}
          autoFocus
        />
        <div className="cs-edit-hint">{hints[field]}</div>
        <div className="cs-edit-actions">
          <button type="button" className="cs-edit-cancel" onClick={onClose}>取消</button>
          <button type="button" className="cs-edit-save" onClick={() => { onSave(field, value); onClose(); }}>保存</button>
        </div>
      </div>
    </div>
  );
}

export function CoupleSpace({
  profile,
  character,
  onOpenChat,
  onOpenTheme,
  onOpenCharacter,
  onOpenApp,
}: CoupleSpaceProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [entered, setEntered] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [newlyHint, setNewlyHint] = useState<string | null>(null);
  const [status, setStatus] = useState<SpaceStatus>(() => loadSpaceStatus(character?.id || ""));
  const [items, setItems] = useState<SpaceItem[]>(() => loadSpaceItems(character?.id || ""));
  const [editField, setEditField] = useState<EditField | null>(null);

  // 黑胶真实播放器
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioError, setAudioError] = useState(false);

  const characterId = character?.id || "";
  const name = character?.name || "那个 TA";
  const avatar = character?.avatar || null;
  const signature = cleanDisplayText(character?.signature || character?.status || "");
  const days = daysTogether(profile.coupleSince);
  const tags = (character?.tags || []).slice(0, 4);

  // 系统「减少动态效果」偏好
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  // 墨晕转场 + 时钟
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    const t = window.setInterval(() => setClock(new Date()), 30_000);
    return () => { cancelAnimationFrame(id); window.clearInterval(t); };
  }, []);

  // 进入空间：加载状态 + 隐藏标记捕获（A）+ 装饰扫描并迁移为通用插槽（零 token）
  useEffect(() => {
    if (!characterId) return;
    setStatus(loadSpaceStatus(characterId));
    setItems(loadSpaceItems(characterId));

    // 机制 A：扫描角色单聊回复里的隐藏装修标记，静默写入
    const { status: appliedStatus, applied } = applyChatSpaceMarkers(characterId, () => {
      const sessions = loadChatSessions().filter((s) => !s.isGroup && s.contactId === characterId);
      const out: Array<{ content: string; createdAt: string }> = [];
      for (const s of sessions) {
        for (const m of loadChatMessages(s.id, 300)) {
          if (m.role === "assistant" && m.content) out.push({ content: m.content, createdAt: m.createdAt });
        }
      }
      return out;
    });
    setStatus(appliedStatus);

    // 小世界：旧 decor 关键词解锁 → 通用插槽
    const { state, newlyUnlocked } = scanAndUnlockDecor(characterId);
    const decorDefs = COUPLE_DECORS.filter((d) => state.unlocked.includes(d.id)).map((d) => ({
      id: d.id, icon: d.icon, title: d.title, accent: d.accent,
    }));
    setItems(migrateDecorToItems(characterId, decorDefs));
    if (newlyUnlocked.length > 0) {
      setNewlyHint(`${name} 悄悄添置了「${newlyUnlocked[0].title}」`);
      const tm = window.setTimeout(() => setNewlyHint(null), 4200);
      return () => window.clearTimeout(tm);
    }
  }, [characterId, name]);

  // 音频生命周期：音源变化时 reload；监听 play/pause/ended 驱动真实状态
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => { setIsPlaying(true); setAudioError(false); };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onError = () => { setAudioError(true); setIsPlaying(false); };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.pause();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, []);

  const clips = useMemo(() => buildClips(status, name, character?.persona), [status, name, character?.persona]);
  const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
  const dateLabel = `${clock.getMonth() + 1}月${clock.getDate()}日 周${WEEKDAYS[clock.getDay()]}`;
  const wx = weatherLabel(status.weather);

  // 打开真实 app：所有菜单项统一由此映射到宿主 openApp
  const openAppById = useCallback((appId: string) => {
    setDrawerOpen(false);
    if (appId === "chat") onOpenChat();
    else if (appId === "characters") onOpenCharacter();
    else if (appId === "theme" || appId === "settings") onOpenTheme();
    else onOpenApp(appId);
  }, [onOpenChat, onOpenCharacter, onOpenTheme, onOpenApp]);

  // 手动保存（机制 B）
  const handleSaveField = useCallback((field: EditField, value: string) => {
    if (!characterId) return;
    const patch: Partial<SpaceStatus> = {};
    if (field === "audio_src") patch.audio_src = value;
    else patch[field] = value;
    setStatus(saveSpaceStatus(characterId, patch));
  }, [characterId]);

  // 黑胶点击：有音源 → 播放/暂停；无音源 → 打开配置浮层（入口可用，非死块）
  const handleRecordClick = useCallback(() => {
    const audio = audioRef.current;
    const src = cleanDisplayText(status.audio_src || "");
    if (!src || !audio) { setEditField("audio_src"); return; }
    if (isPlaying) audio.pause();
    else { setAudioError(false); void audio.play().catch(() => setAudioError(true)); }
  }, [status.audio_src, isPlaying]);

  return (
    <div className={`cs-root ${entered ? "cs-entered" : ""}`} data-drawer={drawerOpen ? "1" : "0"}>
      <div className="cs-ink-transition" aria-hidden />
      <div className="cs-paper" aria-hidden />
      <div className="cs-glow cs-glow-a" aria-hidden />
      <div className="cs-glow cs-glow-b" aria-hidden />
      <DustCanvas reduced={reduced} />

      {/* 隐蔽心跳入口：打开抽屉 */}
      <button className="cs-heartbeat" type="button" onClick={() => setDrawerOpen(true)} aria-label="打开专属空间">
        <Heart size={16} fill="currentColor" />
      </button>

      {/* 顶部：时间 / 日期 / 天气（状态文本动态） */}
      <div className="cs-top">
        <div className="cs-time">{hhmm}</div>
        <div className="cs-subline">
          <span className="cs-date">{dateLabel}</span>
          <span className="cs-dot">·</span>
          <span className="cs-weather">
            {wx.night ? <Cloud size={12} /> : <Sun size={12} />} {wx.label}
          </span>
        </div>
        <button className="cs-chip" type="button" onClick={() => setDrawerOpen(true)}>
          <Compass size={13} /> 窗边
        </button>
      </div>

      {/* 主卷轴 */}
      <div className="cs-scroll">
        <div className="cs-masthead">
          <div className="cs-masthead-zh">{name} 早报</div>
          <div className="cs-masthead-en">M O R N I N G &nbsp; P O S T</div>
          <div className="cs-masthead-rule" />
          <div className="cs-masthead-meta">
            {days !== null ? <span>和你一起的第 {days} 天</span> : <span>和你在一起的每一天</span>}
            <span>今日宜：想你</span>
          </div>
        </div>

        <div className="cs-columns">
          <div className="cs-col">
            <button className="cs-clip cs-clip-editable" type="button" onClick={() => setEditField("mood")}>
              <div className="cs-clip-title">【今日心情】<PenLine size={10} /></div>
              <p>{clips[0]}</p>
            </button>
            <button className="cs-clip cs-clip-editable" type="button" onClick={() => setEditField("thought")}>
              <div className="cs-clip-title">【碎碎念】<PenLine size={10} /></div>
              <p>{clips[1]}</p>
            </button>
            <div className="cs-clip cs-clip-torn"><p>{clips[2]}</p></div>
          </div>

          <div className="cs-col cs-col-center">
            <div className="cs-polaroid" onClick={onOpenCharacter} role="button" tabIndex={0}>
              <div className="cs-polaroid-photo">
                {avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatar} alt={name} />
                ) : (
                  <div className="cs-polaroid-ph"><Heart size={28} /></div>
                )}
              </div>
              <div className="cs-polaroid-cap">{name}</div>
            </div>
            {signature && <div className="cs-mini-note">{signature}</div>}
            <div className="cs-magnifier" aria-hidden><span /></div>
          </div>

          <div className="cs-col">
            <button className="cs-micro cs-micro-weather cs-micro-editable" type="button" onClick={() => setEditField("weather")}>
              {wx.night ? <CloudRain size={15} /> : <Sun size={15} />}
              <div>
                <div className="cs-micro-t">窗外</div>
                <div className="cs-micro-s">{wx.label}</div>
              </div>
            </button>
            {tags.length > 0 && (
              <div className="cs-tags">
                {tags.map((t, i) => <span key={i} className="cs-tag">{cleanDisplayText(t)}</span>)}
              </div>
            )}
          </div>
        </div>

        {/* 黑胶唱机：真实 <audio> 生命周期驱动 */}
        <audio ref={audioRef} src={status.audio_src || undefined} preload="none" />
        <div className="cs-record-zone">
          <div
            className={`cs-record ${isPlaying ? "cs-spin" : ""} ${status.audio_src ? "" : "cs-record-unset"}`}
            onClick={handleRecordClick}
            role="button"
            tabIndex={0}
            aria-label={status.audio_src ? (isPlaying ? "暂停" : "播放") : "配置唱片音源"}
          >
            <div className="cs-record-grooves" />
            <div className="cs-record-label"><Disc3 size={16} /></div>
            <div className="cs-record-hole" />
          </div>
          <div className={`cs-tonearm ${isPlaying ? "cs-tonearm-on" : ""}`} aria-hidden><span /></div>
          <div className="cs-record-caption">
            {audioError ? "音源不可用 · 点唱片重新设置"
              : !status.audio_src ? "点唱片设置一首歌"
              : isPlaying ? <><Pause size={10} /> 正在播放</>
              : <><Play size={10} /> 点唱片播放</>}
          </div>
        </div>

        {/* 小世界：unlocked_items 数据驱动 + 空状态；unlockItem 为标准追加接口（见 store） */}
        <div className="cs-world-section">
          <div className="cs-world-title"><Sparkles size={14} /> {name} 装扮的小世界</div>
          {items.length > 0 ? (
            <div className="cs-world-grid">
              {items.map((it) => (
                <div key={it.id} className="cs-decor cs-decor-on" title={it.label}>
                  <span className="cs-decor-icon" style={it.accent ? { color: it.accent } : undefined}>{it.icon}</span>
                  <span className="cs-decor-name">{it.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="cs-world-empty">
              <span className="cs-world-empty-icon">✧</span>
              还没有小物件。和 {name} 多聊聊，Ta 会悄悄往这里添置。
            </div>
          )}
        </div>

        <div className="cs-footnote">— 这个小世界，正被 {name} 慢慢装扮 —</div>
        <div className="cs-bottom-space" />
      </div>

      {newlyHint && <div className="cs-unlock-toast"><Sparkles size={14} /> {newlyHint}</div>}

      {/* 底部四 tab：全部映射真实动作，无空壳 */}
      <nav className="cs-nav" aria-label="专属空间导航">
        <button type="button" onClick={() => setDrawerOpen((v) => !v)} className={drawerOpen ? "cs-nav-active" : ""}>
          <Home size={19} /><span>手机</span>
        </button>
        <button type="button" onClick={onOpenChat}>
          <MessageCircle size={19} /><span>聊天</span>
        </button>
        <button type="button" onClick={() => openAppById("dwelling")}>
          <Sparkles size={19} /><span>栖所</span>
        </button>
        <button type="button" onClick={onOpenCharacter}>
          <Smile size={19} /><span>档案</span>
        </button>
      </nav>

      {/* 侧滑抽屉：数据驱动的菜单 */}
      {drawerOpen && (
        <div className="cs-drawer-mask" onClick={() => setDrawerOpen(false)}>
          <aside className="cs-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="cs-drawer-head">
              <button type="button" className="cs-drawer-close" onClick={() => setDrawerOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="cs-profile-card" onClick={onOpenCharacter} role="button" tabIndex={0}>
              <div className="cs-profile-avatar">
                {avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatar} alt={name} />
                ) : <Heart size={26} />}
              </div>
              <div className="cs-profile-info">
                <div className="cs-profile-name">{name}</div>
                {signature && <div className="cs-profile-mood">{signature}</div>}
                <div className="cs-profile-tags">
                  {days !== null && (
                    <span className="cs-pill cs-pill-heart"><Heart size={11} /> 在一起 {days} 天</span>
                  )}
                  {tags.slice(0, 2).map((t, i) => <span key={i} className="cs-pill">{cleanDisplayText(t)}</span>)}
                </div>
              </div>
            </div>

            {MENU_GROUPS.map((group) => (
              <div className="cs-menu-group" key={group.label}>
                <div className="cs-menu-group-label">{group.label}</div>
                <div className="cs-squares">
                  {group.entries.map((entry) => {
                    const Icon = entry.icon;
                    return (
                      <button type="button" key={entry.appId} className={`cs-sq cs-sq-${entry.tone}`} onClick={() => openAppById(entry.appId)}>
                        <Icon size={20} />
                        <span className="cs-sq-title">{entry.title}</span>
                        <span className="cs-sq-en">{entry.en}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="cs-settings">
              <div className="cs-settings-label">设置</div>
              <button type="button" onClick={onOpenTheme}>
                <Settings2 size={17} />
                <span className="cs-mi-text"><b>主题设置</b><small>THEME · 切回原生主题</small></span>
              </button>
              <button type="button" onClick={() => setEditField("audio_src")}>
                <Music2 size={17} />
                <span className="cs-mi-text"><b>唱片音源</b><small>{status.audio_src ? "已设置 · 点击更换" : "点此设置一首歌"}</small></span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {editField && (
        <StatusEditor
          initial={status}
          field={editField}
          characterName={name}
          onSave={handleSaveField}
          onClose={() => setEditField(null)}
        />
      )}
    </div>
  );
}

export default CoupleSpace;
