"use client";
// components/phone-letters-app.tsx
// 信箱 App（主页入口）：聚合所有角色留给你的东西——
//   📬 收件箱：角色写的信（可请 TA 写信）
//   🌙 梦境：角色深夜/离线时的梦呓
//   📔 日记：角色私下写的心情日记

import { useCallback, useEffect, useState } from "react";
import { loadAllLetters, markLetterRead, deleteLetter, type LetterEntry } from "@/lib/letter-storage";
import { requestLetter, getLetterCooldownRemaining } from "@/lib/letter-service";
import { loadCharacters } from "@/lib/character-storage";

type TabId = "inbox" | "dream" | "diary";

const TABS: { id: TabId; label: string }[] = [
    { id: "inbox", label: "收件箱" },
    { id: "dream", label: "梦境" },
    { id: "diary", label: "日记" },
];

function typeOf(l: LetterEntry): NonNullable<LetterEntry["type"]> {
    return l.type || "letter";
}

export function PhoneLettersApp({ onClose }: { onClose: () => void }) {
    const [tab, setTab] = useState<TabId>("inbox");
    const [entries, setEntries] = useState<LetterEntry[]>([]);
    const [openId, setOpenId] = useState<string | null>(null);
    const [busyCharId, setBusyCharId] = useState<string | null>(null);
    const [cooldowns, setCooldowns] = useState<Record<string, number>>({});

    const refresh = useCallback(() => {
        loadAllLetters().then(setEntries).catch(() => setEntries([]));
    }, []);

    useEffect(() => {
        refresh();
        const timer = setInterval(() => {
            setCooldowns(prev => {
                const next: Record<string, number> = {};
                for (const id of Object.keys(prev)) {
                    const remain = getLetterCooldownRemaining(id);
                    if (remain > 0) next[id] = remain;
                }
                return next;
            });
        }, 5000);
        return () => clearInterval(timer);
    }, [refresh]);

    const chars = loadCharacters()
        .filter(c => c.id)
        .map(c => ({ id: c.id, name: c.name || "未命名" }));

    const filtered = entries.filter(l => typeOf(l) === (tab === "inbox" ? "letter" : tab));

    // 按角色分组（只显示有该类型内容的角色）
    const grouped = chars
        .map(char => ({ char, items: filtered.filter(l => l.characterId === char.id) }))
        .filter(g => g.items.length > 0)
        .sort((a, b) => new Date(b.items[0].createdAt).getTime() - new Date(a.items[0].createdAt).getTime());

    async function handleRequestLetter(characterId: string, charName: string) {
        if (busyCharId || cooldowns[characterId]) return;
        setBusyCharId(characterId);
        try {
            const letter = await requestLetter(characterId);
            if (letter) {
                setEntries(prev => [letter, ...prev]);
                setOpenId(letter.id);
            }
            setCooldowns(prev => {
                const remain = getLetterCooldownRemaining(characterId);
                return remain > 0 ? { ...prev, [characterId]: remain } : prev;
            });
        } finally {
            setBusyCharId(null);
        }
        void charName;
    }

    async function handleOpen(entry: LetterEntry) {
        setOpenId(entry.id);
        if (!entry.read) {
            await markLetterRead(entry.id);
            setEntries(prev => prev.map(l => l.id === entry.id ? { ...l, read: true } : l));
        }
    }

    async function handleDelete(id: string) {
        await deleteLetter(id);
        setEntries(prev => prev.filter(l => l.id !== id));
        if (openId === id) setOpenId(null);
    }

    const openEntry = entries.find(l => l.id === openId);

    return (
        <div className="phone-app-pane flex flex-col h-full bg-[var(--c-page-bg,#faf9f5)]">
            {/* 顶栏 */}
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                <button onClick={() => (openEntry ? setOpenId(null) : onClose())} className="flex items-center justify-center w-8 h-8 rounded-full hover:opacity-70" aria-label="返回">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M15 19 8 12l7-7" /></svg>
                </button>
                <div className="flex-1 text-center ts-14 font-semibold">信箱</div>
                <div className="w-8" />
            </div>

            {/* Tab 栏 */}
            <div className="flex px-4 gap-1 pb-2">
                {TABS.map(t => {
                    const count = entries.filter(l => typeOf(l) === (t.id === "inbox" ? "letter" : t.id)).length;
                    return (
                        <button
                            key={t.id}
                            className={`flex-1 py-1.5 rounded-lg ts-12 transition-colors ${tab === t.id ? "font-semibold bg-[color-mix(in_srgb,var(--c-accent,var(--c-primary,#4a3f2f))_14%,transparent)]" : "opacity-60"}`}
                            onClick={() => { setTab(t.id); setOpenId(null); }}
                        >
                            {t.label}
                            {count > 0 && <span className="ml-1 ts-10 opacity-60">{count}</span>}
                        </button>
                    );
                })}
            </div>

            {/* 内容 */}
            <div className="flex-1 overflow-y-auto px-3 pb-4">
                {openEntry ? (
                    <div className="flex flex-col gap-2 p-3 rounded-2xl bg-[var(--c-card,#fff)] border border-[color-mix(in_srgb,var(--c-card-border)_60%,transparent)]">
                        <div className="flex items-center gap-2">
                            <span className="ts-12 font-semibold">{openEntry.from} 的{typeOf(openEntry) === "letter" ? "来信" : typeOf(openEntry) === "dream" ? "梦呓" : "日记"}</span>
                            <span className="ts-10 opacity-50">
                                {(() => {
                                    const d = new Date(openEntry.createdAt);
                                    if (Number.isNaN(d.getTime())) return "";
                                    const h = String(d.getHours()).padStart(2, "0");
                                    const m = String(d.getMinutes()).padStart(2, "0");
                                    return `${d.getMonth() + 1}月${d.getDate()}日 ${h}:${m}`;
                                })()}
                            </span>
                            <div className="flex-1" />
                            <button className="ts-10 opacity-50 hover:opacity-100" onClick={() => setOpenId(null)}>收起</button>
                            <button className="ts-10 opacity-50 hover:opacity-100" onClick={() => handleDelete(openEntry.id)}>删除</button>
                        </div>
                        <div className="ts-13 leading-relaxed whitespace-pre-wrap break-words">{openEntry.content}</div>
                    </div>
                ) : grouped.length === 0 ? (
                    <div className="mt-10 flex flex-col items-center gap-2 ts-12 opacity-50">
                        {tab === "inbox" ? (
                            <>
                                <span>信箱还空着</span>
                                <span className="ts-11">回到聊天，点角色档案里的「请 TA 写封信」，TA 会基于对你的了解写信投递</span>
                            </>
                        ) : tab === "dream" ? (
                            <span>还没有梦境。夜深了角色会做梦，醒来你会在这里看到。</span>
                        ) : (
                            <span>还没有日记。角色每天会私下记一段心情。</span>
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        {grouped.map(({ char, items }) => (
                            <div key={char.id} className="flex flex-col gap-1.5 p-3 rounded-2xl bg-[var(--c-card,#fff)] border border-[color-mix(in_srgb,var(--c-card-border)_60%,transparent)]">
                                <div className="flex items-center gap-2 pb-1">
                                    <span className="w-7 h-7 rounded-full flex items-center justify-center bg-[color-mix(in_srgb,var(--c-accent,var(--c-primary,#4a3f2f))_18%,transparent)] text-[12px]">
                                        {char.name.slice(0, 1)}
                                    </span>
                                    <span className="ts-12 font-semibold flex-1">{char.name}</span>
                                    {tab === "inbox" && (
                                        <button
                                            className="ts-10 px-2 py-0.5 rounded-md border border-dashed border-[color-mix(in_srgb,var(--c-card-border)_80%,transparent)] opacity-70 disabled:opacity-40"
                                            disabled={busyCharId === char.id || !!cooldowns[char.id]}
                                            onClick={() => handleRequestLetter(char.id, char.name)}
                                        >
                                            {busyCharId === char.id ? "写信中…" : cooldowns[char.id] ? `稍后再写（${Math.ceil(cooldowns[char.id] / 1000)}s）` : "请 TA 写信"}
                                        </button>
                                    )}
                                </div>
                                {items.map(entry => (
                                    <button
                                        key={entry.id}
                                        className="flex items-center gap-2 py-1.5 px-1.5 rounded-lg text-left hover:opacity-75"
                                        onClick={() => handleOpen(entry)}
                                    >
                                        <span className={`shrink-0 ts-9 px-1.5 py-0.5 rounded border ${
                                            entry.read
                                                ? "border-[color-mix(in_srgb,var(--c-card-border)_80%,transparent)] opacity-45"
                                                : "border-[color-mix(in_srgb,var(--c-accent,var(--c-primary,#4a3f2f))_60%,transparent)] text-[color-mix(in_srgb,var(--c-accent,var(--c-primary,#4a3f2f))_85%,transparent)] font-semibold"
                                        }`}>
                                            {entry.read ? "已读" : "新"}
                                        </span>
                                        <span className="flex-1 ts-12 truncate">{entry.content.replace(/\s+/g, " ").slice(0, 42)}{entry.content.length > 42 ? "…" : ""}</span>
                                        <span className="ts-10 opacity-40 shrink-0">
                                            {(() => {
                                                const d = new Date(entry.createdAt);
                                                if (Number.isNaN(d.getTime())) return "";
                                                return `${d.getMonth() + 1}/${d.getDate()}`;
                                            })()}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
