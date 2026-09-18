"use client";

import { memo, useCallback, useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Trash2, Plus, Smile, ImagePlus, Check, ChevronDown, ChevronRight, Info, Pencil, Sticker, Layers } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    splitStickerSheet,
    buildSheetStickerNames,
    isGenericImageName,
    type StickerSheetSplit,
} from "@/lib/sticker-sheet-split";
import {
    decodeStickerPackPng,
    isLikelyStickerPackPng,
    type StickerPackDecode,
} from "@/lib/sticker-pack-png";
import {
    loadStickerPacks,
    createStickerPack,
    deleteStickerPack,
    addStickerToPack,
    addStickersToPack,
    addStickerByUrlToPack,
    checkStickerBlob,
    updateStickerPackInfo,
    STICKER_PACK_NAME_MAX,
    STICKER_PACK_NOTE_MAX,
    renameStickerInPack,
    removeStickerFromPack,
    getPackAssignments,
    togglePackAssignment,
    resolvePackStickerMap,
    getCharacterPackIds,
    type StickerItem,
    type StickerPack,
} from "@/lib/custom-sticker-storage";
import { loadChatContacts } from "@/lib/chat-storage";
import { PageShell } from "@/components/ui/page-shell";
import { ConfirmDialog } from "@/components/ui/modal";

export function StickerManager({ onBack }: { onBack: () => void }) {
    const contactIds = new Set(loadChatContacts().map(c => c.characterId));
    const characters = loadCharacters().filter(c => contactIds.has(c.id));
    const [packs, setPacks] = useState<StickerPack[]>([]);
    const [editingPack, setEditingPack] = useState<StickerPack | null>(null);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [deletingPackId, setDeletingPackId] = useState<string | null>(null);

    const refresh = () => setPacks(loadStickerPacks());
    useEffect(() => { refresh(); }, []);

    const handleConfirmDeletePack = async () => {
        if (!deletingPackId) return;
        await deleteStickerPack(deletingPackId);
        setDeletingPackId(null);
        refresh();
    };

    if (editingPack) {
        return (
            <PackEditor
                pack={editingPack}
                onBack={() => { setEditingPack(null); refresh(); }}
            />
        );
    }

    return (
        <PageShell title="表情包管理" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="px-5 pt-4 pb-8 h-full overflow-y-auto">
                <div className="grid grid-cols-2 gap-4">
                    {packs.map((pack, i) => {
                        const assignedIds = getPackAssignments(pack.id);
                        const assignedNames = characters.filter(c => assignedIds.includes(c.id)).map(c => c.name);
                        
                        // Pick a dynamic gradient based on index so the grid looks vibrant
                        const gradients = [
                            "from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 text-teal-600",
                            "from-orange-100 to-amber-100 dark:from-orange-900/30 dark:to-amber-900/30 text-orange-600",
                            "from-blue-100 to-indigo-100 dark:from-blue-900/30 dark:to-indigo-900/30 text-indigo-600",
                            "from-pink-100 to-rose-100 dark:from-pink-900/30 dark:to-rose-900/30 text-rose-600",
                        ];
                        const gClass = gradients[i % gradients.length];
                        const [bgGrad, textColor] = [gClass.split(" text-")[0], "text-" + gClass.split(" text-")[1]];

                        return (
                        <div key={pack.id} className="relative group">
                            <button
                                onClick={() => setEditingPack(pack)}
                                className="w-full bg-[var(--c-card)] rounded-[22px] p-4 pb-5 flex flex-col items-start gap-4 cursor-pointer text-left transition-transform duration-200 active:scale-[0.96] border-none"
                                style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.025), inset 0 1px 0 rgba(255,255,255,0.4)" }}
                            >
                                <div className={`w-[48px] h-[48px] rounded-2xl bg-gradient-to-br ${bgGrad} flex items-center justify-center shrink-0 shadow-inner`}>
                                    <Sticker size={24} className={textColor} />
                                </div>
                                
                                <div className="flex flex-col w-full gap-0.5">
                                    <span className="ts-16 text-[var(--c-text-title)] font-bold truncate max-w-full leading-tight">{pack.name}</span>
                                    <span className="ts-12 text-[var(--c-text)] opacity-70">{pack.stickers.length === 0 ? "空相册" : `${pack.stickers.length} 个表情`}</span>
                                    {pack.note?.trim() && (
                                        <span className="ts-11 text-[var(--c-text)] opacity-50 truncate mt-1">{pack.note.trim()}</span>
                                    )}
                                </div>

                                {assignedNames.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 mt-auto max-w-full w-full">
                                        {assignedNames.slice(0, 2).map(name => (
                                            <span key={name} className="px-2 py-0.5 rounded-md ts-10 font-medium truncate max-w-[full]" style={{ background: "color-mix(in srgb, var(--c-icon) 8%, transparent)", color: "var(--c-text)" }}>{name}</span>
                                        ))}
                                        {assignedNames.length > 2 && (
                                            <span className="px-1.5 py-0.5 rounded-md ts-10 font-bold" style={{ background: "color-mix(in srgb, var(--c-icon) 8%, transparent)", color: "var(--c-text)" }}>+{assignedNames.length - 2}</span>
                                        )}
                                    </div>
                                )}
                            </button>
                            <button
                                type="button"
                                aria-label={`删除表情包组 ${pack.name}`}
                                onClick={() => setDeletingPackId(pack.id)}
                                className="absolute top-2 right-2 w-7 h-7 bg-white/60 dark:bg-black/40 backdrop-blur-md rounded-full flex items-center justify-center text-[var(--c-danger)] opacity-100 transition-opacity z-10 shadow-sm"
                            ><Trash2 size={14} /></button>
                        </div>
                        );
                    })}
                    
                    {/* Add tile */}
                    <button
                        onClick={() => setShowCreateDialog(true)}
                        className="w-full min-h-[160px] bg-transparent rounded-[22px] flex flex-col items-center justify-center gap-3 cursor-pointer transition-transform duration-200 active:scale-[0.96] border-[1.5px] border-dashed border-[var(--c-card-border)] opacity-60 hover:opacity-100"
                    >
                        <div className="w-[46px] h-[46px] rounded-full bg-[var(--c-card)] shadow-sm flex items-center justify-center text-[var(--c-icon)]">
                            <Plus size={24} />
                        </div>
                        <span className="ts-14 font-medium text-[var(--c-text)]">新建图集</span>
                    </button>
                </div>
            </div>

            {showCreateDialog && createPortal(
                <CreatePackDialog
                    characters={characters}
                    onConfirm={(pack) => {
                        setShowCreateDialog(false);
                        refresh();
                        setEditingPack(pack);
                    }}
                    onCancel={() => setShowCreateDialog(false)}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}

            {deletingPackId && createPortal(
                <ConfirmDialog
                    title="删除表情包组"
                    message="删除后所有表情将被清除，确定要删除吗？"
                    variant="danger"
                    confirmLabel="删除"
                    onConfirm={handleConfirmDeletePack}
                    onCancel={() => setDeletingPackId(null)}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}
        </PageShell>
    );
}

