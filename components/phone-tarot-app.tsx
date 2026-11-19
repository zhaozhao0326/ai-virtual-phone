"use client";

// 迷恋塔罗 · App（React 版）
// 引擎：lib/tarot/engine.ts（移植自 LegoPhone modules/milian-tarot，上游引擎 ISC 许可，见 lib/tarot/upstream/）
// 交互流：选角色 → 写问题（自动推荐牌阵，可改）→ 逐张抽牌 → 翻开全部 →
//         「塔罗师解读」（正式解读）／「让 TA 陪你看牌」（角色第一人称陪伴视角）→ 历史记录。
// LLM 均为用户主动点击触发（零后台调用），短文本用 simpleLLMCall + disableThinking。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Sparkles, Trash2, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { loadApiConfigs, loadBindingConfig } from "@/lib/settings-storage";
import { simpleLLMCall } from "@/lib/api-helpers";
import {
    SPREADS,
    autoSpread,
    createSession,
    placedCards,
    drawRandomCard,
    revealCards,
    saveTarotSession,
    loadTarotSessions,
    deleteTarotSession,
    type TarotSession,
} from "@/lib/tarot/engine";
import { readingMessages, companionMessages } from "@/lib/tarot/prompts";
import { mdToHtml } from "@/lib/tarot/upstream/tarot/reading.js";
import { renderCardFace, releaseFaceCache } from "@/lib/tarot/upstream/tarot/cardface.js";

type Stage = "home" | "question" | "session";

function pickTarotApiConfig() {
    try {
        const gid = loadBindingConfig().globalDefaults.apiConfigId;
        const all = loadApiConfigs();
        return (gid ? all.find(c => c.id === gid) : undefined) ?? all[0] ?? null;
    } catch {
        return null;
    }
}

