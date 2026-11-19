"use client";

// 推特/X · App（React 版，搬自 LegoPhone twitter 模块的角色化改接）
// 结构：推荐流（关注角色的推） / 我的（发推 + 收评论）
// 铁律：所有 AI 调用均用户点击触发（零后台）；关注列表默认空 = 不给任何角色烧 token。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, Trash2, X as XIcon } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { loadApiConfigs, loadBindingConfig } from "@/lib/settings-storage";
import { simpleLLMCall } from "@/lib/api-helpers";
import {
    loadXPosts, addXPost, deleteXPost, addXComments, toggleXLike,
    loadXFollowing, toggleXFollowing,
    type XPost,
} from "@/lib/x-store";
import { tweetGenerationMessages, tweetCommentMessages, parseTweetsJSON, parseCommentJSON } from "@/lib/x-prompts";

type Tab = "feed" | "mine";
type ApiConfig = ReturnType<typeof loadApiConfigs>[number];

function pickXApiConfig(): ApiConfig | null {
    try {
        const gid = loadBindingConfig().globalDefaults.apiConfigId;
        const all = loadApiConfigs();
        return (gid ? all.find(c => c.id === gid) : undefined) ?? all[0] ?? null;
    } catch { return null; }
}

function timeLabel(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function PhoneTwitterApp({ onClose, initialCharacterId }: {
    onClose: () => void;
    initialCharacterId?: string;
}) {
    const characters = useMemo(() => { try { return loadCharacters(); } catch { return []; } }, []);
    const [tab, setTab] = useState<Tab>("feed");
    const [posts, setPosts] = useState<XPost[]>([]);
    const [following, setFollowing] = useState<string[]>([]);
    const [busy, setBusy] = useState<"" | "feed" | "comment">("");
    const [busyCharId, setBusyCharId] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [commentPostId, setCommentPostId] = useState<string | null>(null);
    const [myCommentDraft, setMyCommentDraft] = useState("");
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerQuery, setPickerQuery] = useState("");

    const refresh = useCallback(() => {
        setPosts(loadXPosts());
        setFollowing(loadXFollowing());
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    // 情侣空间直达：预关注该角色
    useEffect(() => {
        if (initialCharacterId && !loadXFollowing().includes(initialCharacterId)) {
            setFollowing(toggleXFollowing(initialCharacterId));
        }
    }, [initialCharacterId]);

    const followedChars = characters.filter(c => following.includes(c.id));
    const charById = (id?: string) => characters.find(c => c.id === id) ?? null;

    async function handleRefreshFeed() {
        if (busy) return;
        setError(null);
        if (!followedChars.length) { setError("先在上面选几个想关注的人吧～"); return; }
        setBusy("feed");
        try {
            const config = pickXApiConfig();
            if (!config) throw new Error("尚未配置 AI 接口，请先在设置里填好 API");
            // 每次点击最多取 3 个关注角色，控制 token
            const targets = [...followedChars].sort(() => Math.random() - 0.5).slice(0, 3);
            for (const ch of targets) {
                setBusyCharId(ch.id);
                const res = await simpleLLMCall(config, tweetGenerationMessages(ch), {
                    temperature: 0.85, max_tokens: 500, disableThinking: true, purpose: "x-tweet", characterName: ch.name,
                });
                if (res.content) {
                    for (const t of parseTweetsJSON(res.content)) addXPost({ characterId: ch.id, text: t });
                }
            }
            refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy("");
            setBusyCharId(null);
        }
    }

    async function handleAskComment(post: XPost, ch: Character) {
        if (busy || !commentPostId) return;
        setError(null);
        setBusy("comment");
        setBusyCharId(ch.id);
        try {
            const config = pickXApiConfig();
            if (!config) throw new Error("尚未配置 AI 接口，请先在设置里填好 API");
            const author = post.isUser ? "我" : (charById(post.characterId)?.name ?? "网友");
            const res = await simpleLLMCall(config, tweetCommentMessages(ch, author, post.text), {
                temperature: 0.85, max_tokens: 200, disableThinking: true, purpose: "x-comment", characterName: ch.name,
            });
            if (res.content) {
                const text = parseCommentJSON(res.content);
                if (text) addXComments(post.id, [{ characterId: ch.id, text }]);
                refresh();
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy("");
            setBusyCharId(null);
        }
    }

    function handlePost() {
        if (!draft.trim()) return;
        addXPost({ isUser: true, text: draft });
        setDraft("");
        refresh();
    }

    function handleMyComment(post: XPost) {
        if (!myCommentDraft.trim() || !commentPostId) return;
        addXComments(post.id, [{ isUser: true, text: myCommentDraft }]);
        setMyCommentDraft("");
        refresh();
    }

    const commentPost = commentPostId ? posts.find(p => p.id === commentPostId) ?? null : null;

    return (
        <div className="x-app">
            <header className="x-topbar">
                <button className="x-back" onClick={onClose} aria-label="返回"><ChevronLeft size={20} /></button>
                <span className="x-title">推特</span>
                <div className="x-tabs">
                    <button className={tab === "feed" ? "on" : ""} onClick={() => setTab("feed")}>推荐</button>
                    <button className={tab === "mine" ? "on" : ""} onClick={() => setTab("mine")}>我的</button>
                </div>
            </header>

            {error && <div className="x-error">{error}</div>}

            {tab === "feed" && (
                <div className="x-body">
                    <div className="x-rail-wrap">
                        {characters.length === 0 && <div className="x-empty">还没有角色，先去「档案」建一个吧。</div>}
                        {characters.length > 0 && following.length === 0 && (
                            <div className="x-rail-hint">还没关注任何人——点右边「＋ 选人」挑几个。</div>
                        )}
                        <div className="x-rail">
                            {followedChars.map(c => (
                                <button key={c.id} className="x-chip on" onClick={() => setFollowing(toggleXFollowing(c.id))}>
                                    {c.avatar
                                        ? <img src={c.avatar} alt="" className="x-chip-avatar" />
                                        : <span className="x-chip-avatar x-chip-letter">{c.name.slice(0, 1)}</span>}
                                    <span className="x-chip-name">{c.name}</span>
                                </button>
                            ))}
                            {characters.length > 0 && (
                                <button className="x-chip x-chip-add" onClick={() => { setPickerQuery(""); setPickerOpen(true); }}>
                                    ＋ 选人
                                </button>
                            )}
                        </div>
                    </div>
                    <button className="x-refresh" onClick={handleRefreshFeed} disabled={busy === "feed"}>
                        {busy === "feed" ? (busyCharId ? `${charById(busyCharId)?.name ?? ""} 正在发推…` : "生成中…") : "刷新推荐流（每次最多 3 人发推）"}
                    </button>

                    {posts.filter(p => p.characterId || p.isUser).length === 0 && (
                        <div className="x-empty">时间线还是空的。选好人、点上面的按钮，TA 们就会来发推。</div>
                    )}
                    {posts.map(post => {
                        const author = post.isUser ? { name: "我", avatar: null } : charById(post.characterId);
                        if (!post.isUser && !author) return null;
                        return (
                            <article key={post.id} className="x-post">
                                <div className="x-post-head">
                                    {author?.avatar
                                        ? <img src={author.avatar} alt="" className="x-avatar" />
                                        : <span className="x-avatar x-avatar-letter">{(author?.name ?? "我").slice(0, 1)}</span>}
                                    <div className="x-post-meta">
                                        <span className="x-post-name">{author?.name ?? "我"}</span>
                                        <span className="x-post-sub">{post.isUser ? "@me" : `@${(author as Character).name}`} · {timeLabel(post.createdAt)}</span>
                                    </div>
                                    {!post.isUser && <button className="x-mini" onClick={() => setCommentPostId(post.id)}>评论</button>}
                                </div>
                                <p className="x-post-text">{post.text}</p>
                                <div className="x-post-actions">
                                    <button className={post.liked ? "liked" : ""} onClick={() => { toggleXLike(post.id); refresh(); }}>
                                        ❤ {post.likes > 0 ? post.likes : ""}
                                    </button>
                                    <button onClick={() => setCommentPostId(post.id)}>💬 {post.comments.length || ""}</button>
                                    {post.isUser && <button onClick={() => { deleteXPost(post.id); refresh(); }}><Trash2 size={13} /></button>}
                                </div>
                                {post.comments.length > 0 && (
                                    <div className="x-comments">
                                        {post.comments.slice(-4).map(cm => {
                                            const cmChar = cm.isUser ? { name: "我" } : charById(cm.characterId);
                                            return (
                                                <div key={cm.id} className="x-comment">
                                                    <span className="x-comment-name">{cmChar?.name ?? "网友"}</span>
                                                    <span className="x-comment-text">{cm.text}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </article>
                        );
                    })}
                </div>
            )}

            {tab === "mine" && (
                <div className="x-body">
                    <div className="x-compose">
                        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3}
                            placeholder="有什么新鲜事？" maxLength={500} />
                        <button className="x-send" onClick={handlePost} disabled={!draft.trim()}>发布</button>
                    </div>
                    {posts.filter(p => p.isUser).length === 0 && <div className="x-empty">还没发过推。第一条就从此刻开始～</div>}
                    {posts.filter(p => p.isUser).map(post => (
                        <article key={post.id} className="x-post">
                            <div className="x-post-head">
                                <span className="x-avatar x-avatar-letter">我</span>
                                <div className="x-post-meta">
                                    <span className="x-post-name">我</span>
                                    <span className="x-post-sub">@me · {timeLabel(post.createdAt)}</span>
                                </div>
                                <button className="x-mini" onClick={() => setCommentPostId(post.id)}>评论</button>
                                <button className="x-mini danger" onClick={() => { deleteXPost(post.id); refresh(); }}><Trash2 size={13} /></button>
                            </div>
                            <p className="x-post-text">{post.text}</p>
                            <div className="x-post-actions">
                                <button onClick={() => setCommentPostId(post.id)}>💬 {post.comments.length || ""}</button>
                            </div>
                        </article>
                    ))}
                </div>
            )}

            {pickerOpen && (
                <div className="x-sheet-mask" onClick={() => setPickerOpen(false)}>
                    <div className="x-sheet" onClick={e => e.stopPropagation()}>
                        <div className="x-sheet-head">
                            <span>选择关注（{following.length} 人）</span>
                            <button onClick={() => setPickerOpen(false)}><XIcon size={16} /></button>
                        </div>
                        <input className="x-search" value={pickerQuery} onChange={e => setPickerQuery(e.target.value)}
                            placeholder="搜索名字" />
                        <div className="x-picker-list">
                            {characters
                                .filter(c => !pickerQuery.trim() || c.name.includes(pickerQuery.trim()))
                                .map(c => (
                                    <button key={c.id} className={`x-picker-row${following.includes(c.id) ? " on" : ""}`}
                                        onClick={() => setFollowing(toggleXFollowing(c.id))}>
                                        {c.avatar
                                            ? <img src={c.avatar} alt="" className="x-chip-avatar" />
                                            : <span className="x-chip-avatar x-chip-letter">{c.name.slice(0, 1)}</span>}
                                        <span className="x-picker-name">{c.name}</span>
                                        <span className="x-picker-mark">{following.includes(c.id) ? "已关注" : "＋"}</span>
                                    </button>
                                ))}
                        </div>
                    </div>
                </div>
            )}

            {commentPost && (
                <div className="x-sheet-mask" onClick={() => { setCommentPostId(null); setMyCommentDraft(""); }}>
                    <div className="x-sheet" onClick={e => e.stopPropagation()}>
                        <div className="x-sheet-head">
                            <span>评论这条推</span>
                            <button onClick={() => { setCommentPostId(null); setMyCommentDraft(""); }}><XIcon size={16} /></button>
                        </div>
                        <p className="x-sheet-quote">{commentPost.text}</p>
                        <div className="x-sheet-chars">
                            {followedChars.length === 0 && <div className="x-empty">先在「推荐」页关注想评论的角色。</div>}
                            {followedChars.map(c => (
                                <button key={c.id} className="x-chip" disabled={busy === "comment"}
                                    onClick={() => handleAskComment(commentPost, c)}>
                                    {busy === "comment" && busyCharId === c.id ? `${c.name} 想着怎么说…` : `让 ${c.name} 评论`}
                                </button>
                            ))}
                        </div>
                        <div className="x-sheet-mine">
                            <input value={myCommentDraft} onChange={e => setMyCommentDraft(e.target.value)}
                                placeholder="或自己写一条评论" maxLength={300}
                                onKeyDown={e => { if (e.key === "Enter") handleMyComment(commentPost); }} />
                            <button className="x-send" onClick={() => handleMyComment(commentPost)} disabled={!myCommentDraft.trim()}>发送</button>
                        </div>
                        {commentPost.comments.length > 0 && (
                            <div className="x-comments x-comments-sheet">
                                {commentPost.comments.map(cm => {
                                    const cmChar = cm.isUser ? { name: "我" } : charById(cm.characterId);
                                    return (
                                        <div key={cm.id} className="x-comment">
                                            <span className="x-comment-name">{cmChar?.name ?? "网友"}</span>
                                            <span className="x-comment-text">{cm.text}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
