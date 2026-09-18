// 世界书 JSON 上传的格式兼容层（加性模块：不修改任何既有解析行为）。
//
// 背景：从角色卡导入时，卡里内嵌的 world book（character_book）会走酒馆解析器落库，能用；
// 但在「设置 → 世界书 → 导入世界书 (JSON)」这里，过去只认本应用自己导出的格式——
// 一旦 entries 是字典形态（{"0": {...}}），或条目带着酒馆痕迹字段
// （selectiveLogic / secondary_keys / extensions / characterFilter），
// 就会被直接判为「不支持该世界书格式」而拒收。
// 于是同一本书：夹在角色卡里能进，单独上传却进不来。
//
// 这里只补这一件事：先按本应用格式原样接受；不行再交给酒馆解析器
// （与「从角色卡导入」完全同一个解析器，所以解析结果一致）。
// 一个文件 = 一本世界书，分类保留在每条条目的 category 上；
// 「按分类拆成多本」是角色卡导入那条路的行为，那条路保持不动。
import { createWorldBook, parseWorldBookFromJson } from "./settings-storage";
import { asRecord, parseTavernWorldBook } from "./tavern-card-parse";
import type { WorldBookConfig } from "./settings-types";

export type WorldBookJsonSource =
    /** 本应用自己导出的世界书 JSON */
    | "native"
    /** 酒馆等外部工具导出的世界书 JSON */
    | "tavern"
    /** 角色卡 JSON（取卡里内嵌的那本世界书） */
    | "card";

export type WorldBookJsonImport = {
    book: WorldBookConfig;
    source: WorldBookJsonSource;
    entryCount: number;
    categoryCount: number;
    /** 整本被压成一两条超长内容，已按标题层级切开 */
    megaSplit: boolean;
};

/** 内嵌世界书可能挂着的外层键名（角色卡用 character_book，部分导出工具用另一套） */
const EMBEDDED_KEYS = ["character_book", "world_book", "worldBook", "world_info", "worldInfo"];

function countCategories(entries: WorldBookConfig["entries"]): number {
    const set = new Set<string>();
    for (const e of entries) {
        const c = typeof e.category === "string" ? e.category.trim() : "";
        if (c) set.add(c);
    }
    return set.size;
}

/** 先按本应用导出格式解析；不是该格式（或里面没条目）时返回 null，交给酒馆解析器 */
function tryNative(text: string): WorldBookConfig | null {
    try {
        const book = parseWorldBookFromJson(text);
        return book && book.entries.length > 0 ? book : null;
    } catch {
        return null;
    }
}

/**
 * 把一份世界书 JSON 文本解析成一本世界书。
 * 认不出格式返回 null（调用方负责提示），不抛异常。
 */
export function importWorldBookFromJsonText(
    text: string,
    fallbackName = "导入的世界书"
): WorldBookJsonImport | null {
    let root: unknown;
    try {
        root = JSON.parse(text);
    } catch {
        return null;
    }
    if (root === null || typeof root !== "object") return null;

    // ① 本应用自己的导出格式：原样接受，条目的每个字段都不动
    const native = tryNative(text);
    if (native) {
        return {
            book: native,
            source: "native",
            entryCount: native.entries.length,
            categoryCount: countCategories(native.entries),
            megaSplit: false,
        };
    }

    // ② 酒馆世界书 / 角色卡内嵌世界书 / 条目数组 / 嵌套字典
    const rec = asRecord(root);
    const embedded = rec ? EMBEDDED_KEYS.find((k) => asRecord(rec[k])) : undefined;
    const data: Record<string, unknown> = embedded
        ? (rec as Record<string, unknown>)
        : { character_book: Array.isArray(root) ? { entries: root } : root };

    const parsed = parseTavernWorldBook(data, fallbackName);
    if (!parsed) return null;

    // 角色卡特有字段（系统提示 / 深度提示 / 作者注释）不是世界书内容，单独上传时不带进来
    const entries = parsed.groups.filter((g) => !g.extraOnly).flatMap((g) => g.entries);
    if (entries.length === 0) return null;

    const book = createWorldBook(parsed.bookName || fallbackName);
    book.entries = entries;
    book.description =
        parsed.stats.categories.length > 0
            ? `导入自世界书文件，共 ${entries.length} 条（${parsed.stats.categories.length} 个分类）`
            : `导入自世界书文件，共 ${entries.length} 条`;

    return {
        book,
        source: embedded ? "card" : "tavern",
        entryCount: entries.length,
        categoryCount: parsed.stats.categories.length,
        megaSplit: parsed.stats.megaSplit,
    };
}
