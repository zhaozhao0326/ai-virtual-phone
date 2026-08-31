// lib/mixology/transfer.ts
// 独家特调 · 材料的离线搬运：导出成 JSON 文件、从 JSON 文件导入。
// 官网大厅之外的第二条路——备份、私下发给朋友、跨设备迁移都不用联网。

import { downloadFile } from "@/lib/download-utils";
import {
    collectTavernRegexScripts,
    findTavernPresetObject,
    flattenTavernPresetPrompts,
    parseTavernWorldBook,
} from "@/lib/tavern-card-parse";
import {
    MIX_SLOT_ORDER,
    createMixId,
    type MixCharacterCard,
    type MixFilterMaterial,
    type MixMaterial,
    type MixMaterialKind,
    type MixRecipe,
    type MixSlotEntry,
    type MixTextMaterial,
} from "./types";
import { getMixMaterial, isMixBuiltinId, loadMixRecipes, MIX_CABINET_UPDATED_EVENT, saveMixMaterial, saveMixRecipe } from "./storage";

const FILE_MARK = "float-mixology-material";
const FILE_VERSION = 1;

/** PNG 卡的文本块关键字——自有格式，故意与酒馆卡（chara/ccv3）不同 */
const PNG_KEYWORD = "float-mixology-card";
/** 第三方角色卡格式的关键字（SillyTavern V2/V3 等）：检测到就走酒馆卡解析 */
const THIRD_PARTY_PNG_KEYWORDS = ["chara", "ccv3"];

type MixTransferFile = {
    mark: typeof FILE_MARK;
    version: number;
    material: MixMaterial;
};

function safeFileName(name: string): string {
    // 文件名里不能出现的字符统一换成下划线；中文保留
    const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
    return cleaned || "material";
}


// ── PNG 卡：自有格式的图内嵌数据 ──────────────────────
// 数据以 base64 JSON 写进 PNG 的 tEXt 块（关键字 float-mixology-card），
// 图即是卡。解析时若发现酒馆系关键字（chara/ccv3）直接报错拒收。

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function isPng(u8: Uint8Array): boolean {
    return PNG_SIG.every((b, i) => u8[i] === b);
}

/** 遍历 PNG 文本块，返回 keyword → 文本 的映射（tEXt 为 latin1，iTXt 未压缩段为 utf8） */
function readPngTextChunks(u8: Uint8Array): Map<string, string> {
    const out = new Map<string, string>();
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let offset = 8;
    while (offset + 12 <= u8.length) {
        const length = dv.getUint32(offset);
        const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
        const data = u8.subarray(offset + 8, offset + 8 + length);
        if (type === "tEXt") {
            const sep = data.indexOf(0);
            if (sep > 0) {
                out.set(new TextDecoder().decode(data.subarray(0, sep)).toLowerCase(), new TextDecoder("latin1").decode(data.subarray(sep + 1)));
            }
        } else if (type === "iTXt") {
            const pos = data.indexOf(0);
            if (pos > 0) {
                const kw = new TextDecoder().decode(data.subarray(0, pos)).toLowerCase();
                const compressed = data[pos + 1];
                let cursor = pos + 3;
                cursor = data.indexOf(0, cursor) + 1; // 语言标签
                cursor = data.indexOf(0, cursor) + 1; // 翻译关键字
                if (compressed === 0 && cursor > 0) out.set(kw, new TextDecoder().decode(data.subarray(cursor)));
            }
        }
        if (type === "IEND") break;
        offset += 12 + length;
    }
    return out;
}

let _crcTable: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
    if (!_crcTable) {
        _crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            _crcTable[n] = c;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
}

