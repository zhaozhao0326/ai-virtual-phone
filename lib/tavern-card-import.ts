// lib/tavern-card-import.ts
// 角色卡（酒馆 V2/V3，PNG 内嵌或 JSON 文本）里「世界书 + 正则 + 预设」的落库与绑定。
// 只做落库与接线，解析规则全部在 tavern-card-parse.ts（纯函数，两侧共用）。

import { readPngTextChunk } from "./character-storage";
import {
    createRegexGroup,
    createWorldBook,
    loadRegexes,
    loadWorldBooks,
    loadBindingConfig,
    parseRegexFromJson,
    parsePresetFromJson,
    saveBindingConfig,
    saveRegexes,
    saveWorldBooks,
    savePresets,
    loadPresets,
    UNSUPPORTED_IMPORT_FORMAT,
    getCharacterBinding,
    setCharacterBinding,
} from "./settings-storage";
import type { BindingSlot, PresetConfig, RegexConfig, WorldBookConfig, WorldBookEntry } from "./settings-types";
import {
    collectTavernRegexScripts,
    countPresetPrompts,
    describeCategories,
    extractTavernCategoryPath,
    findTavernPresetObject,
    makeTavernId,
    parseTavernWorldBook,
    unwrapTavernCard,
    type TavernCardSource,
    type TavernParsedBook,
} from "./tavern-card-parse";

/** 卡里除了角色本体之外，还带进来了什么东西（给导入提示用） */
export type CardExtrasImport = {
    books: WorldBookConfig[];
    regex: RegexConfig | null;
    preset: PresetConfig | null;
    stats: TavernParsedBook["stats"] & {
        books: number;
        regexRules: number;
        presetPrompts: number;
        presetSkipped: boolean;
    };
    notice: string;
};

function decodeCardJson(base64: string): unknown | null {
    try {
        const jsonStr = decodeURIComponent(escape(atob(base64.trim())));
        return JSON.parse(jsonStr);
    } catch {
        return null;
    }
}

export function readTavernCardFromJsonText(text: string): TavernCardSource | null {
    try {
        return unwrapTavernCard(JSON.parse(text));
    } catch {
        return null;
    }
}

/** PNG 卡：先找 ccv3（V3），再找 chara（V2） */
export function readTavernCardFromPng(buffer: ArrayBuffer): TavernCardSource | null {
    const u8 = new Uint8Array(buffer);
    for (const keyword of ["ccv3", "chara"]) {
        const raw = readPngTextChunk(u8, keyword);
        if (!raw) continue;
        const parsed = decodeCardJson(raw);
        if (parsed) return unwrapTavernCard(parsed);
    }
    return null;
}

/**
 * 把卡里的世界书 / 正则 / 预设落库，并把世界书与正则绑定到该角色。
 * 预设**不自动绑定**：它会整体接管提示词结构，交给用户在「配置绑定」里决定要不要用。
 */
export function importCardExtras(
    source: TavernCardSource | null,
    charName: string,
    characterId: string
): CardExtrasImport | null {
    if (!source) return null;

    const parsedBook = parseTavernWorldBook(source.data, charName);
    const rules = collectTavernRegexScripts(source.root, source.data);
    const presetHit = findTavernPresetObject(source.root, source.data, charName);

    if (!parsedBook && !rules.length && !presetHit) return null;

    // ── 世界书：一个分类一本 ──
    const books: WorldBookConfig[] = [];
    if (parsedBook) {
        for (const group of parsedBook.groups) {
            const book = createWorldBook(
                group.category ? `${parsedBook.bookName}·${group.category}` : parsedBook.bookName
            );
            book.description = group.category
                ? `从角色卡导入，分类「${group.category}」，共 ${group.entries.length} 条`
                : `从角色卡导入，共 ${group.entries.length} 条`;
            book.entries = group.entries;
            books.push(book);
        }
    }
    if (books.length) {
        saveWorldBooks([...books, ...loadWorldBooks()]);
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("settings-worldbooks-updated"));
        }
    }

    // ── 正则脚本 → 正则组 ──
    let regex: RegexConfig | null = null;
    if (rules.length) {
        try {
            regex = parseRegexFromJson(
                JSON.stringify({ name: `${charName}·正则`, rules }),
                `${charName}·正则`
            );
        } catch {
            regex = null;
        }
        if (!regex) {
            regex = createRegexGroup(`${charName}·正则`);
            regex.rules = rules;
        }
        saveRegexes([regex, ...loadRegexes()]);
    }

    // ── 预设：能认出来就导入，认不出来就跳过，绝不拦下整次导入 ──
    let preset: PresetConfig | null = null;
    let presetPrompts = 0;
    let presetSkipped = false;
    if (presetHit) {
        try {
            preset = parsePresetFromJson(JSON.stringify(presetHit.obj), presetHit.name);
        } catch (e) {
            if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) presetSkipped = true;
            preset = null;
        }
        if (preset) {
            presetPrompts = countPresetPrompts(presetHit.obj).enabled;
            savePresets([preset, ...loadPresets()]);
        }
    }

    // ── 绑定：世界书 + 正则跟着这张卡走；预设留给用户手动启用 ──
    let bound = false;
    try {
        const bc = loadBindingConfig();
        const cb = getCharacterBinding(bc, characterId);
        const prevBooks = cb.defaults.worldBookIds || [];
        const nextBooks = [...prevBooks, ...books.map((b) => b.id).filter((id) => !prevBooks.includes(id))];
        const prevRegex = cb.defaults.regexIds || [];
        const nextRegex = regex && !prevRegex.includes(regex.id) ? [...prevRegex, regex.id] : prevRegex;
        if (nextBooks.length !== prevBooks.length || nextRegex.length !== prevRegex.length) {
            cb.defaults = { ...cb.defaults, worldBookIds: nextBooks, regexIds: nextRegex };
            saveBindingConfig(setCharacterBinding(bc, cb));
            bound = true;
        }
    } catch (e) {
        console.error("Failed to bind card extras to character", e);
    }

    const stats = {
        ...(parsedBook?.stats ?? {
            entries: 0,
            constant: 0,
            autoKeyed: 0,
            forcedConstant: 0,
            disabled: 0,
            megaSplit: false,
            categories: [] as string[],
        }),
        books: books.length,
        regexRules: regex?.rules.length ?? 0,
        presetPrompts,
        presetSkipped,
    };

    const parts: string[] = [];
    if (books.length) {
        parts.push(
            `世界书 ${books.length} 本 / ${stats.entries} 条（${describeCategories(stats.categories)}）`
        );
    }
    if (stats.regexRules) parts.push(`正则 ${stats.regexRules} 条`);
    if (preset) parts.push(`预设 1 份（${presetPrompts} 项，未自动启用）`);
    if (presetSkipped) parts.push("预设格式不兼容已跳过");

    const suffix: string[] = [];
    if (stats.forcedConstant) suffix.push(`${stats.forcedConstant} 条无触发词已设为常驻`);
    if (stats.constant > 40) suffix.push(`常驻 ${stats.constant} 条，注意 token`);
    if (!bound) suffix.push("可在「配置绑定」确认");

    const notice = parts.length
        ? `，${parts.join("；")}${suffix.length ? `（${suffix.join("；")}）` : ""}`
        : "";

    return { books, regex, preset, stats, notice };
}

