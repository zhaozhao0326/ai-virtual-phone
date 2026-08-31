// lib/tavern-card-parse.ts
// 第三方角色卡（SillyTavern / 酒馆 V2・V3，PNG 内嵌或 JSON 文本）的统一拆解器。
//
// 之前的问题：卡里内嵌的世界书被整本塞进一本书、未经分类，条目又常常「关键词为空 +
// 非常驻」→ isWorldBookEntryActivated 永远返回 false（导入了却永远不生效）；
// 卡里自带的正则脚本、预设、系统提示则整块丢弃。
//
// 这里做四件事，且全部是纯函数（不碰 window / localStorage / IndexedDB），
// 所以小手机（世界书 / 正则 / 预设）与独家特调（基底 / 滤网）两侧能共用同一套结果，
// 验收脚本也能用 node 直接跑真代码，而不是照抄一份复刻逻辑。
//
//   ① 世界书按「分类 / 文件夹」拆开（category、folder、comment 路径前缀、标题括号都认）；
//   ② 整本被压成一条超长条目时，按标题层级二次切分成多条，标题即分类；
//   ③ 条目关键词补全（从标题/正文提炼），实在提不出来才退化成常驻（否则永远不触发）；
//   ④ 正则脚本、预设、system_prompt / 追加指令 / 深度提示 / 作者注释 一并提炼出来。

import type { RegexRule, WorldBookEntry } from "./settings-types";

// ── 小工具（无依赖） ─────────────────────────────────

let _seq = 0;