/** 在 IEND 前插入一个 tEXt 块 */
function insertPngTextChunk(u8: Uint8Array, keyword: string, text: string): Uint8Array {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let offset = 8;
    let iendOffset = -1;
    while (offset + 12 <= u8.length) {
        const length = dv.getUint32(offset);
        const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
        if (type === "IEND") { iendOffset = offset; break; }
        offset += 12 + length;
    }
    if (iendOffset < 0) throw new Error("PNG 结构异常。");
    const kwBytes = new TextEncoder().encode(keyword);
    const textBytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff); // base64 是纯 ASCII
    const payload = new Uint8Array(kwBytes.length + 1 + textBytes.length);
    payload.set(kwBytes, 0);
    payload[kwBytes.length] = 0;
    payload.set(textBytes, kwBytes.length + 1);
    const chunk = new Uint8Array(12 + payload.length);
    const cdv = new DataView(chunk.buffer);
    cdv.setUint32(0, payload.length);
    chunk.set(new TextEncoder().encode("tEXt"), 4);
    chunk.set(payload, 8);
    const crcBody = chunk.subarray(4, 8 + payload.length);
    cdv.setUint32(8 + payload.length, crc32(crcBody));
    const out = new Uint8Array(u8.length + chunk.length);
    out.set(u8.subarray(0, iendOffset), 0);
    out.set(chunk, iendOffset);
    out.set(u8.subarray(iendOffset), iendOffset + chunk.length);
    return out;
}

/** 从 PNG 卡解析材料；酒馆卡（SillyTavern V2/V3）自动适配为私人角色卡 */
export function parseMixMaterialsFromPng(buffer: ArrayBuffer): MixMaterial[] {
    const u8 = new Uint8Array(buffer);
    if (!isPng(u8)) throw new Error("这不是一个有效的 PNG 文件。");
    const chunks = readPngTextChunks(u8);
    const ours = chunks.get(PNG_KEYWORD);
    if (ours) {
        let json: string;
        try {
            json = decodeURIComponent(escape(atob(ours.trim())));
        } catch {
            throw new Error("这张卡的数据已损坏，请重新导出一张。");
        }
        return parseMixMaterialsFromJson(json);
    }
    for (const kw of THIRD_PARTY_PNG_KEYWORDS) {
        const third = chunks.get(kw);
        if (third) {
            let json: string;
            try {
                json = decodeURIComponent(escape(atob(third.trim())));
            } catch {
                throw new Error("这张卡的数据已损坏，请重新导出一张。");
            }
            const parsed = parseJsonLoose(json);
            if (!parsed) throw new Error("这张酒馆卡里的数据不是有效的 JSON。");
            // PNG 本体就是封面
            const cover = pngToDataUrl(u8);
            const materials = parseSillyTavernCharacterCard(parsed, cover);
            if (materials.length) return materials;
            throw new Error("这张酒馆卡里没有能认出来的角色数据。");
        }
    }
    throw new Error("这张 PNG 里没有特调卡数据。");
}

/** PNG 字节 → dataURL（做酒馆卡封面） */
function pngToDataUrl(u8: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
    return `data:image/png;base64,${btoa(binary)}`;
}

/** 宽松 JSON 解析：包了 ``` 围栏或带说明文字也能救回来（与 parseMixMaterialsFromJson 同套 repair） */
function parseJsonLoose(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        const repaired = repairJsonText(text);
        if (!repaired) return null;
        try {
            return JSON.parse(repaired);
        } catch {
            return null;
        }
    }
}

/**
 * SillyTavern 角色卡 → 独家特调材料。
 * 兼容 V2（{ spec: "chara_card_v2", data: {...} }）与 V1（平铺字段）。
 * 产出：一张私人角色卡 + 可选的基底（世界书 / 系统提示）+ 苦精（追加指令）。
 * 全部打 private 标记：只在酒柜私人区出现，不能发布到公开渠道。
 */