// ── 已导入的旧世界书：按分类重新拆分 ──────────────────
// 这次改动之前导入的卡，整本世界书都挤在一册里。这里给它们一个补救入口：
// 按条目自带的 category（新导入的书有）或标题里的分类前缀（老书只剩 comment）重新分组，
// 拆成多本并接管原书的绑定关系；条目内容一条不少，只是换个地方放。

export type ResplitResult = {
    books: WorldBookConfig[];
    categories: string[];
    entries: number;
};

function migrateSlot(slot: BindingSlot | undefined, fromId: string, toIds: string[]): BindingSlot | undefined {
    if (!slot?.worldBookIds?.includes(fromId)) return slot;
    const merged = [...slot.worldBookIds.filter((id) => id !== fromId), ...toIds];
    return { ...slot, worldBookIds: [...new Set(merged)] };
}

export function resplitWorldBookByCategory(bookId: string): ResplitResult | null {
    const books = loadWorldBooks();
    const target = books.find((b) => b.id === bookId);
    if (!target || !target.entries?.length) return null;

    const groups = new Map<string, WorldBookEntry[]>();
    const order: string[] = [];
    for (const entry of target.entries) {
        const path = extractTavernCategoryPath({ category: entry.category, comment: entry.comment });
        const key = path.join("/");
        if (!groups.has(key)) {
            groups.set(key, []);
            order.push(key);
        }
        groups.get(key)!.push(entry);
    }
    // 只有一个分组 = 拆不出东西，别白折腾
    if (order.length <= 1) return null;

    const created: WorldBookConfig[] = [];
    for (const key of order) {
        const entries = groups.get(key)!;
        const book = createWorldBook(key ? `${target.name}·${key}` : target.name);
        book.description = `按分类拆分自「${target.name}」${key ? `，分类：${key}` : ""}，共 ${entries.length} 条`;
        book.entries = entries.map((e) => ({ ...e, uid: makeTavernId("wb-entry"), category: key || undefined }));
        created.push(book);
    }

    saveWorldBooks([...created, ...books.filter((b) => b.id !== bookId)]);

    // 绑定关系整体迁移：原书在哪，拆分后的几本就在哪
    try {
        const newIds = created.map((b) => b.id);
        const bc = loadBindingConfig();
        bc.globalDefaults = migrateSlot(bc.globalDefaults, bookId, newIds) ?? bc.globalDefaults;
        if (bc.appDefaults) {
            for (const [key, slot] of Object.entries(bc.appDefaults)) {
                const next = migrateSlot(slot, bookId, newIds);
                if (next) bc.appDefaults[key] = next;
            }
        }
        if (bc.worldBindings) {
            for (const [key, slot] of Object.entries(bc.worldBindings)) {
                const next = migrateSlot(slot, bookId, newIds);
                if (next) bc.worldBindings[key] = next;
            }
        }
        for (const cb of bc.characterBindings ?? []) {
            cb.defaults = migrateSlot(cb.defaults, bookId, newIds) ?? cb.defaults;
            if (cb.appOverrides) {
                for (const [key, slot] of Object.entries(cb.appOverrides)) {
                    const next = migrateSlot(slot, bookId, newIds);
                    if (next) cb.appOverrides[key] = next;
                }
            }
        }
        saveBindingConfig(bc);
    } catch (e) {
        console.error("Failed to migrate world book bindings after resplit", e);
    }

    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("settings-worldbooks-updated"));
    }

    return {
        books: created,
        categories: order.filter(Boolean),
        entries: target.entries.length,
    };
}
