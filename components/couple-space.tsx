"use client";
/**
 * 情侣空间 · 独立专属空间（v1.7.153 重构版）
 *
 * 设计：清冷书卷气（墨青/冷灰底） + 南宁初冬窗台的琥珀暖金微光。
 * 性能铁律：零 WebGL / Three；纯 CSS3 硬件加速 + 低频 2D Canvas 粒子；
 * 静止 5 秒或打字输入自动休眠降帧；组件卸载彻底清理监听与 rAF，杜绝内存泄漏。
 * 零 token：所有文案取角色真实数据，装饰解锁用本地关键词扫描（见 couple-decor-storage）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
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
  Clock3,
  X,
  GlassWater,
  Compass,
  BookOpen,
} from "lucide-react";
import type { Character } from "@/lib/character-types";
import type { ThemeProfile } from "@/lib/theme-types";
import {
  COUPLE_DECORS,
  scanAndUnlockDecor,
  type CoupleDecor,
  type DecorState,
} from "@/lib/couple-decor-storage";

type CoupleSpaceProps = {
  profile: ThemeProfile;
  character: Character | null;
  onOpenChat: () => void;
  onOpenTheme: () => void;
  onOpenCharacter: () => void;
  onOpenApp: (id: string) => void;
};

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function daysTogether(since: string | null, createdAt?: string): number {
  const raw = since || (createdAt ? createdAt.slice(0, 10) : null);
  if (!raw) return 0;
  const start = new Date(raw + "T00:00:00");
  if (isNaN(start.getTime())) return 0;
  const now = new Date();
  const diff = Math.floor((now.getTime() - start.getTime()) / 86400000);
  return diff >= 0 ? diff : 0;
}

function personaClips(persona: string | undefined, name: string): string[] {
  const fallback = [
    `和 ${name} 一起，把日子过成诗。`,
    "初冬了，记得添衣，记得好好吃饭。",
    "窗边的光，刚好落在你身上。",
    "把细碎的日常，都收进这本册子里。",
  ];
  if (!persona || !persona.trim()) return fallback;
  const parts = persona
    .split(/[。！？\n；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && s.length <= 40);
  const picked = parts.slice(0, 4);
  while (picked.length < 4) picked.push(fallback[picked.length % fallback.length]);
  return picked;
}

/* ═══════════════════════════════════════════
   轻量 2D Canvas 粒子：墨韵水汽 / 光斑微尘
   - 静止 5 秒 → 停帧休眠；打字输入 → 立即休眠；恢复活动 → 唤醒
   - 卸载 → cancelAnimationFrame + removeEventListener，零泄漏
   ═══════════════════════════════════════════ */
type Dust = { x: number; y: number; r: number; vy: number; vx: number; a: number; gold: boolean };

function DustCanvas({ reduced }: { reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (reduced) return; // 尊重系统「减少动态效果」
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let dusts: Dust[] = [];
    let raf = 0;
    let running = false;
    let lastActive = Date.now();
    let lastFrame = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 粒子数量按面积给上限，低配端也压得住
      const count = Math.min(34, Math.max(12, Math.floor((width * height) / 9000)));
      dusts = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.6 + 0.5,
        vy: -(Math.random() * 0.14 + 0.04),
        vx: (Math.random() - 0.5) * 0.08,
        a: Math.random() * 0.32 + 0.08,
        gold: Math.random() > 0.55,
      }));
    };

    const draw = (t: number) => {
      if (!running) return;
      // 静止超过 5 秒 → 休眠
      if (t - lastActive > 5000) {
        running = false;
        ctx.clearRect(0, 0, width, height);
        raf = 0;
        return;
      }
      // 限帧 ~24fps，降低 GPU/CPU 负担
      if (t - lastFrame >= 42) {
        lastFrame = t;
        ctx.clearRect(0, 0, width, height);
        for (const p of dusts) {
          p.y += p.vy;
          p.x += p.vx;
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
      if (!running) {
        running = true;
        lastFrame = 0;
        raf = requestAnimationFrame(draw);
      }
    };

    const onType = () => {
      // 打字输入 → 立即休眠降帧（停掉粒子，避免干扰输入）
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ctx.clearRect(0, 0, width, height);
      lastActive = Date.now();
    };

    resize();
    wake();
    const onResize = () => { resize(); };
    window.addEventListener("resize", onResize);
    const canvasEl = canvas;
    canvasEl.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", onType);
    window.addEventListener("input", onType, true);
    document.addEventListener("visibilitychange", onVisibility);
    function onVisibility() {
      if (document.hidden) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
      else wake();
    }

    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvasEl.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", onType);
      window.removeEventListener("input", onType, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced]);

  return <canvas ref={canvasRef} className="cs-dust" aria-hidden />;
}