function parseSillyTavernCharacterCard(parsed: unknown, cover?: string): MixMaterial[] {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const root = parsed as Record<string, unknown>;
    const spec = typeof root.spec === "string" ? root.spec : "";
    const isV2 = /^chara_card/i.test(spec);
    // V2 的角色字段在 data 里；V1 平铺在顶层
    const data = isV2 && root.data && typeof root.data === "object" && !Array.isArray(root.data)
        ? (root.data as Record<string, unknown>)
        : root;
    if (!isV2 && !("first_mes" in data) && !("mes_example" in data)) return [];

    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
    const name = str(data.name);
    if (!name) return [];

    const now = Date.now();
    const openings = [str(data.first_mes), ...strArr(data.alternate_greetings)].filter(Boolean);
    const examples = parseMesExample(str(data.mes_example));

    const card: MixCharacterCard = {
        kind: "character",
        id: createMixId("mixmat"),
        name,
        charName: name,
        baseInfo: str(data.description) || undefined,
        personality: str(data.personality) || undefined,
        plot: str(data.scenario) || undefined,
        openings: openings.length ? openings : ["（这张卡没有开场白，先从一句问候开始吧。）"],
        examples: examples.length ? examples : undefined,
        tags: strArr(data.tags),
        author: str(data.creator) || undefined,
        hook: str(data.creator_notes) || undefined,
        cover,
        private: true,
        createdAt: now,
        updatedAt: now,
    };
    const materials: MixMaterial[] = [card];

    // 内嵌世界书（character_book）→ 基底材料：按原卡的分类/文件夹拆成多件，
    // 不再全挤成一件（原来"一坨什么都塞在里面"没法按类选装）；
    // 分类识别、超长条目按标题切开、触发词补全都走 tavern-card-parse，与小手机导入同一套。
    const parsedBook = parseTavernWorldBook(data, name);
    if (parsedBook) {
        for (const group of parsedBook.groups) {
            // 系统设定 / 作者注释 由下面的专属材料负责，这里跳过免得重复
            if (group.extraOnly) continue;
            const lines: string[] = [];
            for (const entry of group.entries) {
                if (entry.disable) continue;
                const content = entry.content?.trim();
                if (!content) continue;
                const keys = String(entry.key || "")
                    .split(",")
                    .map((k) => k.trim())
                    .filter(Boolean);
                const title = String(entry.comment || "").replace(/（[^）]*）/g, "").trim();
                const head = title || keys.join("、");
                lines.push(head ? `【${head}】${content}` : content);
            }
            if (!lines.length) continue;
            materials.push({
                kind: "base",
                id: createMixId("mixmat"),
                name: group.category ? `${name}·${group.category}` : `${name}·世界书`,
                hook: group.category
                    ? `从角色卡导入的世界书（分类：${group.category}）`
                    : "从酒馆角色卡导入的世界书",
                content: lines.join("\n\n"),
                private: true,
                createdAt: now,
                updatedAt: now,
            } as MixTextMaterial);
        }
    }

    // 正则脚本 → 滤网材料（酒馆的 placement 2 = AI 输出，对应"进上下文"清洗）
    const regexRules = collectTavernRegexScripts(root, data);
    if (regexRules.length) {
        materials.push({
            kind: "filter",
            id: createMixId("mixmat"),
            name: `${name}·正则`,
            hook: "从酒馆角色卡导入的正则脚本",
            rules: regexRules.map((r) => ({
                find: r.findRegex,
                replace: r.replaceString,
                mode: r.placement.includes(2) ? "context" : "display",
            })),
            private: true,
            createdAt: now,
            updatedAt: now,
        } as MixFilterMaterial);
    }

    // 卡里附带的预设 → 基底材料（按原顺序摊成文本，只收启用的条目）
    const presetHit = findTavernPresetObject(root, data, name);
    if (presetHit) {
        const presetText = flattenTavernPresetPrompts(presetHit.obj);
        if (presetText) {
            materials.push({
                kind: "base",
                id: createMixId("mixmat"),
                name: presetHit.name || `${name}·预设`,
                hook: "从酒馆角色卡导入的预设提示词",
                content: presetText,
                private: true,
                createdAt: now,
                updatedAt: now,
            } as MixTextMaterial);
        }
    }

    // system_prompt → 基底材料
    const systemPrompt = str(data.system_prompt);
    if (systemPrompt) {
        materials.push({
            kind: "base",
            id: createMixId("mixmat"),
            name: `${name}·系统提示`,
            hook: "从酒馆角色卡导入的系统提示",
            content: systemPrompt,
            private: true,
            createdAt: now,
            updatedAt: now,
        } as MixTextMaterial);
    }

    // post_history_instructions → 苦精材料（离生成最近的强化）
    const phi = str(data.post_history_instructions);
    if (phi) {
        materials.push({
            kind: "strength",
            id: createMixId("mixmat"),
            name: `${name}·追加指令`,
            hook: "从酒馆角色卡导入的追加指令",
            content: phi,
            private: true,
            createdAt: now,
            updatedAt: now,
        } as MixTextMaterial);
    }

    return materials;
}

/**
 * 酒馆示例对话（mes_example）→ examples。
 * 格式：<START> 分隔多段，段内每行以 {{user}}: / {{char}}: 开头。
 */