// ── Create Pack Dialog (centered modal) ──

function CreatePackDialog({
    characters,
    onConfirm,
    onCancel,
}: {
    characters: Character[];
    onConfirm: (pack: StickerPack) => void;
    onCancel: () => void;
}) {
    const [name, setName] = useState("");
    const [note, setNote] = useState("");
    const [selectedCharIds, setSelectedCharIds] = useState<string[]>([]);

    const handleToggle = (charId: string) => {
        setSelectedCharIds(prev =>
            prev.includes(charId) ? prev.filter(id => id !== charId) : [...prev, charId]
        );
    };

    const handleCreate = () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const pack = createStickerPack(trimmed, note.trim());
        for (const charId of selectedCharIds) {
            togglePackAssignment(pack.id, charId);
        }
        onConfirm(pack);
    };

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onCancel}>
            <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3 className="modal-title">创建表情包组</h3>
                </div>

                <div className="modal-body">
                    <div className="flex flex-col gap-4 text-left w-full">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">名称</label>
                            <input
                                type="text"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="例如：可爱猫猫"
                                className="ui-input"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">备注（可选）</label>
                            <textarea
                                value={note}
                                onChange={e => setNote(e.target.value)}
                                placeholder="例如：由某某老师整理分享，目前还差 20 个表情待整理"
                                className="ui-input min-h-[88px] resize-y"
                                maxLength={STICKER_PACK_NOTE_MAX}
                                rows={3}
                            />
                        </div>

                        {characters.length > 0 && (
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">应用角色</label>
                                <div className="flex flex-wrap gap-2">
                                    {characters.map(c => (
                                        <button
                                            key={c.id}
                                            onClick={() => handleToggle(c.id)}
                                            className="ui-chip"
                                            {...(selectedCharIds.includes(c.id) ? { "data-selected": "" } : {})}
                                        >
                                            {c.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="ui-btn ui-btn-ghost" onClick={onCancel}>取消</button>
                    <button
                        className="ui-btn ui-btn-primary"
                        onClick={handleCreate}
                        disabled={!name.trim()}
                    >
                        创建
                    </button>
                </div>
            </div>
        </div>
    );
}

type StickerCardProps = {
    sticker: StickerItem;
    imageUrl?: string;
    isEditing: boolean;
    editingValue: string;
    onStartEdit: (sticker: StickerItem) => void;
    onEditingValueChange: (value: string) => void;
    onCommitName: (stickerId: string) => void;
    onRemove: (sticker: StickerItem) => Promise<void>;
};

const StickerCard = memo(function StickerCard({
    sticker,
    imageUrl,
    isEditing,
    editingValue,
    onStartEdit,
    onEditingValueChange,
    onCommitName,
    onRemove,
}: StickerCardProps) {
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [removing, setRemoving] = useState(false);

    const handleConfirmRemove = async () => {
        if (removing) return;
        setRemoving(true);
        try {
            await onRemove(sticker);
            setShowDeleteConfirm(false);
        } finally {
            setRemoving(false);
        }
    };

    return (
        <div className="flex flex-col items-center gap-2 relative group cursor-pointer">
            <div className="w-full aspect-square rounded-[20px] overflow-hidden bg-black/5 dark:bg-white/5 flex items-center justify-center relative p-1 transition-transform group-active:scale-95">
                {imageUrl ? (
                    <img src={imageUrl} alt={sticker.name} className="w-full h-full object-contain drop-shadow-sm" />
                ) : (
                    <span className="ts-12 font-medium text-[var(--c-text)] opacity-40">...</span>
                )}
                <button
                    type="button"
                    aria-label={`删除表情 ${sticker.name}`}
                    onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                    className="absolute top-1.5 right-1.5 w-6 h-6 bg-white/60 dark:bg-black/40 backdrop-blur-md rounded-full flex items-center justify-center text-[var(--c-danger)] opacity-100 transition-opacity z-10 shadow-sm"
                ><Trash2 size={12} /></button>
            </div>
            <div className="w-full px-1">
                {isEditing ? (
                    <input
                        className="ts-13 font-medium text-center text-[var(--c-text-title)] bg-transparent border-b-2 border-[var(--c-icon-active)] outline-none max-w-full p-0 w-full"
                        value={editingValue}
                        onChange={e => onEditingValueChange(e.target.value)}
                        onBlur={() => onCommitName(sticker.id)}
                        onKeyDown={e => { if (e.key === "Enter") onCommitName(sticker.id); }}
                        autoFocus
                        autoComplete="off"
                    />
                ) : (
                    <span
                        className="ts-13 text-[var(--c-text)] font-medium truncate w-full block text-center transition-colors hover:text-[var(--c-icon-active)] select-none"
                        onClick={() => onStartEdit(sticker)}
                    >{sticker.name}</span>
                )}
            </div>

            {showDeleteConfirm && createPortal(
                <ConfirmDialog
                    title="删除表情"
                    message="确定要删除这个表情吗？"
                    variant="danger"
                    confirmLabel={removing ? "删除中" : "删除"}
                    overlayClassName="sticker-delete-confirm-overlay"
                    dialogClassName="sticker-delete-confirm-dialog"
                    onConfirm={handleConfirmRemove}
                    onCancel={() => { if (!removing) setShowDeleteConfirm(false); }}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}
        </div>
    );
});

// ── Pack Editor (sub-page) ──

function PackEditor({ pack, onBack }: { pack: StickerPack; onBack: () => void }) {
    const characters = loadCharacters();
    const [currentPack, setCurrentPack] = useState(pack);
    const [urlMap, setUrlMap] = useState<Record<string, string>>({});
    const [assignedCharIds, setAssignedCharIds] = useState<string[]>([]);
    const [showAddDialog, setShowAddDialog] = useState(false);
    const [showBatchDialog, setShowBatchDialog] = useState(false);
    // 「添加」里认出合集后，把那张图转交给批量导入去拆（那边有逐个改名的列表）
    const [batchSeedFiles, setBatchSeedFiles] = useState<File[] | null>(null);
    const [packNameDraft, setPackNameDraft] = useState(pack.name);
    const [packNoteDraft, setPackNoteDraft] = useState(pack.note ?? "");
    // 改名进标题栏、备注默认折叠：把两块常驻编辑区收起来，别挤表情格子。
    // 交互设计来自社区 #149（V2），实现按当前存储层（updateStickerPackInfo）重接
    const [isEditingPackName, setIsEditingPackName] = useState(false);
    const [isNoteExpanded, setIsNoteExpanded] = useState(false);
    const [showNoteInfo, setShowNoteInfo] = useState(false);

    const refreshPack = useCallback(() => {
        const fresh = loadStickerPacks().find(p => p.id === pack.id);
        if (fresh) {
            setCurrentPack(fresh);
            resolvePackStickerMap(fresh).then((nameMap) => {
                const next: Record<string, string> = {};
                fresh.stickers.forEach(sticker => {
                    const url = nameMap[sticker.name];
                    if (url) next[sticker.id] = url;
                });
                setUrlMap(next);
            });
        }
    }, [pack.id]);

    const refreshAssignments = () => {
        setAssignedCharIds(getPackAssignments(pack.id));
    };

    useEffect(() => {
        refreshPack();
        refreshAssignments();
    }, [refreshPack]);

    const handleStickerAdded = () => {
        setShowAddDialog(false);
        refreshPack();
    };

    const [editingNameId, setEditingNameId] = useState<string | null>(null);
    const [editingNameValue, setEditingNameValue] = useState("");

    const handleStartNameEdit = useCallback((sticker: StickerItem) => {
        setEditingNameId(sticker.id);
        setEditingNameValue(sticker.name);
    }, []);

    const handleNameCommit = useCallback((stickerId: string) => {
        const trimmed = editingNameValue.trim();
        if (trimmed) {
            renameStickerInPack(pack.id, stickerId, trimmed);
            refreshPack();
        }
        setEditingNameId(null);
    }, [editingNameValue, pack.id, refreshPack]);

    const handleRemoveSticker = useCallback(async (sticker: StickerItem) => {
        await removeStickerFromPack(pack.id, sticker.id);
        setCurrentPack(prev => ({
            ...prev,
            stickers: prev.stickers.filter(item => item.id !== sticker.id),
        }));
        setUrlMap(prev => {
            if (!prev[sticker.id]) return prev;
            const next = { ...prev };
            delete next[sticker.id];
            return next;
        });
        if (editingNameId === sticker.id) {
            setEditingNameId(null);
            setEditingNameValue("");
        }
    }, [editingNameId, pack.id]);

    const handleToggleChar = (charId: string) => {
        togglePackAssignment(pack.id, charId);
        refreshAssignments();
    };

    const handlePackNameSave = () => {
        const trimmedName = packNameDraft.trim();
        if (!trimmedName) return;
        updateStickerPackInfo(pack.id, { name: trimmedName });
        setPackNameDraft(trimmedName);
        setIsEditingPackName(false);
        refreshPack();
    };

    const handleNoteSave = () => {
        const trimmedNote = packNoteDraft.trim();
        updateStickerPackInfo(pack.id, { note: trimmedNote });
        setPackNoteDraft(trimmedNote);
        refreshPack();
    };

    const noteChanged = packNoteDraft.trim() !== (currentPack.note ?? "");

    return (
        <PageShell
            title={isEditingPackName ? (
                <input
                    autoFocus
                    type="text"
                    value={packNameDraft}
                    maxLength={STICKER_PACK_NAME_MAX}
                    onChange={e => setPackNameDraft(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter") handlePackNameSave();
                        if (e.key === "Escape") {
                            setPackNameDraft(currentPack.name);
                            setIsEditingPackName(false);
                        }
                    }}
                    className="ui-input h-9 w-full min-w-0 px-2 text-center font-bold"
                    aria-label="图集名称"
                />
            ) : currentPack.name}
            onBack={onBack}
            rightAction={
                <button
                    type="button"
                    onClick={isEditingPackName ? handlePackNameSave : () => { setPackNameDraft(currentPack.name); setIsEditingPackName(true); }}
                    aria-label={isEditingPackName ? "保存图集名称" : "编辑图集名称"}
                    className="w-10 h-10 flex items-center justify-center rounded-full text-[var(--c-icon)] active:scale-95 transition-transform bg-transparent border-none cursor-pointer"
                >
                    {isEditingPackName ? <Check size={20} /> : <Pencil size={18} />}
                </button>
            }
            className="absolute inset-0 z-[100]"
        >
            <div className="flex flex-col h-full bg-[var(--c-page-body-bg)]">
                {/* 备注：默认折叠成一行，点开才出编辑区（改名挪去了标题栏的铅笔按钮） */}
                <div className="px-6 pt-4 pb-1 shrink-0">
                    <button
                        type="button"
                        onClick={() => setIsNoteExpanded(prev => !prev)}
                        aria-expanded={isNoteExpanded}
                        className="w-full flex items-center justify-between px-1 py-1.5 text-left text-[var(--c-text)] bg-transparent border-none cursor-pointer"
                    >
                        <span className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[calc(12px*var(--app-text-scale,1))] font-bold opacity-60 uppercase tracking-[0.1em] shrink-0">备注</span>
                            <span
                                role="button"
                                tabIndex={0}
                                onClick={(e) => { e.stopPropagation(); setShowNoteInfo(true); }}
                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setShowNoteInfo(true); } }}
                                className="flex items-center justify-center text-[var(--c-icon)] opacity-50 active:opacity-100 transition-opacity shrink-0"
                                aria-label="备注说明"
                            >
                                <Info size={14} />
                            </span>
                            {!isNoteExpanded && currentPack.note?.trim() ? (
                                <span className="ts-11 opacity-50 truncate">{currentPack.note.trim()}</span>
                            ) : null}
                        </span>
                        {isNoteExpanded ? <ChevronDown size={17} className="shrink-0" /> : <ChevronRight size={17} className="shrink-0" />}
                    </button>
                    {isNoteExpanded && (
                        <div className="flex flex-col gap-2 px-1 pt-1">
                            <textarea
                                value={packNoteDraft}
                                maxLength={STICKER_PACK_NOTE_MAX}
                                onChange={e => setPackNoteDraft(e.target.value)}
                                placeholder="备注这套表情包的来源、整理进度等（可选）"
                                className="ui-input min-h-[72px] resize-y"
                                rows={2}
                            />
                            <div className="flex items-center justify-between">
                                <span className="ts-11 text-[var(--c-text)] opacity-50">{packNoteDraft.length}/{STICKER_PACK_NOTE_MAX}</span>
                                <button type="button" onClick={handleNoteSave} disabled={!noteChanged} className="ui-btn ui-btn-primary ts-12">保存</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Character assignment section */}
                <div className="px-6 pt-4 pb-2 shrink-0">
                    <div className="text-[calc(12px*var(--app-text-scale,1))] font-bold text-[var(--c-text)] opacity-60 uppercase mb-3 px-1 tracking-[0.1em]">智能角色绑定</div>
                    <div className="flex flex-wrap gap-2.5 px-1">
                        {characters.map(c => {
                            const active = assignedCharIds.includes(c.id);
                            return (
                                <button
                                    key={c.id}
                                    onClick={() => handleToggleChar(c.id)}
                                    className="ui-chip"
                                    {...(active ? { "data-selected": "" } : {})}
                                >
                                    {c.name}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Sticker grid canvas */}
                <div className="flex-1 mt-4 bg-[var(--c-card)] rounded-t-[32px] p-6 shadow-[0_-8px_32px_rgba(0,0,0,0.02)] border-t border-[var(--c-card-border)]/30 min-h-0 overflow-y-auto">
                    <div className="flex items-center justify-between mb-5 px-1">
                        <div className="text-[calc(18px*var(--app-text-scale,1))] font-bold text-[var(--c-text-title)]">表情库 <span className="text-[var(--c-text)] opacity-50 font-medium ml-1 text-base">{currentPack.stickers.length}</span></div>
                        <button
                            type="button"
                            onClick={() => { setBatchSeedFiles(null); setShowBatchDialog(true); }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full ts-12 font-semibold active:scale-95 transition-transform"
                            style={{ background: "color-mix(in srgb, var(--c-icon-active) 12%, transparent)", color: "var(--c-icon-active)" }}
                        >
                            <Layers size={14} /> 批量导入
                        </button>
                    </div>
                    
                    <div className="grid grid-cols-3 gap-x-4 gap-y-6 pb-20">
                        {currentPack.stickers.map(s => (
                            <StickerCard
                                key={s.id}
                                sticker={s}
                                imageUrl={urlMap[s.id]}
                                isEditing={editingNameId === s.id}
                                editingValue={editingNameValue}
                                onStartEdit={handleStartNameEdit}
                                onEditingValueChange={setEditingNameValue}
                                onCommitName={handleNameCommit}
                                onRemove={handleRemoveSticker}
                            />
                        ))}
                        {/* Add tile */}
                        <div className="flex flex-col items-center">
                            <button
                                onClick={() => setShowAddDialog(true)}
                                className="w-full aspect-square rounded-[20px] bg-transparent border-[1.5px] border-dashed border-[var(--c-icon)]/30 flex flex-col items-center justify-center gap-1.5 text-[var(--c-icon)] cursor-pointer opacity-80 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition-all active:scale-95"
                            >
                                <Plus size={26} strokeWidth={2}/>
                                <span className="ts-11 font-medium">添加</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {showAddDialog && createPortal(
                <AddStickerDialog
                    packId={pack.id}
                    onDone={handleStickerAdded}
                    onCancel={() => setShowAddDialog(false)}
                    onSheetDetected={(file) => {
                        setShowAddDialog(false);
                        setBatchSeedFiles([file]);
                        setShowBatchDialog(true);
                    }}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}

            {showBatchDialog && createPortal(
                <BatchAddStickerDialog
                    packId={pack.id}
                    seedFiles={batchSeedFiles}
                    onDone={() => { setShowBatchDialog(false); setBatchSeedFiles(null); refreshPack(); }}
                    onCancel={() => { setShowBatchDialog(false); setBatchSeedFiles(null); }}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}

            {showNoteInfo && createPortal(
                <ConfirmDialog
                    title="备注说明"
                    message="备注仅供自己整理使用，不会进入提示词——角色和助手小卷都看不到。"
                    confirmLabel="我知道了"
                    cancelLabel=""
                    onConfirm={() => setShowNoteInfo(false)}
                    onCancel={() => setShowNoteInfo(false)}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}

        </PageShell>
    );
}

// ── Add Sticker Dialog ──

function AddStickerDialog({
    packId,
    onDone,
    onCancel,
    onSheetDetected,
}: {
    packId: string;
    onDone: () => void;
    onCancel: () => void;
    /** 认出这是「合集图」（一张图里好几个表情）时，交给批量导入去拆 */
    onSheetDetected?: (file: File) => void;
}) {
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [previewSrc, setPreviewSrc] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [fileError, setFileError] = useState<string | null>(null);
    const selectedFile = useRef<File | null>(null);
    // 选中的图被认出是合集时，这里存识别结果，给用户一个「拆开导入」的入口
    const [sheet, setSheet] = useState<{ file: File; cols: number; rows: number; count: number } | null>(null);
    // PNG 隐藏清单解码（酒馆式表情包）识别结果
    const [packDetect, setPackDetect] = useState<{ file: File; count: number } | null>(null);
    const detectToken = useRef(0);

    const hasImage = !!previewSrc;
    const canSubmit = !!name.trim() && hasImage && !fileError;

    const handleFileChange = () => {
        const f = fileInputRef.current?.files?.[0];
        if (!f) return;
        const err = checkStickerBlob(f);
        setFileError(err);
        if (err) {
            selectedFile.current = null;
            setPreviewSrc(null);
            setSheet(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }
        selectedFile.current = f;
        setUrl("");
        setSheet(null);
        setPackDetect(null);
        const reader = new FileReader();
        reader.onload = () => setPreviewSrc(reader.result as string);
        reader.readAsDataURL(f);
        // 顺手认一下是不是表情包合集（本地分析，不联网不花 token）
        if (isPngFile(f)) {
            // ① 先看 PNG 隐藏清单（酒馆式：表情清单写在元数据里）
            const token = ++detectToken.current;
            void (async () => {
                let pack: StickerPackDecode | null = null;
                try { pack = await decodeStickerPackPng(f); } catch { pack = null; }
                if (token !== detectToken.current) return;
                if (pack && pack.entries.length >= 2) {
                    setPackDetect({ file: f, count: pack.entries.length });
                    return;
                }
                // ② 再看像素网格（普通拼图）
                let split: StickerSheetSplit | null = null;
                try { split = await splitStickerSheet(f); } catch { split = null; }
                if (token !== detectToken.current) return;
                if (split && split.tiles.length >= 2) {
                    setSheet({ file: f, cols: split.cols, rows: split.rows, count: split.tiles.length });
                }
            })();
        } else if (f.type !== "image/gif") {
            // 非 PNG：只做像素网格识别
            const token = ++detectToken.current;
            void (async () => {
                let split: StickerSheetSplit | null = null;
                try { split = await splitStickerSheet(f); } catch { split = null; }
                if (token !== detectToken.current) return;
                if (split && split.tiles.length >= 2) {
                    setSheet({ file: f, cols: split.cols, rows: split.rows, count: split.tiles.length });
                }
            })();
        }
    };

    const handleUrlBlur = () => {
        const trimmed = url.trim();
        if (trimmed) {
            selectedFile.current = null;
            setFileError(null);
            setSheet(null);
            detectToken.current++;
            if (fileInputRef.current) fileInputRef.current.value = "";
            setPreviewSrc(trimmed);
        }
    };

    const handleAdd = async () => {
        if (!canSubmit || adding) return;
        setAdding(true);
        if (selectedFile.current) {
            try {
                await addStickerToPack(packId, name.trim(), selectedFile.current);
            } catch {
                setFileError("添加失败，请换一张图片重试");
                setAdding(false);
                return;
            }
        } else if (url.trim()) {
            addStickerByUrlToPack(packId, name.trim(), url.trim());
        }
        onDone();
    };

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onCancel}>
            <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3 className="modal-title">添加表情</h3>
                </div>

                <div className="modal-body">
                    <div className="flex flex-col gap-4 text-left w-full">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">名称</label>
                            <input
                                type="text"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="AI会用此名称发送表情"
                                className="ui-input"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">图片URL</label>
                            <input
                                type="text"
                                value={url}
                                onChange={e => setUrl(e.target.value)}
                                onBlur={handleUrlBlur}
                                placeholder="输入图片URL"
                                className="ui-input"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={handleFileChange}
                            />
                            {previewSrc ? (
                                <div
                                    className="w-full h-[120px] rounded-[var(--ui-radius)] border border-[var(--c-input-border)] bg-[var(--c-input)] flex items-center justify-center cursor-pointer"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <img src={previewSrc} alt="preview" className="max-w-full max-h-full object-contain" />
                                </div>
                            ) : (
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    className="w-full h-[120px] rounded-[var(--ui-radius)] border border-dashed border-[var(--c-input-border)] bg-[var(--c-input)] flex flex-col items-center justify-center gap-2 text-[var(--c-icon)] cursor-pointer"
                                >
                                    <ImagePlus size={28} />
                                    <span className="ts-13">选择图片</span>
                                </button>
                            )}
                            {fileError && <span className="ts-11 ml-1" style={{ color: "var(--c-danger)" }}>{fileError}</span>}
                            {sheet && onSheetDetected && (
                                <div
                                    className="flex flex-col gap-2 rounded-[var(--ui-radius)] px-3 py-2.5 mt-1"
                                    style={{ background: "color-mix(in srgb, var(--c-icon-active) 10%, transparent)" }}
                                >
                                    <span className="ts-12" style={{ color: "var(--c-text)" }}>
                                        这张是合集图（识别到 {sheet.rows} 行 × {sheet.cols} 列，共 {sheet.count} 个表情）。
                                    </span>
                                    <button
                                        type="button"
                                        className="ui-btn ui-btn-primary ts-12 self-start"
                                        onClick={() => onSheetDetected(sheet.file)}
                                    >拆成 {sheet.count} 个表情</button>
                                </div>
                            )}
                            {packDetect && onSheetDetected && (
                                <div
                                    className="flex flex-col gap-2 rounded-[var(--ui-radius)] px-3 py-2.5 mt-1"
                                    style={{ background: "color-mix(in srgb, var(--c-icon-active) 10%, transparent)" }}
                                >
                                    <span className="ts-12" style={{ color: "var(--c-text)" }}>
                                        这张是表情包合集（PNG 里带了 {packDetect.count} 个表情的清单，含各自名字）。
                                    </span>
                                    <button
                                        type="button"
                                        className="ui-btn ui-btn-primary ts-12 self-start"
                                        onClick={() => onSheetDetected(packDetect.file)}
                                    >解码成 {packDetect.count} 个表情</button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="ui-btn ui-btn-ghost" onClick={onCancel}>取消</button>
                    <button
                        className="ui-btn ui-btn-primary"
                        onClick={handleAdd}
                        disabled={!canSubmit || adding}
                    >
                        添加
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Batch Add Sticker Dialog（一屏列表 + 逐个改名 + 查重）──

type BatchRow = {
    id: string;
    /** file / sheet / pack 都带本地图片；url 走外链 */
    source: "file" | "url" | "sheet" | "pack";
    /** 本地图片（整张上传，或从合集图里切出来的一块，或从 PNG 清单解码出的一张） */
    blob?: Blob;
    /** 来源文件名（用于「用来源命名」） */
    fileName?: string;
    url: string;
    name: string;
    /** 来自合集拆分时的出处（第几块 / 共几块） */
    sheet?: { index: number; total: number };
    /** 来自 PNG 隐藏清单解码（酒馆式表情包）时的出处 */
    pack?: { index: number; total: number };
};

const BATCH_STICKER_URL_RE = /https?:\/\/[^\s，。；;]+/i;

function getStickerBaseName(filename: string): string {
    return filename.replace(/\.[^.]+$/, "").trim() || "表情";
}

/** PNG 判定：有些系统不给 file.type，靠扩展名兜底 */
function isPngFile(file: File): boolean {
    return file.type === "image/png" || /\.png$/i.test(file.name);
}

function normalizeBatchStickerUrl(rawUrl: string): string | null {
    const cleaned = rawUrl.trim().replace(/[，。；;]+$/g, "");
    try {
        const parsed = new URL(cleaned);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

function getStickerNameFromUrl(url: string, index: number): string {
    try {
        const pathName = new URL(url).pathname;
        const filename = decodeURIComponent(pathName.split("/").filter(Boolean).pop() || "");
        return getStickerBaseName(filename) || `表情${index + 1}`;
    } catch {
        return `表情${index + 1}`;
    }
}

function parseBatchStickerUrlRows(text: string): Array<{ name: string; url: string }> {
    return text
        .split(/\r?\n/)
        .map((line, index) => {
            const trimmed = line.trim();
            if (!trimmed) return null;
            const match = trimmed.match(BATCH_STICKER_URL_RE);
            if (!match || match.index === undefined) return null;
            const url = normalizeBatchStickerUrl(match[0]);
            if (!url) return null;
            const label = trimmed.slice(0, match.index).trim().replace(/[:：\s]+$/g, "");
            return {
                name: label || getStickerNameFromUrl(url, index),
                url,
            };
        })
        .filter((row): row is { name: string; url: string } => Boolean(row));
}

function BatchAddStickerDialog({
    packId,
    seedFiles,
    onDone,
    onCancel,
}: {
    packId: string;
    /** 从「添加」入口认出合集后转过来的文件：打开时直接进列表 */
    seedFiles?: File[] | null;
    onDone: () => void;
    onCancel: () => void;
}) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [rows, setRows] = useState<BatchRow[]>([]);
    const [urlText, setUrlText] = useState("");
    const [urlError, setUrlError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [progress, setProgress] = useState(0);
    // 合集图（一张图里排着好几个表情）自动拆开；认错了可以关掉
    const [autoSplit, setAutoSplit] = useState(true);
    const [detecting, setDetecting] = useState(false);
    const [sheetNotice, setSheetNotice] = useState<string | null>(null);

    // 该组已有的表情名（用于查重）、该组名字（拆开的块按它起名）、
    // 已创建的 objectURL（卸载时统一释放）
    const existingNames = useRef<Set<string>>(new Set());
    const packNameRef = useRef("表情");
    const urlsRef = useRef<string[]>([]);
    useEffect(() => {
        const p = loadStickerPacks().find(x => x.id === packId);
        existingNames.current = new Set((p?.stickers ?? []).map(s => s.name.trim().toLowerCase()));
        packNameRef.current = p?.name?.trim() || "表情";
    }, [packId]);
    useEffect(() => () => { urlsRef.current.forEach(u => URL.revokeObjectURL(u)); }, []);

    /**
     * 收图：逐张先试着当「合集图」认一次（本地像素分析，不联网不花 token）。
     * 认出来就拆成 N 行（各自可单独改名字），认不出就按单张进列表。
     */
    const addFiles = async (files: FileList | File[] | null) => {
        if (!files) return;
        const imgs = Array.from(files).filter(f => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name));
        if (!imgs.length) return;
        setDetecting(true);
        const next: BatchRow[] = [];
        let sheetCount = 0;
        let pieceCount = 0;
        let packCount = 0;
        let packPieceCount = 0;
        const packNames: string[] = [];
        for (let i = 0; i < imgs.length; i++) {
            const file = imgs[i];
            const base = getStickerBaseName(file.name);
            // ① 优先：PNG 隐藏清单解码（酒馆式表情包，元数据里写好了每张的名字/图）
            let pack: StickerPackDecode | null = null;
            if (autoSplit && isPngFile(file)) {
                try { pack = await decodeStickerPackPng(file); } catch { pack = null; }
            }
            if (pack && pack.entries.length >= 2) {
                packCount++;
                packPieceCount += pack.entries.length;
                if (pack.packName) packNames.push(pack.packName);
                pack.entries.forEach((entry, k) => {
                    const url = URL.createObjectURL(entry.blob);
                    urlsRef.current.push(url);
                    next.push({
                        id: `pack_${Date.now()}_${i}_${k}_${Math.random().toString(36).slice(2, 5)}`,
                        source: "pack",
                        blob: entry.blob,
                        fileName: file.name,
                        url,
                        name: entry.name || `${base}${k + 1}`,
                        pack: { index: k + 1, total: pack.entries.length },
                    });
                });
                continue;
            }
            // ② 兜底：纯像素网格识别（普通拼图且没元数据的合集图）
            let split: StickerSheetSplit | null = null;
            if (autoSplit && file.type !== "image/gif") {
                try { split = await splitStickerSheet(file); } catch { split = null; }
            }
            if (split && split.tiles.length >= 2) {
                sheetCount++;
                pieceCount += split.tiles.length;
                // 文件名没信息量（剪贴板/截图那种）时改用图集名做前缀
                const prefix = isGenericImageName(file.name) ? packNameRef.current : base;
                const names = buildSheetStickerNames(prefix, split.tiles.length);
                split.tiles.forEach((blob, k) => {
                    const url = URL.createObjectURL(blob);
                    urlsRef.current.push(url);
                    next.push({
                        id: `sheet_${Date.now()}_${i}_${k}_${Math.random().toString(36).slice(2, 5)}`,
                        source: "sheet",
                        blob,
                        fileName: file.name,
                        url,
                        name: names[k],
                        sheet: { index: k + 1, total: split.tiles.length },
                    });
                });
                continue;
            }
            const url = URL.createObjectURL(file);
            urlsRef.current.push(url);
            next.push({
                id: `row_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
                source: "file",
                blob: file,
                fileName: file.name,
                url,
                name: base,
            });
        }
        setRows(prev => [...prev, ...next]);
        const parts: string[] = [];
        if (packCount > 0) {
            const label = packNames.length ? `「${packNames.slice(0, 3).join("」「")}」` : "";
            parts.push(`PNG 表情包${label} 解码出 ${packPieceCount} 张（名字取自图内清单）`);
        }
        if (sheetCount > 0) parts.push(`${sheetCount} 张合集图（拆成 ${pieceCount} 个表情）`);
        setSheetNotice(parts.length ? `已识别并导入：${parts.join("；")}（名称可逐个改）` : null);
        setDetecting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    // 「添加」入口认出合集后转过来的文件：打开时灌进来（只灌一次）
    const seededRef = useRef(false);
    useEffect(() => {
        if (seededRef.current) return;
        seededRef.current = true;
        if (seedFiles?.length) void addFiles(seedFiles);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seedFiles]);

    const addUrls = () => {
        const parsed = parseBatchStickerUrlRows(urlText);
        if (parsed.length === 0) {
            setUrlError("没有识别到可用的图片URL");
            return;
        }
        setRows(prev => [
            ...prev,
            ...parsed.map((row, i) => ({
                id: `urlrow_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
                source: "url" as const,
                url: row.url,
                name: row.name,
            })),
        ]);
        setUrlText("");
        setUrlError(null);
    };

    const setRowName = (id: string, name: string) => setRows(prev => prev.map(r => r.id === id ? { ...r, name } : r));
    const removeRow = (id: string) => setRows(prev => prev.filter(r => r.id !== id));
    const resetToFilenames = () => setRows(prev => prev.map((r, i) => {
        if (r.source === "url") return { ...r, name: getStickerNameFromUrl(r.url, i) };
        const base = getStickerBaseName(r.fileName || "");
        if (r.source === "sheet" && r.sheet) return { ...r, name: `${base}${r.sheet.index}` };
        if (r.source === "pack" && r.pack) return r; // 清单里自带名字，原样保留
        return { ...r, name: base };
    }));
    const numberNames = () => setRows(prev => prev.map((r, i) => ({ ...r, name: `表情${i + 1}` })));

    // 名称查重：本批内 + 与已有表情
    const nameCounts = useMemo(() => {
        const m = new Map<string, number>();
        rows.forEach(r => { const k = r.name.trim().toLowerCase(); if (k) m.set(k, (m.get(k) ?? 0) + 1); });
        return m;
    }, [rows]);

    const rowError = (r: BatchRow): string | null => {
        const t = r.name.trim();
        if (!t) return "名称不能为空";
        const k = t.toLowerCase();
        if (existingNames.current.has(k)) return "与已有表情重名";
        if ((nameCounts.get(k) ?? 0) > 1) return "本批重名";
        if (r.blob) return checkStickerBlob(r.blob);
        return null;
    };

    const readyCount = rows.filter(r => !rowError(r)).length;
    const allValid = rows.length > 0 && readyCount === rows.length;

    const handleSubmit = async () => {
        if (!allValid || adding) return;
        setAdding(true);
        setProgress(0);
        const blobRows = rows.filter((r): r is BatchRow & { blob: Blob } => r.source !== "url" && Boolean(r.blob));
        const urlRows = rows.filter(r => r.source === "url");
        const total = rows.length;
        if (blobRows.length > 0) {
            await addStickersToPack(
                packId,
                blobRows.map(r => ({ name: r.name.trim(), blob: r.blob })),
                (done) => setProgress(Math.round((done / total) * 100)),
            );
        }
        urlRows.forEach((row, i) => {
            addStickerByUrlToPack(packId, row.name.trim(), row.url);
            setProgress(Math.round(((blobRows.length + i + 1) / total) * 100));
        });
        setAdding(false);
        onDone();
    };

    return (
        <div className="modal-overlay sticker-batch-import-overlay" data-ui="modal" onClick={adding ? undefined : onCancel}>
            <div className="modal-dialog sticker-batch-import-dialog" onClick={e => e.stopPropagation()} style={{ width: "min(440px, 92vw)" }}>
                <div className="modal-header">
                    <h3 className="modal-title">批量添加表情{rows.length > 0 ? ` · ${rows.length}` : ""}</h3>
                </div>

                <div className="modal-body">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={e => addFiles(e.target.files)}
                    />

                    <div className="flex flex-col gap-3 text-left w-full">
                        {rows.length === 0 && (
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="w-full h-[118px] rounded-[var(--ui-radius)] border border-dashed border-[var(--c-input-border)] bg-[var(--c-input)] flex flex-col items-center justify-center gap-2 text-[var(--c-icon)] cursor-pointer"
                            >
                                <ImagePlus size={30} />
                                <span className="ts-13 font-medium">选择多张图片</span>
                                <span className="ts-11 opacity-60">合集图会自动拆成一个个表情</span>
                            </button>
                        )}

                        <div className="flex items-center flex-wrap gap-2">
                            {rows.length > 0 && (
                                <>
                                    <button className="ui-chip" onClick={() => fileInputRef.current?.click()} disabled={detecting}>+ 继续选择</button>
                                    <button className="ui-chip" onClick={resetToFilenames}>用来源命名</button>
                                    <button className="ui-chip" onClick={numberNames}>按序号</button>
                                </>
                            )}
                            <button
                                type="button"
                                className="ui-chip"
                                {...(autoSplit ? { "data-selected": "" } : {})}
                                onClick={() => setAutoSplit(v => !v)}
                                title="自动拆开合集：带清单的 PNG 表情包会按清单解码（保留各自名字），普通拼图会按位置切成一个个表情"
                            >合集自动拆分</button>
                            {detecting && <span className="ts-11 opacity-60">识别中…</span>}
                        </div>
                        {sheetNotice && (
                            <span className="ts-11 ml-1" style={{ color: "var(--c-icon-active)" }}>{sheetNotice}</span>
                        )}

                        <div className="flex flex-col gap-1.5">
                            <label className="menu-desc ml-1">批量URL</label>
                            <textarea
                                value={urlText}
                                onChange={e => { setUrlText(e.target.value); setUrlError(null); }}
                                placeholder={"贴贴：https://example.com/a.jpg\n可爱 https://example.com/b.gif"}
                                className="ui-input"
                                rows={4}
                                style={{ resize: "vertical", minHeight: 88 }}
                            />
                            <div className="flex items-center justify-between gap-2">
                                <span className="ts-11 opacity-60">每行一个，支持“名称：URL”或“名称 URL”</span>
                                <button type="button" className="ui-chip" onClick={addUrls} disabled={adding || !urlText.trim()}>添加URL</button>
                            </div>
                            {urlError && <span className="ts-11 ml-1" style={{ color: "var(--c-danger)" }}>{urlError}</span>}
                        </div>

                        {rows.length > 0 ? (
                            <div className="flex flex-col gap-2 max-h-[36vh] overflow-y-auto pr-1 -mr-1">
                                {rows.map(r => {
                                    const err = rowError(r);
                                    return (
                                        <div key={r.id} className="flex items-center gap-3">
                                            <div className="w-12 h-12 shrink-0 rounded-xl overflow-hidden bg-black/5 dark:bg-white/10 flex items-center justify-center">
                                                <img src={r.url} alt="" className="w-full h-full object-contain" />
                                            </div>
                                            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                                <input
                                                    className="ui-input"
                                                    style={err ? { borderColor: "var(--c-danger)" } : undefined}
                                                    value={r.name}
                                                    onChange={e => setRowName(r.id, e.target.value)}
                                                    onFocus={e => e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" })}
                                                    placeholder="表情名称"
                                                    autoComplete="off"
                                                />
                                                <span className="ts-11 ml-1" style={{ color: err ? "var(--c-danger)" : "var(--c-text)" }}>
                                                    {err || (r.source === "url"
                                                        ? "URL图片"
                                                        : r.source === "pack" && r.pack
                                                            ? `PNG清单解码 · 第 ${r.pack.index}/${r.pack.total} 张`
                                                            : r.source === "sheet" && r.sheet
                                                                ? `合集拆分 · 第 ${r.sheet.index}/${r.sheet.total} 块`
                                                                : "本地图片")}
                                                </span>
                                            </div>
                                            <button
                                                type="button"
                                                aria-label="移除"
                                                onClick={() => removeRow(r.id)}
                                                className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-[var(--c-danger)] bg-black/5 dark:bg-white/10"
                                            ><Trash2 size={14} /></button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="ui-btn ui-btn-ghost" onClick={onCancel} disabled={adding}>取消</button>
                    <button
                        className="ui-btn ui-btn-primary"
                        onClick={handleSubmit}
                        disabled={!allValid || adding}
                    >
                        {adding ? `添加中 ${progress}%` : rows.length > 0 ? `全部添加 (${readyCount}/${rows.length})` : "全部添加"}
                    </button>
                </div>
            </div>
        </div>
    );
}