export default function PhoneTarotApp({ onClose, initialCharacterId }: {
    onClose: () => void;
    initialCharacterId?: string;
}) {
    const characters = useMemo(() => { try { return loadCharacters(); } catch { return []; } }, []);
    const [charId, setCharId] = useState<string | null>(initialCharacterId ?? characters[0]?.id ?? null);
    const ready = characters.length > 0 && (initialCharacterId ? characters.some(c => c.id === initialCharacterId) : true);

    const [stage, setStage] = useState<Stage>("home");
    const [question, setQuestion] = useState("");
    const [spreadId, setSpreadId] = useState<string>("");
    const [session, setSession] = useState<TarotSession | null>(null);
    const [history, setHistory] = useState<TarotSession[]>([]);
    const [busy, setBusy] = useState<"" | "reading" | "companion">("");
    const [error, setError] = useState<string | null>(null);
    const faceHostRef = useRef<HTMLDivElement | null>(null);

    const character: Character | null = characters.find(c => c.id === charId) ?? null;

    const refreshHistory = useCallback((cid: string) => {
        setHistory(loadTarotSessions(cid));
    }, []);

    useEffect(() => {
        if (charId) refreshHistory(charId);
    }, [charId, refreshHistory]);

    // 释放上游 Canvas 牌面缓存
    useEffect(() => () => { try { releaseFaceCache(); } catch { /* 忽略 */ } }, []);

    // 翻开后把上游 Canvas 牌面挂进容器
    useEffect(() => {
        const host = faceHostRef.current;
        if (!host || !session || !session.revealed) return;
        host.innerHTML = "";
        try {
            for (const p of placedCards(session)) {
                const face = renderCardFace(p.card);
                face.className = "tarot-face";
                if (p.reversed) { face.style.transform = "rotate(180deg)"; face.dataset.reversed = "1"; }
                host.appendChild(face);
            }
        } catch { /* 牌面绘制失败不阻塞解读 */ }
    }, [session]);

    function startSession() {
        setError(null);
        if (!charId) return;
        const q = question.trim();
        if (!q) { setError("先写下你想问的事"); return; }
        try {
            const sid = spreadId || autoSpread(q).id;
            const s = createSession(charId, q, sid);
            setSession(s);
            setStage("session");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    function handleDraw() {
        setError(null);
        if (!session) return;
        try {
            setSession(drawRandomCard(session));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    function handleReveal() {
        setError(null);
        if (!session) return;
        try {
            const revealed = revealCards(session);
            setSession(revealed);
            saveTarotSession(charId!, revealed);
            refreshHistory(charId!);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    async function runReading() {
        if (!session || !charId || busy) return;
        setError(null);
        setBusy("reading");
        const running = { ...session, reading: { status: "running" as const, text: "" } };
        setSession(running);
        try {
            const config = pickTarotApiConfig();
            if (!config) throw new Error("尚未配置 AI 接口，请先在设置里填好 API");
            const placed = placedCards(session);
            const messages = readingMessages(session, placed);
            const res = await simpleLLMCall(config, messages, {
                temperature: 0.7, max_tokens: 2200, disableThinking: true, purpose: "tarot-reading",
            });
            if (!res.content) throw new Error(res.error || "解读没有返回内容");
            const done: TarotSession = { ...session, reading: { status: "succeeded", text: res.content } };
            setSession(done);
            saveTarotSession(charId, done);
            refreshHistory(charId);
        } catch (e) {
            const failed: TarotSession = { ...session, reading: { status: "failed", text: e instanceof Error ? e.message : String(e) } };
            setSession(failed);
            saveTarotSession(charId, failed);
            setError(failed.reading.text);
        } finally {
            setBusy("");
        }
    }

    async function runCompanion() {
        if (!session || !charId || busy) return;
        if (!character) { setError("角色数据未就绪"); return; }
        setError(null);
        setBusy("companion");
        const running = { ...session, companion: { status: "running" as const, text: "" } };
        setSession(running);
        try {
            const config = pickTarotApiConfig();
            if (!config) throw new Error("尚未配置 AI 接口，请先在设置里填好 API");
            const placed = placedCards(session);
            const placedSummary = placed
                .map((p, i) => `${i + 1}.「${p.slot.label}」${p.card.zh}${p.reversed ? "（逆位）" : "（正位）"}——关键词：${p.reversed ? p.card.k_rev : p.card.k_up}`)
                .join("\n");
            const messages = companionMessages(session, character, placedSummary, session.reading.status === "succeeded" ? session.reading.text : "");
            const res = await simpleLLMCall(config, messages, {
                temperature: 0.8, max_tokens: 900, disableThinking: true, purpose: "tarot-companion", characterName: character.name,
            });
            if (!res.content) throw new Error(res.error || "TA 没有说话，稍后再试");
            const done: TarotSession = { ...session, companion: { status: "succeeded", text: res.content } };
            setSession(done);
            saveTarotSession(charId, done);
            refreshHistory(charId);
        } catch (e) {
            const failed: TarotSession = { ...session, companion: { status: "failed", text: e instanceof Error ? e.message : String(e) } };
            setSession(failed);
            saveTarotSession(charId, failed);
            setError(failed.companion.text);
        } finally {
            setBusy("");
        }
    }

    function openHistory(s: TarotSession) {
        setSession(s);
        setStage("session");
    }

    function removeHistory(id: string) {
        if (!charId) return;
        deleteTarotSession(charId, id);
        refreshHistory(charId);
        if (session?.id === id) { setSession(null); setStage("home"); }
    }

    // ── 渲染 ──
    if (!ready) {
        return (
            <div className="tarot-app">
                <div className="tarot-header">
                    <button className="tarot-back" onClick={onClose}><ChevronLeft size={18} /></button>
                    <h1>塔 罗<span className="tarot-title-en">TAROT</span></h1>
                </div>
                <div className="tarot-empty">角色数据加载中…</div>
            </div>
        );
    }

    if (!characters.length) {
        return (
            <div className="tarot-app">
                <div className="tarot-header">
                    <button className="tarot-back" onClick={onClose}><ChevronLeft size={18} /></button>
                    <h1>塔 罗<span className="tarot-title-en">TAROT</span></h1>
                </div>
                <div className="tarot-empty">还没有角色。先去「角色」里创建一个，再回来一起占卜。</div>
            </div>
        );
    }

    const spread = session ? SPREADS.find(s => s.id === session.spreadId) : null;
    const canDraw = session && !session.revealed && session.selected.length < (spread?.count ?? 0);
    const placed = session && session.revealed ? placedCards(session) : [];

    return (
        <div className="tarot-app">
            <div className="tarot-header">
                <button className="tarot-back" onClick={() => {
                    if (stage === "session") { setSession(null); setStage("home"); }
                    else if (stage === "question") { setStage("home"); }
                    else onClose();
                }}><ChevronLeft size={18} /></button>
                <h1>塔 罗<span className="tarot-title-en">TAROT</span></h1>
                {stage === "home" && (
                    <button className="tarot-new" onClick={() => { setQuestion(""); setSpreadId(""); setStage("question"); }}>
                        <Sparkles size={15} /> 新占卜
                    </button>
                )}
            </div>

            {error && (
                <div className="tarot-error">
                    {error}
                    <button onClick={() => setError(null)}><X size={14} /></button>
                </div>
            )}

            {/* 角色选择条 */}
            <div className="tarot-char-picker">
                {characters.map(c => (
                    <button key={c.id} className={`tarot-char-chip${c.id === charId ? " active" : ""}`}
                        onClick={() => { setCharId(c.id); setSession(null); setStage("home"); }}>
                        {c.name || "未命名"}
                    </button>
                ))}
            </div>

            {stage === "home" && (
                <div className="tarot-body">
                    <div className="tarot-hero">
                        <div className="tarot-hero-cards" aria-hidden="true">
                            <span className="tarot-cardback" />
                            <span className="tarot-cardback" />
                            <span className="tarot-cardback" />
                        </div>
                        <div className="tarot-hero-title">和{character?.name || "TA"}抽一组牌</div>
                        <div className="tarot-hero-sub">塔罗不是预言，是一面照见当下的镜子。</div>
                    </div>

                    <div className="tarot-section-title">选个牌阵，直接开始</div>
                    <div className="tarot-spread-list">
                        {SPREADS.map(s => (
                            <button key={s.id} className="tarot-spread-card"
                                onClick={() => { setQuestion(""); setSpreadId(s.id); setError(null); setStage("question"); }}>
                                <span className="tarot-spread-card-head">
                                    <span className="tarot-spread-card-name">{s.zh}</span>
                                    <span className="tarot-spread-card-count">{s.count} 张</span>
                                </span>
                                <span className="tarot-spread-card-desc">{s.bestFor}</span>
                            </button>
                        ))}
                    </div>

                    {history.length > 0 && (
                        <>
                            <div className="tarot-section-title">最近的占卜</div>
                            <div className="tarot-history">
                                {history.map(s => {
                                    const hs = SPREADS.find(x => x.id === s.spreadId);
                                    return (
                                        <div key={s.id} className="tarot-history-item" onClick={() => openHistory(s)}>
                                            <div className="tarot-history-q">{s.question}</div>
                                            <div className="tarot-history-meta">
                                                {hs?.zh ?? s.spreadId} · {new Date(s.createdAt).toLocaleDateString()}
                                                {s.reading.status === "succeeded" && " · 已解读"}
                                                {s.companion.status === "succeeded" && " · TA 说过"}
                                            </div>
                                            <button className="tarot-history-del" onClick={e => { e.stopPropagation(); removeHistory(s.id); }}>
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
            )}

            {stage === "question" && (
                <div className="tarot-body">
                    <textarea
                        className="tarot-question"
                        placeholder={`想问${character?.name || "TA"}什么？（最多 1000 字）`}
                        value={question}
                        maxLength={1000}
                        onChange={e => setQuestion(e.target.value)}
                    />
                    {question.trim() && (
                        <div className="tarot-suggest">推荐牌阵：{autoSpread(question).zh}（{autoSpread(question).bestFor}）</div>
                    )}
                    <div className="tarot-spreads">
                        {SPREADS.map(s => (
                            <button key={s.id}
                                className={`tarot-spread-chip${(spreadId || (question.trim() && autoSpread(question).id)) === s.id ? " active" : ""}`}
                                onClick={() => setSpreadId(s.id)}>
                                {s.zh}<span>{s.count} 张</span>
                            </button>
                        ))}
                    </div>
                    <button className="tarot-primary" onClick={startSession}>开始洗牌</button>
                </div>
            )}

            {stage === "session" && session && (
                <div className="tarot-body">
                    <div className="tarot-session-q">{session.question}</div>
                    <div className="tarot-spread-name">{spread?.zh}</div>

                    {/* 牌位：抽牌前是暗位，翻开后展示牌面 */}
                    <div className="tarot-slots" ref={faceHostRef} data-revealed={session.revealed ? "1" : undefined}>
                        {!session.revealed && Array.from({ length: spread?.count ?? 0 }).map((_, i) => (
                            <div key={i} className={`tarot-slot${i < session.selected.length ? " filled" : ""}`}>
                                <span>{spread?.slots[i]?.label}</span>
                            </div>
                        ))}
                    </div>

                    {!session.revealed && (
                        <button className="tarot-primary" onClick={canDraw ? handleDraw : handleReveal}>
                            {canDraw ? `抽第 ${session.selected.length + 1} 张牌` : "翻开全部"}
                        </button>
                    )}

                    {/* 翻开后的牌面文字 */}
                    {session.revealed && (
                        <div className="tarot-revealed">
                            {placed.map((p, i) => (
                                <div key={i} className="tarot-placed">
                                    <span className="tarot-placed-slot">{p.slot.label}</span>
                                    <span className="tarot-placed-card">{p.card.zh}{p.reversed ? " · 逆位" : " · 正位"}</span>
                                    <span className="tarot-placed-keys">{p.reversed ? p.card.k_rev : p.card.k_up}</span>
                                </div>
                            ))}
                            <div className="tarot-actions">
                                <button className="tarot-primary" disabled={busy !== "" || session.reading.status === "running"}
                                    onClick={runReading}>
                                    {session.reading.status === "running" ? "塔罗师解读中…" : session.reading.status === "succeeded" ? "重新请塔罗师解读" : "请塔罗师解读"}
                                </button>
                                <button className="tarot-secondary" disabled={busy !== "" || session.companion.status === "running"}
                                    onClick={runCompanion}>
                                    {busy === "companion" ? "TA 在看牌…" : session.companion.status === "succeeded" ? `再和${character?.name || "TA"}聊聊` : `让${character?.name || "TA"}陪你看牌`}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* 解读 / 陪伴文本 */}
                    {session.reading.status === "succeeded" && (
                        <div className="tarot-reading">
                            <div className="tarot-reading-title">塔罗师的解读</div>
                            <div className="tarot-md" dangerouslySetInnerHTML={{ __html: mdToHtml(session.reading.text) }} />
                        </div>
                    )}
                    {session.companion.status === "succeeded" && (
                        <div className="tarot-companion">
                            <div className="tarot-companion-name">{character?.name || "TA"}</div>
                            <div className="tarot-companion-text">{session.companion.text}</div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