function parseMesExample(text: string): { role: "user" | "char"; text: string }[] {
    if (!text) return [];
    const out: { role: "user" | "char"; text: string }[] = [];
    for (const block of text.split(/<START>/i)) {
        for (const line of block.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const m = trimmed.match(/^\{\{(user|char)\}\}\s*[:：]\s*([\s\S]*)$/i);
            if (m) {
                const t = m[2].trim();
                if (t) out.push({ role: m[1].toLowerCase() === "user" ? "user" : "char", text: t });
            }
        }
    }
    return out;
}

/** 把封面 dataURL 画成 PNG 底图；无封面时画一张纯色占位卡 */
async function buildCardImage(card: MixMaterial): Promise<Uint8Array> {
    const W = 600;
    const H = 880;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持画布。");
    if (card.cover) {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error("封面解码失败"));
            el.src = card.cover as string;
        });
        // cover 填满裁切
        const scale = Math.max(W / img.width, H / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
        const grad = ctx.createLinearGradient(0, 0, W * 0.7, H);
        grad.addColorStop(0, "#2a2438");
        grad.addColorStop(0.55, "#161320");
        grad.addColorStop(1, "#0c0a12");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "rgba(242, 240, 247, 0.9)";
        ctx.font = "600 44px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(card.name.slice(0, 12), W / 2, H / 2);
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 编码失败"))), "image/png");
    });
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 导出一件材料为自有格式的 PNG 卡（图即是卡）。
 * 落盘统一走 downloadFile：iOS 上是系统分享面板，其余平台是普通下载——
 * 与应用市场、主题包、正则组这些导出保持同一种行为。
 */
export async function exportMixMaterialPng(material: MixMaterial): Promise<void> {
    const payload: MixTransferFile = { mark: FILE_MARK, version: FILE_VERSION, material };
    const base64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const png = insertPngTextChunk(await buildCardImage(material), PNG_KEYWORD, base64);
    const blob = new Blob([png.buffer as ArrayBuffer], { type: "image/png" });
    await downloadFile(blob, `${safeFileName(material.name)}.png`);
}

/** 导出一件材料为 .json 文件（同上：iOS 走系统分享） */
export async function exportMixMaterial(material: MixMaterial): Promise<void> {
    const payload: MixTransferFile = { mark: FILE_MARK, version: FILE_VERSION, material };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    await downloadFile(blob, `${safeFileName(material.name)}.json`);
}

function isMixKind(value: unknown): value is MixMaterialKind {
    return typeof value === "string" && (MIX_SLOT_ORDER as string[]).includes(value);
}

/**
 * AI 代写的 JSON 有两类高频毛病，直接 JSON.parse 会挂，导入前先救一把：
 * ① 包了 ``` 代码围栏、或前后带了说明文字——掐出首个 { 到最后一个 } 之间的部分；
 * ② 字符串值里混进了真实换行/制表符（JSON 不允许控制字符）——就地转义。
 * 修不动的结构错误（少括号、缺逗号）照旧报"不是有效的 JSON"，不做魔改猜测。
 */
function repairJsonText(text: string): string | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let body = fenced ? fenced[1] : text;
    const objStart = body.indexOf("{");
    const arrStart = body.indexOf("[");
    const start = objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start < 0 || end <= start) return null;
    body = body.slice(start, end + 1);
    let out = "";
    let inStr = false;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (!inStr) {
            if (ch === '"') inStr = true;
            out += ch;
            continue;
        }
        if (ch === "\\") { out += ch + (body[i + 1] ?? ""); i++; continue; }
        if (ch === '"') { inStr = false; out += ch; continue; }
        if (ch === "\n") { out += "\\n"; continue; }
        if (ch === "\r") continue;
        if (ch === "\t") { out += "\\t"; continue; }
        out += ch;
    }
    return out;
}

/**
 * 解析导入的 JSON 文本。
 * 兼容三种写法：本工具导出的带壳文件、裸材料对象、以及一次多件的数组。
 * 导入一律换新 id，避免覆盖酒柜里的同名旧件。
 */