/** 实时天气映射层（轻量：用本地时间推算昼夜，不联网、零 token） */
function WeatherLayer() {
  const hour = new Date().getHours();
  const night = hour < 6 || hour >= 19;
  const label = night ? "夜·微凉" : hour < 11 ? "晨光" : hour < 17 ? "晴好" : "暮色";
  const Icon = night ? Sun : hour > 15 ? Cloud : Sun;
  return (
    <div className="cs-micro cs-micro-weather">
      <Icon size={15} />
      <div>
        <div className="cs-micro-t">窗外</div>
        <div className="cs-micro-s">{label} · 初冬</div>
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
  const [playing, setPlaying] = useState(false);
  const [entered, setEntered] = useState(false);
  const [decorState, setDecorState] = useState<DecorState>({ unlocked: [], lastScanAt: "" });
  const [newlyHint, setNewlyHint] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);

  // 系统「减少动态效果」偏好
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  // 墨晕扩散转场：挂载后下一帧置 entered，触发 CSS 渐入
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // 时钟低频更新（30s）
  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // 进入空间时惰性扫描一次聊天，解锁被 C「悄悄添置」的装饰（纯本地零 token）
  useEffect(() => {
    if (!character?.id) return;
    const { state, newlyUnlocked } = scanAndUnlockDecor(character.id);
    setDecorState(state);
    if (newlyUnlocked.length > 0) {
      setNewlyHint(`${character.name} 悄悄添置了「${newlyUnlocked[0].title}」`);
      const t = window.setTimeout(() => setNewlyHint(null), 4200);
      return () => window.clearTimeout(t);
    }
  }, [character?.id, character?.name]);

  const name = character?.name || "那个 TA";
  const avatar = character?.avatar || null;
  const days = daysTogether(profile.coupleSince, character?.createdAt);
  const clips = useMemo(() => personaClips(character?.persona, name), [character?.persona, name]);
  const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
  const dateLabel = `${clock.getMonth() + 1}月${clock.getDate()}日 周${WEEKDAYS[clock.getDay()]}`;
  const tags = (character?.tags || []).slice(0, 4);
  const unlockedSet = useMemo(() => new Set(decorState.unlocked), [decorState.unlocked]);
  const unlockedDecors: CoupleDecor[] = COUPLE_DECORS.filter(d => unlockedSet.has(d.id));

  const openItem = useCallback((id: string) => {
    setDrawerOpen(false);
    if (id === "chat") onOpenChat();
    else if (id === "theme" || id === "settings") onOpenTheme();
    else if (id === "character" || id === "album") onOpenCharacter();
    else onOpenApp(id);
  }, [onOpenChat, onOpenTheme, onOpenCharacter, onOpenApp]);

  return (
    <div className={`cs-root ${entered ? "cs-entered" : ""}`} data-drawer={drawerOpen ? "1" : "0"}>
      {/* 墨晕转场遮罩（纯 CSS transform/opacity） */}
      <div className="cs-ink-transition" aria-hidden />

      {/* 清冷底色 + 琥珀暖光斑 */}
      <div className="cs-paper" aria-hidden />
      <div className="cs-glow cs-glow-a" aria-hidden />
      <div className="cs-glow cs-glow-b" aria-hidden />
      <DustCanvas reduced={reduced} />

      {/* 心跳印记开关（隐蔽入口：点它打开抽屉，抽屉底部可切回主题） */}
      <button
        className="cs-heartbeat"
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="打开专属空间"
      >
        <Heart size={16} fill="currentColor" />
      </button>

      {/* ── 顶部：时间 / 日期 / 窗边 ── */}
      <div className="cs-top">
        <div className="cs-time">{hhmm}</div>
        <div className="cs-subline">
          <span className="cs-date">{dateLabel}</span>
          <span className="cs-dot">·</span>
          <span className="cs-weather"><Sun size={12} /> 初冬 18°</span>
        </div>
        <button className="cs-chip" type="button" onClick={() => setDrawerOpen(true)}>
          <Compass size={13} /> 窗边
        </button>
      </div>

      {/* ── 主卷轴 ── */}
      <div className="cs-scroll">
        <div className="cs-masthead">
          <div className="cs-masthead-zh">islet 早报</div>
          <div className="cs-masthead-en">I S L E T &nbsp; M O R N I N G &nbsp; P O S T</div>
          <div className="cs-masthead-rule" />
          <div className="cs-masthead-meta">
            <span>和你一起的第 {days} 天</span>
            <span>今日宜：想你</span>
          </div>
        </div>

        <div className="cs-columns">
          <div className="cs-col">
            <div className="cs-clip">
              <div className="cs-clip-title">【今日心情】</div>
              <p>{clips[0]}</p>
            </div>
            <div className="cs-clip">
              <div className="cs-clip-title">【碎碎念】</div>
              <p>{clips[1]}</p>
            </div>
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
            <div className="cs-mini-note">to {name} ♡</div>
            <div className="cs-magnifier" aria-hidden><span /></div>
          </div>

          <div className="cs-col">
            <WeatherLayer />
            <div className="cs-clip">
              <div className="cs-clip-title">【一句话】</div>
              <p>{clips[3]}</p>
            </div>
            {tags.length > 0 && (
              <div className="cs-tags">
                {tags.map((t, i) => <span key={i} className="cs-tag">{t}</span>)}
              </div>
            )}
          </div>
        </div>

        {/* ── 黑胶唱机（CSS 旋转，无 WebGL） ── */}
        <div className="cs-record-zone">
          <div className={`cs-record ${playing ? "cs-spin" : ""}`} onClick={() => setPlaying((p) => !p)} role="button" tabIndex={0}>
            <div className="cs-record-grooves" />
            <div className="cs-record-label"><span>私藏</span></div>
            <div className="cs-record-hole" />
          </div>
          <div className="cs-tonearm" aria-hidden><span /></div>
          <div className="cs-record-caption">{playing ? "正在播放 · 点击暂停" : "点击唱片播放"}</div>
        </div>

        {/* ── 小世界：C 悄悄添置的装饰（state-driven） ── */}
        <div className="cs-world-section">
          <div className="cs-world-title">
            <Sparkles size={14} /> {name} 装扮的小世界
          </div>
          <div className="cs-world-grid">
            {COUPLE_DECORS.map((d) => {
              const on = unlockedSet.has(d.id);
              return (
                <div key={d.id} className={`cs-decor ${on ? "cs-decor-on" : "cs-decor-locked"}`} title={on ? d.title : d.hint}>
                  <span className="cs-decor-icon" style={on ? { color: d.accent } : undefined}>{on ? d.icon : "·"}</span>
                  <span className="cs-decor-name">{on ? d.title : "未解锁"}</span>
                </div>
              );
            })}
          </div>
          {unlockedDecors.length === 0 && (
            <div className="cs-world-empty">和 {name} 多聊聊，Ta 会悄悄往这里添置小东西。</div>
          )}
        </div>

        <div className="cs-footnote">— 这个小世界，正被 {name} 慢慢装扮 —</div>
        <div className="cs-bottom-space" />
      </div>

      {/* 新解锁轻提示 */}
      {newlyHint && <div className="cs-unlock-toast"><Sparkles size={14} /> {newlyHint}</div>}

      {/* ── 底部四 tab ── */}
      <nav className="cs-nav" aria-label="专属空间导航">
        <button type="button" onClick={() => setDrawerOpen((v) => !v)}>
          <Home size={19} /><span>手机</span>
        </button>
        <button type="button" onClick={onOpenChat}>
          <MessageCircle size={19} /><span>聊天</span>
        </button>
        <button type="button" onClick={() => setDrawerOpen(true)}>
          <Sparkles size={19} /><span>家园</span>
        </button>
        <button type="button" onClick={onOpenCharacter}>
          <Smile size={19} /><span>池屿</span>
        </button>
      </nav>

      {/* ── 侧滑抽屉 ── */}
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
                <span className="cs-online" />
              </div>
              <div className="cs-profile-info">
                <div className="cs-profile-name">{name}</div>
                <div className="cs-profile-status"><span className="cs-online-dot" /> online</div>
                <div className="cs-profile-mood">整理了一下歌单</div>
                <div className="cs-profile-tags">
                  <span className="cs-pill cs-pill-heart"><Heart size={11} /> 在一起 {days} 天</span>
                  {tags.slice(0, 2).map((t, i) => <span key={i} className="cs-pill">{t}</span>)}
                </div>
              </div>
            </div>

            <div className="cs-squares">
              <button type="button" onClick={() => openItem("character")}>
                <Sun size={20} />
                <span className="cs-sq-title">醒来记录</span>
                <span className="cs-sq-en">WAKE LOG</span>
                <span className="cs-sq-sub">今天醒过</span>
              </button>
              <button type="button" onClick={() => openItem("album")}>
                <ImageIcon size={20} />
                <span className="cs-sq-title">他的相册</span>
                <span className="cs-sq-en">ALBUM</span>
                <span className="cs-sq-sub">照片墙</span>
              </button>
              <button type="button" onClick={() => openItem("game")}>
                <BookOpen size={20} />
                <span className="cs-sq-title">共读</span>
                <span className="cs-sq-en">READING</span>
                <span className="cs-sq-sub">一起看</span>
              </button>
            </div>

            <div className="cs-menu-list">
              <button type="button" onClick={() => openItem("dwelling")}>
                <span className="cs-mi cs-mi-street"><Home size={17} /></span>
                <span className="cs-mi-text"><b>街角</b><small>STREET</small></span>
              </button>
              <button type="button" onClick={() => openItem("dwelling")}>
                <span className="cs-mi cs-mi-lounge"><CoffeeIcon /></span>
                <span className="cs-mi-text"><b>小客厅</b><small>LOUNGE</small></span>
              </button>
              <button type="button" onClick={() => openItem("qa")}>
                <span className="cs-mi cs-mi-tavern"><GlassWater size={17} /></span>
                <span className="cs-mi-text"><b>酒吧（SillyTavern）</b><small>TAVERN</small></span>
              </button>
              <button type="button" onClick={() => openItem("chat")}>
                <span className="cs-mi cs-mi-sticker"><Smile size={17} /></span>
                <span className="cs-mi-text"><b>表情包</b><small>STICKERS</small></span>
              </button>
              <button type="button" onClick={() => openItem("chat")}>
                <span className="cs-mi cs-mi-meme"><MessageCircle size={17} /></span>
                <span className="cs-mi-text"><b>梗库</b><small>MEMES</small></span>
              </button>
              <button type="button" onClick={() => openItem("theme")}>
                <span className="cs-mi cs-mi-time"><Clock3 size={17} /></span>
                <span className="cs-mi-text"><b>屏幕时间</b><small>SCREEN TIME</small></span>
              </button>
            </div>

            <div className="cs-settings">
              <div className="cs-settings-label">设置</div>
              <button type="button" onClick={onOpenTheme}>
                <span className="cs-mi cs-mi-theme"><Settings2 size={17} /></span>
                <span className="cs-mi-text"><b>主题</b><small>THEME · 切回原生主题</small></span>
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function CoffeeIcon() {
  return <GlassWater size={17} />;
}

export default CoupleSpace;