/** 本地 id：不需要浏览器 API，导入落库时也不会和外部 id 撞 */
export function makeTavernId(prefix: string): string {
    _seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${_seq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function firstString(...values: unknown[]): string {
    for (const v of values) {
        if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
}

function toNum(v: unknown, fallback: number): number {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function strList(v: unknown): string[] {
    return asArray(v)
        .map((x) => (typeof x === "string" ? x.trim() : ""))
        .filter(Boolean);
}

/** 去掉会破坏「逗号分隔关键词」约定的符号 */
function sanitizeKey(k: string): string {
    return String(k || "").replace(/[,，]/g, " ").replace(/\s+/g, " ").trim();
}

function clampText(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── 卡片解包 ────────────────────────────────────────

export type TavernCardSource = {
    spec: string;
    root: Record<string, unknown>;
    /** V2/V3 的真实角色字段（data 下）；V1 平铺时等于 root */
    data: Record<string, unknown>;
};

export function unwrapTavernCard(obj: unknown): TavernCardSource | null {
    const root = asRecord(obj);
    if (!root) return null;
    const spec = typeof root.spec === "string" ? root.spec : "";
    const data = asRecord(root.data) ?? root;
    return { spec, root, data };
}

// ── 分类 / 文件夹路径 ────────────────────────────────

const PATH_SPLIT = /\s*(?:\/|／|\\|＼|>|\||｜|》|»|→)\s*/;
const SENTENCE_PUNCT = /[。！？；，、,.!?;:：]/;
const MAX_PATH_DEPTH = 4;

export function splitCategoryPath(raw: string): string[] {
    const parts = String(raw || "")
        .split(PATH_SPLIT)
        .map((p) => p.replace(/^[【\[（(\s]+|[】\]）)\s]+$/g, "").trim())
        .filter((p) => p && p.length <= 40);
    return parts.slice(0, MAX_PATH_DEPTH);
}

/**
 * 书里可能带着文件夹表（id → 名字，且文件夹之间有 parent 父子链）。
 * 条目上通常只存叶子文件夹的 id，所以这里把「id → 完整路径（地理/青丘国）」算出来，
 * 这样条目归类时不会丢掉父级（否则只能看到「青丘国」而看不到它属于「地理」）。
 * 同时把文件夹名字也映射到路径，兼容「条目直接写文件夹名而非 id」的卡。
 */
export function buildFolderNameMap(book: Record<string, unknown> | null): Map<string, string> {
    const map = new Map<string, string>();
    if (!book) return map;
    const raw = book.folders;
    const list = Array.isArray(raw)
        ? raw
        : (() => {
              const dict = asRecord(raw);
              return dict ? Object.entries(dict).map(([id, v]) => ({ id, ...(asRecord(v) ?? {}) })) : [];
          })();

    const meta = new Map<string, { name: string; parent: string | null }>();
    for (const item of list) {
        const rec = asRecord(item) ?? {};
        const idRaw = rec.id ?? rec.uid ?? rec.key;
        const id = idRaw === undefined || idRaw === null ? "" : String(idRaw);
        const name = firstString(rec.name, rec.title, rec.label);
        const parentRaw = rec.parent ?? rec.parentId ?? rec.parent_id;
        const parent = parentRaw === undefined || parentRaw === null ? "" : String(parentRaw);
        if (id && name) meta.set(id, { name, parent: parent || null });
    }

    const resolvePath = (id: string, seen: Set<string>): string => {
        const m = meta.get(id);
        if (!m) return "";
        if (seen.has(id)) return m.name; // 防环
        seen.add(id);
        if (m.parent && meta.has(m.parent)) {
            const p = resolvePath(m.parent, seen);
            return p ? `${p}/${m.name}` : m.name;
        }
        return m.name;
    };

    for (const id of meta.keys()) {
        const path = resolvePath(id, new Set());
        if (!path) continue;
        map.set(id, path);
        // 名字也映射到路径：兼容条目直接写文件夹名（而非 id）的卡
        const name = meta.get(id)!.name;
        if (!map.has(name)) map.set(name, path);
    }
    return map;
}

/**
 * 抽出条目的分类路径（多级）。返回空数组 = 无分类，归到「通用」。
 * 来源优先级：category → folder（经文件夹表翻译成名字）→ group → extensions 里的同名字段
 *            → comment/name 的括号前缀（【地理】青丘）→ comment/name 的路径前缀（地理/青丘）。
 */
export function extractTavernCategoryPath(
    entry: Record<string, unknown>,
    folderNames?: Map<string, string>
): string[] {
    const resolve = (v: unknown): string => {
        const s = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
        return folderNames?.get(s) ?? s;
    };

    // 条目上可能直接写了分类/文件夹：category、folder（id 或名字或数组）、group
    const categoryLike = firstString(entry.category, entry.group);
    if (categoryLike) return splitCategoryPath(resolve(categoryLike));

    const folderVal = entry.folder;
    const folderToStr = (f: unknown): string => (typeof f === "string" ? f : typeof f === "number" ? String(f) : "").trim();
    if (Array.isArray(folderVal)) {
        // 多文件夹：取第一个能解析出名字的
        for (const f of folderVal) {
            const s = folderToStr(f);
            if (s) {
                const p = splitCategoryPath(resolve(s));
                if (p.length) return p;
            }
        }
    } else {
        const s = folderToStr(folderVal);
        if (s) return splitCategoryPath(resolve(s));
    }

    const ext = asRecord(entry.extensions);
    if (ext) {
        const fromExt = firstString(ext.category, ext.folder, ext.group);
        if (fromExt) return splitCategoryPath(resolve(fromExt));
    }

    const label = firstString(entry.comment, entry.name, entry.title, entry.memo);
    if (!label) return [];

    // 【地理】青丘国 —— 只有当括号后面还有正文时，括号里的内容才算分类
    const bracket = label.match(/^\s*[【\[（(]\s*([^】\]）)]{1,24})\s*[】\]）)]\s*(\S[\s\S]*)$/);
    if (bracket && bracket[2].trim()) return splitCategoryPath(bracket[1]);

    // 地理/青丘国、地理>青丘国 —— 整条标题里都不能有句读，否则多半是句子里的斜杠（"早上/晚上，他都在"）
    if (!SENTENCE_PUNCT.test(label)) {
        const pathish = label.match(/^([^/\n>|｜（）()【】\[\]]{1,12})\s*(?:\/|／|>|\||｜)\s*(\S[\s\S]*)$/);
        if (pathish) return splitCategoryPath(pathish[1]);
    }

    return [];
}

/** 去掉分类前缀后的干净标题（用于生成触发词） */
export function stripCategoryLabel(label: string): string {
    return String(label || "")
        .replace(/^\s*[【\[（(]\s*[^】\]）)]{1,24}\s*[】\]）)]\s*/, "")
        .replace(/^\s*[^/\n>|｜（）()【】\[\]]{1,12}\s*(?:\/|／|>|\||｜)\s*/, "")
        .trim();
}

// ── 触发词（key）补全 ────────────────────────────────

const KEY_SPLIT = /[\s、,，;；/｜|]+/;

function tokenize(text: string): string[] {
    return String(text || "")
        .replace(/[【】\[\]（）()《》"'“”‘’：:…·]/g, " ")
        .split(KEY_SPLIT)
        .map(sanitizeKey)
        .filter((k) => k.length >= 1 && k.length <= 16);
}

/**
 * 提炼触发词。返回 null 表示实在提不出来（调用方会把条目设为常驻，
 * 否则空 key + 非常驻 = 永远不激活，等于白导入）。
 */
export function deriveTavernKeys(opts: {
    keys?: string[];
    comment?: string;
    name?: string;
    content?: string;
}): string[] | null {
    const own = (opts.keys ?? []).map(sanitizeKey).filter(Boolean);
    if (own.length) return own;

    const label = stripCategoryLabel(firstString(opts.comment, opts.name));
    const labelKeys = tokenize(label);
    if (labelKeys.length) return labelKeys.slice(0, 5);

    // 退到正文首句：中文没有空格，取首句前若干字作为一个关键词（够短才能精准命中）
    const firstSentence = String(opts.content || "")
        .split(/[\n。！？!?；;]/)
        .map((s) => s.trim())
        .find(Boolean);
    if (firstSentence) {
        const head = sanitizeKey(firstSentence).slice(0, 8);
        if (head.length >= 2) return [head];
    }
    return null;
}

// ── 单条世界书条目 ───────────────────────────────────

/** SillyTavern 的 position 数字 → 本 App 的位置字面量 */
const TAVERN_POSITION_MAP: Record<number, WorldBookEntry["position"]> = {
    0: "before_char",
    1: "after_char",
    2: "before_em",
    3: "after_em",
    4: "before_an",
    5: "after_an",
};

export function mapTavernPosition(pos: unknown): WorldBookEntry["position"] {
    if (typeof pos === "number" && TAVERN_POSITION_MAP[pos] !== undefined) {
        return TAVERN_POSITION_MAP[pos];
    }
    if (typeof pos === "string") {
        const t = pos.trim();
        if (/^\d+$/.test(t)) return mapTavernPosition(Number(t));
        if (t) return t as WorldBookEntry["position"];
    }
    return "before_char";
}

export type TavernParsedEntry = {
    entry: WorldBookEntry;
    /** 多级分类路径；空数组 = 通用 */
    categoryPath: string[];
    /** key 是导入时补全的（原卡没给） */
    autoKeyed: boolean;
    /** 因为实在提炼不出触发词，只能设成常驻 */
    forcedConstant: boolean;
    /** 由卡里的 system_prompt / 追加指令 / 深度提示 / 作者注释 生成（不是世界书原条目） */
    extra?: boolean;
};

export type TavernEntryOverrides = {
    constant?: boolean;
    position?: WorldBookEntry["position"];
    insertion_order?: number;
    depth?: number;
    disable?: boolean;
    categoryPath?: string[];
    note?: string;
    extra?: boolean;
};

/** 把一条酒馆条目（或由超长内容切出的片段）规范化成本 App 的条目 */
export function buildTavernEntry(
    raw: {
        keys?: unknown;
        key?: unknown;
        secondary_keys?: unknown;
        selective?: unknown;
        comment?: unknown;
        name?: unknown;
        content?: unknown;
        constant?: unknown;
        enabled?: unknown;
        disable?: unknown;
        disabled?: unknown;
        use_regex?: unknown;
        useRegex?: unknown;
        position?: unknown;
        insertion_order?: unknown;
        order?: unknown;
        priority?: unknown;
        depth?: unknown;
        role?: unknown;
        probability?: unknown;
        extensions?: unknown;
    },
    overrides: TavernEntryOverrides = {}
): TavernParsedEntry | null {
    const content = typeof raw.content === "string" ? raw.content : "";
    if (!content.trim()) return null;

    const ext = asRecord(raw.extensions);
    const comment = firstString(raw.comment, raw.name);
    const selective = raw.selective === true || ext?.selective === true;
    const primaryKeys = strList(raw.keys).concat(strList(raw.key));
    const secondaryKeys = strList(raw.secondary_keys);

    let autoKeyed = false;
    let forcedConstant = false;
    let keys = primaryKeys.length ? primaryKeys.map(sanitizeKey).filter(Boolean) : [];

    if (!keys.length) {
        const derived = deriveTavernKeys({ comment, name: firstString(raw.name), content });
        if (derived && derived.length) {
            keys = derived;
            autoKeyed = true;
        }
    } else if (!selective && secondaryKeys.length) {
        // 非选择性条目：次关键词在酒馆里与主关键词同为 OR 触发，合并才不丢
        keys = keys.concat(secondaryKeys.map(sanitizeKey).filter(Boolean));
    }

    let constant = overrides.constant !== undefined ? overrides.constant : raw.constant === true;
    if (!keys.length) {
        // 空 key + 非常驻 = 永远不会激活（导入了也白导入），只能退化为常驻
        constant = true;
        forcedConstant = true;
    }

    const enabled = raw.enabled !== false && raw.disable !== true && raw.disabled !== true;
    const notes: string[] = [];
    if (overrides.note) notes.push(overrides.note);
    if (autoKeyed) notes.push("触发词由导入自动补全");
    if (forcedConstant) notes.push("无触发词，已设为常驻");
    if (selective && primaryKeys.length) notes.push("原为选择性条目，仅保留主触发词");

    const finalComment = [stripCategoryLabel(comment), notes.length ? `（${notes.join("；")}）` : ""]
        .filter(Boolean)
        .join(" ")
        .trim();

    const entry: WorldBookEntry = {
        uid: makeTavernId("wb-entry"),
        key: keys.join(","),
        content,
        comment: finalComment,
        use_regex: raw.use_regex === true || raw.useRegex === true,
        disable: overrides.disable !== undefined ? overrides.disable : !enabled,
        constant,
        position: overrides.position ?? mapTavernPosition(raw.position),
        depth: overrides.depth ?? toNum(raw.depth, 0),
        probability: toNum(raw.probability, 100),
        useProbability: false,
        role: toNum(raw.role, 0),
        insertion_order:
            overrides.insertion_order ??
            toNum(raw.insertion_order ?? raw.order ?? raw.priority, 100),
        category: (overrides.categoryPath ?? []).join("/") || undefined,
    };

    return {
        entry,
        categoryPath: overrides.categoryPath ?? [],
        autoKeyed,
        forcedConstant,
        extra: overrides.extra === true,
    };
}

// ── 超长条目：按标题层级二次切分 ──────────────────────

export type TavernHeadingSplit = { level: number; title: string; body: string };

const SEPARATOR_LINE = /^\s*[-=＝—_*＊·]{3,}\s*$/;
const HEADING_PATTERNS: { re: RegExp; level: (m: RegExpMatchArray) => number; title: (m: RegExpMatchArray) => string }[] = [
    // # 标题 / ## 标题（Markdown）
    { re: /^\s*(#{1,6})\s+(.+?)\s*$/, level: (m) => m[1].length, title: (m) => m[2].trim() },
    // 【标题】/ [标题] 独占一行
    { re: /^\s*[【\[]\s*(.{1,40}?)\s*[】\]]\s*$/, level: () => 2, title: (m) => m[1].trim() },
    // 第三章、第 3 章、Chapter 3
    {
        re: /^\s*(?:第\s*[0-9一二三四五六七八九十百]+\s*[章节部篇]|Chapter\s+\d+)\s*[:：、.]?\s*(.{0,40})$/i,
        level: () => 2,
        title: (m) => m[0].trim(),
    },
    // 状态A【对方未读】：内容 / 阶段一【设定】：内容
    {
        re: /^\s*(状态[ABCD]|阶段[一二三四五六七八九十]|阶段\d+|类型[ABCD]|类型\d+|模块[一二三四五六七八九十]|模块\d+)\s*[【\[（(]\s*([^】\]）)]{1,40}?)\s*[】\]）)]\s*[：:]\s*\S.*$/,
        level: () => 2,
        title: (m) => `${m[1].trim()}-${m[2].trim()}`,
    },
    // 要求：内容 / 群聊部分：内容 / 附注：内容 / 规则：内容（标题后可直接跟内容，也可独占一行）
    {
        re: /^\s*(要求|群聊部分|群聊设定|单人部分|单人设定|附注|说明|规则|设定|注意|提示|备注|补充|背景|人物|剧情|关系|事件|场景)\s*[：:]\s*(?:\S.*)?$/,
        level: () => 2,
        title: (m) => m[1].trim(),
    },
];

/**
 * 把一坨「整本设定压成一条」的超长正文按标题切段。
 * 只有切出 ≥3 段时才返回（切不动就返回 null，让调用方保持原样，绝不猜）。
 */
export function splitMegaContent(content: string): TavernHeadingSplit[] | null {
    const lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
    const found: { level: number; title: string; line: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!line.trim()) continue;
        let matched = false;
        for (const p of HEADING_PATTERNS) {
            const m = line.match(p.re);
            if (m) {
                found.push({ level: p.level(m), title: p.title(m), line: i });
                matched = true;
                break;
            }
        }
        if (matched) continue;
        // setext：上一行是有内容的文本，下一行是 === 或 ---
        const next = lines[i + 1] ?? "";
        if (line.trim() && /^\s*(={3,}|-{3,})\s*$/.test(next)) {
            found.push({ level: /^=/.test(next.trim()) ? 1 : 2, title: line.trim(), line: i });
        }
    }

    if (found.length < 3) return null;

    const out: TavernHeadingSplit[] = [];
    for (let i = 0; i < found.length; i++) {
        const start = found[i].line + 1;
        const end = i + 1 < found.length ? found[i + 1].line : lines.length;
        // 标题行本身可能已携带内容（如 "状态A【对方未读】：对方发了消息..."），
        // 提取第一个冒号后的内容作为该段 body 的开头，避免整段内容被丢弃。
        const headingLine = lines[found[i].line] ?? "";
        const inlineBody = headingLine.replace(/^.*?[：:]\s*/, "").trim();
        const tailLines = lines
            .slice(start, end)
            .filter((l) => !SEPARATOR_LINE.test(l));
        const bodyParts = inlineBody ? [inlineBody, ...tailLines] : tailLines;
        const body = bodyParts.join("\n").trim();
        if (body.length < 20) continue;
        out.push({ level: found[i].level, title: found[i].title, body });
    }

    // 首个标题之前还有正文 → 留作「前言」
    if (found[0].line > 0) {
        const head = lines.slice(0, found[0].line).filter((l) => !SEPARATOR_LINE.test(l)).join("\n").trim();
        if (head.length >= 40) out.unshift({ level: found[0].level, title: "前言", body: head });
    }

    return out.length >= 3 ? out : null;
}

/** 切分后的层级分类：标题级别 = 出现次数 ≥2 的最小级别；更深一级的标题作为条目名 */
export function pickCategoryLevel(levels: number[]): number {
    const counts = new Map<number, number>();
    for (const lv of levels) counts.set(lv, (counts.get(lv) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => a[0] - b[0]);
    for (const [lv, count] of sorted) {
        if (count >= 2) return lv;
    }
    return sorted[0]?.[0] ?? 1;
}

// ── 整本世界书 ───────────────────────────────────────

export type TavernBookGroup = {
    /** 展示用分类名（多级用 / 连接）；空串 = 整本不分类 */
    category: string;
    path: string[];
    entries: WorldBookEntry[];
    /** 这一组全部来自 system_prompt / 追加指令 / 作者注释 等非世界书字段 */
    extraOnly?: boolean;
};

export type TavernParsedBook = {
    bookName: string;
    groups: TavernBookGroup[];
    stats: {
        entries: number;
        constant: number;
        autoKeyed: number;
        forcedConstant: number;
        disabled: number;
        /** 是否触发了「一条超长条目按标题切开」 */
        megaSplit: boolean;
        categories: string[];
    };
};

const EXTRA_DISABLE_LENGTH = 2000;

function isTavernDefaultSystemPrompt(text: string): boolean {
    return /write\s+\{\{char\}\}'?s?\s+next\s+reply/i.test(text);
}

/** 卡里的 system_prompt / 追加指令 / 深度提示 / 作者注释 → 世界书条目（各归一个分类） */
export function collectTavernExtraEntries(data: Record<string, unknown>): TavernParsedEntry[] {
    const out: TavernParsedEntry[] = [];
    const push = (
        raw: string,
        opts: { category: string; comment: string; constant: boolean; position: WorldBookEntry["position"]; order: number; depth?: number }
    ) => {
        const body = String(raw || "").trim();
        if (!body) return;
        const tooLong = body.length > EXTRA_DISABLE_LENGTH;
        const parsed = buildTavernEntry(
            { content: body, comment: opts.comment, constant: opts.constant, position: opts.position, insertion_order: opts.order, depth: opts.depth ?? 0 },
            {
                constant: opts.constant,
                position: opts.position,
                insertion_order: opts.order,
                disable: tooLong,
                categoryPath: [opts.category],
                note: tooLong ? "内容较长，已默认停用，确认需要再启用" : "",
                extra: true,
            }
        );
        if (parsed) out.push(parsed);
    };

    const systemPrompt = firstString(data.system_prompt, data.systemPrompt);
    if (systemPrompt && !isTavernDefaultSystemPrompt(systemPrompt)) {
        push(systemPrompt, { category: "系统设定", comment: "系统提示", constant: true, position: "before_char", order: 0 });
    }

    const depthPrompt = data.depth_prompt;
    const depthRec = asRecord(depthPrompt);
    if (depthRec) {
        push(firstString(depthRec.prompt, depthRec.text), {
            category: "系统设定",
            comment: "深度提示",
            constant: true,
            position: "after_char",
            order: 90,
            depth: toNum(depthRec.depth, 4),
        });
    }

    const phi = firstString(data.post_history_instructions, data.postHistoryInstructions);
    push(phi, { category: "系统设定", comment: "追加指令（离生成最近）", constant: true, position: "after_char", order: 1000 });

    const notes = firstString(data.creator_notes, data.creatorNotes);
    push(notes, { category: "作者注释", comment: "作者注释", constant: false, position: "before_char", order: 80 });

    return out;
}

/**
 * 解析内嵌世界书：按分类分组 + 超长条目二次切分 + 触发词补全。
 * 只返回结构化结果，落库/绑定由调用方负责（这样特调侧能复用同一份分组）。
 *
 * 支持三种世界书形态：
 *   - 标准：character_book.entries 是数组（或 { id: entry } 字典）
 *   - 文件夹层级：entries[].folder 指向 folders[] 里的 id/名字，并能沿 parent 链拼出「地理/青丘国」
 *   - 嵌套字典：character_book = { 地理: { 青丘国: "内容", 昆仑: "内容" }, 人物: {...} }
 */
export function parseTavernWorldBook(
    data: Record<string, unknown>,
    fallbackName: string
): TavernParsedBook | null {
    const bookRaw = data.character_book;
    if (!bookRaw) return null;

    const WB_META_KEYS = new Set([
        "name", "entries", "folders", "fields", "version", "description",
        "creator", "creator_comment", "scan_depth", "token_budget", "recursive",
        "extensions", "regex_scripts", "field", "constant", "uuid", "metadata",
        "_", "author", "original_author", "comment", "instructions", "order",
    ]);

    // 嵌套字典：把 { 地理: { 青丘国: "内容" } } 这类结构压平为带分类路径的条目
    const collectNested = (
        node: unknown,
        path: string[],
        out: { raw: unknown; categoryPath: string[] }[]
    ): void => {
        const rec = asRecord(node);
        if (!rec) return;
        const looksLikeEntry =
            typeof rec.content === "string" ||
            Array.isArray(rec.keys) ||
            rec.keys !== undefined ||
            (rec.comment !== undefined && (rec.content !== undefined || rec.name !== undefined));
        if (looksLikeEntry && !Array.isArray((rec as Record<string, unknown>).entries)) {
            out.push({ raw: rec, categoryPath: path });
            return;
        }
        for (const [k, v] of Object.entries(rec)) {
            if (WB_META_KEYS.has(k)) continue;
            const sub = asRecord(v);
            if (sub) {
                collectNested(sub, [...path, k], out);
            } else if (Array.isArray(v)) {
                for (const item of v) {
                    const ir = asRecord(item);
                    if (ir) collectNested(ir, [...path, k], out);
                    else if (typeof item === "string" && item.trim())
                        out.push({ raw: { comment: k, content: item }, categoryPath: path });
                }
            } else if (typeof v === "string" && v.trim()) {
                out.push({ raw: { comment: k, content: v }, categoryPath: path });
            }
        }
    };

    type RawItem = { raw: unknown; categoryPath: string[] };
    let rawEntries: RawItem[] = [];
    let bookName = fallbackName;
    const bookRec = asRecord(bookRaw);
    if (bookRec) {
        bookName = firstString(bookRec.name, bookRec.bookName) || fallbackName;
        const entries = bookRec.entries;
        const standard = Array.isArray(entries)
            ? entries
            : entries && typeof entries === "object"
            ? Object.values(entries as Record<string, unknown>)
            : [];
        if (standard.length) {
            rawEntries = standard.map((e) => ({ raw: e, categoryPath: [] }));
        } else {
            // 标准 entries 为空 → 可能是嵌套字典（文件夹直接作为键）
            const nested: RawItem[] = [];
            collectNested(bookRec, [], nested);
            rawEntries = nested;
        }
    } else if (Array.isArray(bookRaw)) {
        rawEntries = bookRaw.map((e) => ({ raw: e, categoryPath: [] }));
    }
    if (!rawEntries.length) return null;

    const folderNames = buildFolderNameMap(bookRec);
    const parsed: TavernParsedEntry[] = [];
    for (const item of rawEntries) {
        const rec = asRecord(item.raw);
        if (!rec) continue;
        // 嵌套字典已带路径；标准条目再尝试从 folder/category/comment 推断
        const categoryPath =
            item.categoryPath.length > 0
                ? item.categoryPath
                : extractTavernCategoryPath(rec, folderNames);
        const built = buildTavernEntry(rec as Parameters<typeof buildTavernEntry>[0], {
            categoryPath,
        });
        if (built) parsed.push(built);
    }

    // 整本被压成一两条超长条目（作者没用分类）→ 按标题层级切开，标题即分类
    let megaSplit = false;
    if (parsed.length <= 3) {
        const rebuilt: TavernParsedEntry[] = [];
        for (const p of parsed) {
            const splits = splitMegaContent(p.entry.content);
            if (!splits) {
                rebuilt.push(p);
                continue;
            }
            const categoryLevel = pickCategoryLevel(splits.map((s) => s.level));
            let currentCategory = [...p.categoryPath];
            for (const seg of splits) {
                if (seg.level <= categoryLevel) currentCategory = splitCategoryPath(seg.title);
                const built = buildTavernEntry(
                    {
                        content: seg.body,
                        comment: seg.level > categoryLevel ? seg.title : "",
                        constant: p.entry.constant,
                        position: p.entry.position,
                        insertion_order: p.entry.insertion_order,
                        depth: p.entry.depth,
                    },
                    { categoryPath: [...currentCategory], disable: p.entry.disable, constant: p.entry.constant }
                );
                if (built) rebuilt.push(built);
            }
            megaSplit = true;
        }
        if (megaSplit && rebuilt.length >= 3) {
            parsed.length = 0;
            parsed.push(...rebuilt);
        } else {
            megaSplit = false;
        }
    }

    parsed.push(...collectTavernExtraEntries(data));

    // 稳定分组：保持条目在原书中的先后顺序
    const groups: TavernBookGroup[] = [];
    const index = new Map<string, TavernBookGroup>();
    for (const p of parsed) {
        const key = p.categoryPath.join("/");
        let group = index.get(key);
        if (!group) {
            group = { category: key, path: p.categoryPath, entries: [], extraOnly: p.extra === true };
            index.set(key, group);
            groups.push(group);
        }
        if (p.extra !== true) group.extraOnly = false;
        group.entries.push(p.entry);
    }

    const stats = {
        entries: parsed.length,
        constant: parsed.filter((p) => p.entry.constant).length,
        autoKeyed: parsed.filter((p) => p.autoKeyed).length,
        forcedConstant: parsed.filter((p) => p.forcedConstant).length,
        disabled: parsed.filter((p) => p.entry.disable).length,
        megaSplit,
        categories: groups.map((g) => g.category).filter(Boolean),
    };

    return { bookName, groups, stats };
}

// ── 正则脚本 ────────────────────────────────────────

function toPlacement(v: unknown): number[] {
    if (Array.isArray(v)) {
        const nums = v.map((x) => Number(x)).filter((n) => Number.isFinite(n));
        if (nums.length) return nums;
    }
    if (typeof v === "number" && Number.isFinite(v)) return [v];
    // 酒馆默认：用户输入 + AI 输出两头都过
    return [1, 2];
}

/** 收集卡里的正则脚本（extensions.regex_scripts / regex_scripts 等常见位置） */
export function collectTavernRegexScripts(
    root: Record<string, unknown>,
    data: Record<string, unknown>
): RegexRule[] {
    const pools: unknown[] = [];
    for (const src of [data, root]) {
        for (const key of ["regex_scripts", "regexScripts"]) {
            const v = src?.[key];
            if (Array.isArray(v)) pools.push(v);
        }
        const ext = asRecord(src?.extensions);
        if (ext) {
            for (const key of ["regex_scripts", "regexScripts"]) {
                if (Array.isArray(ext[key])) pools.push(ext[key]);
            }
        }
    }

    const rules: RegexRule[] = [];
    const seen = new Set<string>();
    for (const pool of pools) {
        for (const raw of asArray(pool)) {
            const rec = asRecord(raw);
            if (!rec) continue;
            const findRegex = firstString(rec.findRegex, rec.regex, rec.find);
            if (!findRegex) continue;
            const replaceString = firstString(rec.replaceString, rec.replace);
            const signature = `${findRegex}::${replaceString}`;
            if (seen.has(signature)) continue;
            seen.add(signature);
            const trim = strList(rec.trimStrings);
            rules.push({
                id: makeTavernId("regex-rule"),
                scriptName: firstString(rec.scriptName, rec.name) || "未命名规则",
                findRegex,
                replaceString,
                trimStrings: trim.length ? trim : undefined,
                disabled: rec.disabled === true,
                placement: toPlacement(rec.placement),
                markdownOnly: rec.markdownOnly === true ? true : undefined,
                promptOnly: rec.promptOnly === true ? true : undefined,
                runOnEdit: rec.runOnEdit === true ? true : undefined,
                substituteRegex: typeof rec.substituteRegex === "number" ? rec.substituteRegex : undefined,
                minDepth: typeof rec.minDepth === "number" ? rec.minDepth : undefined,
                maxDepth: typeof rec.maxDepth === "number" ? rec.maxDepth : undefined,
            });
        }
    }
    return rules;
}

// ── 预设 ────────────────────────────────────────────

export type TavernPresetHit = { name: string; obj: unknown };

function isPresetShaped(v: unknown): boolean {
    const rec = asRecord(v);
    return Boolean(rec && Array.isArray(rec.prompts));
}

/** 找出卡里附带的预设（preset / extensions.preset / 整份文件就是预设文件） */
export function findTavernPresetObject(
    root: Record<string, unknown>,
    data: Record<string, unknown>,
    fallbackName: string
): TavernPresetHit | null {
    const candidates: unknown[] = [
        data.preset,
        asRecord(data.extensions)?.preset,
        root.preset,
        asRecord(root.extensions)?.preset,
    ];
    for (const candidate of candidates) {
        if (isPresetShaped(candidate)) {
            const rec = asRecord(candidate)!;
            return {
                name: firstString(rec.name, rec.preset_name, rec.presetName) || `${fallbackName}·预设`,
                obj: candidate,
            };
        }
    }
    // 整份文件就是预设文件（有 prompts、没有角色字段）
    if (isPresetShaped(root) && !root.data && !firstString(data.name, data.char_name)) {
        const rec = asRecord(root)!;
        return {
            name: firstString(rec.name, rec.preset_name, rec.presetName) || fallbackName,
            obj: root,
        };
    }
    return null;
}

/** 预设里启用的提示词条数（提示用户用得到） */
export function countPresetPrompts(obj: unknown): { total: number; enabled: number } {
    const rec = asRecord(obj);
    const prompts = rec ? asArray(rec.prompts) : [];
    const enabledOrder = rec && Array.isArray(rec.prompt_order)
        ? new Set(asArray(rec.prompt_order).map((p) => firstString(asRecord(p)?.identifier)).filter(Boolean))
        : null;
    let enabled = 0;
    for (const raw of prompts) {
        const p = asRecord(raw);
        if (!p) continue;
        const identifier = firstString(p.identifier);
        if (enabledOrder) {
            if (enabledOrder.has(identifier)) enabled += 1;
            continue;
        }
        if (p.enabled !== false) enabled += 1;
    }
    return { total: prompts.length, enabled };
}

/**
 * 预设 → 纯文本（按提示词顺序、只收启用的条目）。
 * 小手机侧用 parsePresetFromJson 落成预设；特调没有预设槽，把内容摊成基底材料。
 */
export function flattenTavernPresetPrompts(obj: unknown): string {
    const rec = asRecord(obj);
    if (!rec) return "";
    const prompts = asArray(rec.prompts);
    const orderRaw = Array.isArray(rec.prompt_order) ? asArray(rec.prompt_order) : null;
    const ordered = new Map<string, boolean>();
    if (orderRaw) {
        for (const raw of orderRaw) {
            const item = asRecord(raw);
            const identifier = firstString(item?.identifier);
            if (identifier) ordered.set(identifier, item?.enabled !== false);
        }
    }

    const lines: string[] = [];
    for (const raw of prompts) {
        const p = asRecord(raw);
        if (!p) continue;
        const identifier = firstString(p.identifier);
        if (ordered.size) {
            if (!identifier || !ordered.get(identifier)) continue;
        } else if (p.enabled === false) {
            continue;
        }
        const content = typeof p.content === "string" ? p.content.trim() : "";
        if (!content) continue;
        const label = firstString(p.name) || identifier;
        lines.push(label ? `【${label}】\n${content}` : content);
    }
    return lines.join("\n\n");
}

// ── 汇总（给 UI 提示用） ─────────────────────────────

export function describeCategories(categories: string[], max: number = 4): string {
    const list = categories.filter(Boolean);
    if (!list.length) return "未分类";
    const head = list.slice(0, max).join("、");
    return list.length > max ? `${head} 等 ${list.length} 类` : head;
}

export function clampTextForNotice(text: string, max: number = 24): string {
    return clampText(text, max);
}