export function parseMixMaterialsFromJson(text: string): MixMaterial[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        const repaired = repairJsonText(text);
        try {
            parsed = JSON.parse(repaired ?? "");
        } catch {
            throw new Error("这不是一个有效的 JSON 文件。");
        }
    }

    const candidates: unknown[] = [];
    const collect = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(collect);
            return;
        }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (record.mark === FILE_MARK && record.material) {
            collect(record.material);
            return;
        }
        candidates.push(record);
    };
    collect(parsed);

    const now = Date.now();
    const materials: MixMaterial[] = [];
    for (const candidate of candidates) {
        const record = candidate as Record<string, unknown>;
        if (!isMixKind(record.kind)) continue;
        const name = typeof record.name === "string" ? record.name.trim() : "";
        if (!name) continue;
        // 角色卡至少要有一句开场白，否则开不了局
        if (record.kind === "character") {
            const openings = Array.isArray(record.openings)
                ? record.openings.filter((o): o is string => typeof o === "string" && Boolean(o.trim()))
                : [];
            if (openings.length === 0) continue;
            // 文件导入一律视为自己的本地作品：换新 id、剥掉发布关联与导入标记，
            // 修改/导出/发布全部照常（酒材页入柜的"别人的作品"限制与此无关）
            materials.push({
                ...(record as unknown as MixMaterial),
                id: createMixId("mixmat"),
                publishedId: undefined,
                publishedAt: undefined,
                imported: undefined,
                name,
                openings,
                createdAt: now,
                updatedAt: now,
            } as MixMaterial);
            continue;
        }
        materials.push({
            ...(record as unknown as MixMaterial),
            id: createMixId("mixmat"),
            publishedId: undefined,
            publishedAt: undefined,
            imported: undefined,
            name,
            createdAt: now,
            updatedAt: now,
        } as MixMaterial);
    }

    if (materials.length === 0) {
        // 酒馆卡（SillyTavern V2/V3）等第三方 JSON：自动适配为私人角色卡，而不是"认不出来"
        const isThirdPartyCard = (value: unknown): boolean => {
            if (!value || typeof value !== "object") return false;
            const record = value as Record<string, unknown>;
            const spec = typeof record.spec === "string" ? record.spec : "";
            if (/^chara_card/i.test(spec)) return true;
            if ("first_mes" in record || "mes_example" in record) return true;
            const data = record.data;
            return Boolean(data && typeof data === "object" && "first_mes" in (data as Record<string, unknown>));
        };
        const thirdParty = candidates.find(isThirdPartyCard);
        if (thirdParty) {
            const mapped = parseSillyTavernCharacterCard(thirdParty);
            if (mapped.length) return mapped;
            throw new Error("这张酒馆卡里没有能认出来的角色数据。");
        }
        throw new Error("文件里没有能认出来的材料。");
    }
    return materials;
}

// ── 配方文件（整杯打包） ─────────────────────────────
// 材料文件之外的第二种文件：配方本体 + 它引用的全部非官方材料。
// 材料保留原 id——槽位靠 id 引用材料，改 id 就断链；官方出厂件导入端自带，只留引用。

const RECIPE_FILE_MARK = "float-mixology-recipe";

type MixRecipeTransferFile = {
    mark: typeof RECIPE_FILE_MARK;
    version: number;
    recipe: MixRecipe;
    materials: MixMaterial[];
};

/** 导出一杯配方为 .json 文件：配方 + 引用的全部非官方材料打包 */
export async function exportMixRecipeFile(recipe: MixRecipe): Promise<void> {
    const ids = [...new Set(Object.values(recipe.slots).flatMap((entries) => (entries ?? []).map((e) => e.materialId)))];
    const materials = ids
        .map((id) => getMixMaterial(id))
        .filter((m): m is MixMaterial => Boolean(m) && !isMixBuiltinId(m!.id))
        // 云端关联是导出者自己的，不随文件走；imported 由导入端按来源重新打
        .map(({ publishedId: _p, publishedAt: _a, imported: _i, ...rest }) => rest as MixMaterial);
    const { publishedId: _p, publishedAt: _a, imported: _i, ...cleanRecipe } = recipe;
    const payload: MixRecipeTransferFile = { mark: RECIPE_FILE_MARK, version: FILE_VERSION, recipe: cleanRecipe as MixRecipe, materials };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    await downloadFile(blob, `${safeFileName(recipe.name)}.配方.json`);
}

/**
 * 解析配方文件。不是配方文件（材料文件、别的 JSON）返回 null，
 * 让调用方退回材料解析；是配方文件但内容坏了才抛错。
 */
export function parseMixRecipeFile(text: string): { recipe: MixRecipe; materials: MixMaterial[] } | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.mark !== RECIPE_FILE_MARK) return null;
    const rawRecipe = record.recipe as Record<string, unknown> | undefined;
    if (!rawRecipe || typeof rawRecipe !== "object") throw new Error("配方文件缺少配方本体。");
    const name = typeof rawRecipe.name === "string" ? rawRecipe.name.trim() : "";
    const slotsRaw = rawRecipe.slots;
    if (!name || !slotsRaw || typeof slotsRaw !== "object") throw new Error("配方文件缺少名称或槽位。");
    // 槽位只收认识的种类与合法条目；条件原样带过（渲染端自会容错）
    const slots: MixRecipe["slots"] = {};
    for (const kind of MIX_SLOT_ORDER) {
        const entries = (slotsRaw as Record<string, unknown>)[kind];
        if (!Array.isArray(entries)) continue;
        const kept: MixSlotEntry[] = entries
            .filter((e): e is { materialId: string; when?: unknown } =>
                Boolean(e) && typeof e === "object" && typeof (e as Record<string, unknown>).materialId === "string")
            .map((e) => ({ materialId: e.materialId, when: e.when } as MixSlotEntry));
        if (kept.length) slots[kind] = kept;
    }
    if (!slots.character?.length) throw new Error("配方文件缺角色卡槽。");
    const materialsRaw = Array.isArray(record.materials) ? record.materials : [];
    const materials: MixMaterial[] = [];
    for (const candidate of materialsRaw) {
        if (!candidate || typeof candidate !== "object") continue;
        const m = candidate as Record<string, unknown>;
        if (!isMixKind(m.kind)) continue;
        if (typeof m.id !== "string" || !m.id.trim()) continue;
        if (typeof m.name !== "string" || !m.name.trim()) continue;
        materials.push(m as unknown as MixMaterial);
    }
    const id = typeof rawRecipe.id === "string" && rawRecipe.id.trim() ? rawRecipe.id : createMixId("mixrec");
    const now = Date.now();
    return {
        recipe: {
            id,
            name,
            slots,
            author: typeof rawRecipe.author === "string" ? rawRecipe.author : undefined,
            createdAt: typeof rawRecipe.createdAt === "number" ? rawRecipe.createdAt : now,
            updatedAt: now,
        },
        materials,
    };
}

/**
 * 把解析出的配方包落库。配方与材料都打 imported——他人作品：
 * 配方可以换用材料（搭配可改），材料内容不可编辑、都不能发布，角色卡正文封存。
 * 材料按 id 落柜（槽位靠 id 引用）：柜里同 id 的自己原件保留沿用，
 * 已导入的同 id 覆盖更新；配方同理，自己的原杯不覆盖。
 * 返回给用户看的结果说明。
 */
export function importMixRecipePack(pack: { recipe: MixRecipe; materials: MixMaterial[] }, author?: string): string {
    const signed = author?.trim() || undefined;
    let kept = 0;
    for (const material of pack.materials) {
        const existing = getMixMaterial(material.id);
        if (existing && !existing.imported) {
            kept += 1;
            continue;
        }
        saveMixMaterial({ ...material, imported: true, author: signed || material.author });
    }
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MIX_CABINET_UPDATED_EVENT));
    const keptNote = kept > 0 ? `（其中 ${kept} 味柜里已有你自己的原件，直接沿用）` : "";
    const prior = loadMixRecipes().find((r) => r.id === pack.recipe.id);
    if (prior && !prior.imported) {
        return `配方「${prior.name}」已是吧台里你自己的原杯，未覆盖；${pack.materials.length} 味材料已处理${keptNote}`;
    }
    saveMixRecipe({
        ...pack.recipe,
        imported: true,
        author: signed || pack.recipe.author,
        createdAt: prior?.createdAt ?? pack.recipe.createdAt,
    });
    return `配方「${pack.recipe.name}」已入吧台，${pack.materials.length} 味材料入柜${keptNote}——导入的作品不能发布，材料内容不可改，搭配可以自己换`;
}
