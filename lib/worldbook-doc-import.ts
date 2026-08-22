// 从 Word / 文本文档批量生成世界书（加性模块，不修改任何现有世界书逻辑）。
// 每个文档 → 一本世界书，内容作为一条完整条目；支持 .docx / .doc / .txt，可一次多选。
import JSZip from "jszip";
import { createWorldBook } from "./settings-storage";
import type { WorldBookConfig, WorldBookEntry } from "./settings-types";

function stripExt(name: string): string {
    return name.replace(/\.[^.]+$/, "");
}

function makeEntryUid(): string {
    return `wb-entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeWorldBookText(text: string): string {
    return String(text || "")
        .replace(/\r\n?/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ── .docx：zip 内 word/*.xml 提取 <w:t> 文本 ──
async function readDocxText(file: File): Promise<string> {
    const zip = await JSZip.loadAsync(file);
    const targets = Object.keys(zip.files).filter((name) => {
        if (!/^word\/.+\.xml$/i.test(name)) return false;
        return /^word\/(document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/i.test(name);
    });
    const rank = (name: string) =>
        name === "word/document.xml" ? 0 : name.includes("/header") ? 1 : name.includes("/footer") ? 2 : 3;
    targets.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

    const parts: string[] = [];
    for (const path of targets) {
        const entry = zip.file(path);
        if (!entry) continue;
        const xml = await entry.async("text");
        const text = extractWordXmlText(xml);
        if (text) parts.push(text);
    }
    return parts.join("\n\n");
}

function extractWordXmlText(xml: string): string {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("DOCX 内容解析失败");
    const chunks: string[] = [];
    const pushNewline = () => {
        if (chunks.length && chunks[chunks.length - 1] !== "\n") chunks.push("\n");
    };
    const walk = (node: Node) => {
        if (node.nodeType !== 1) return;
        const name = (node as Element).localName;
        if (name === "t") {
            chunks.push(node.textContent || "");
            return;
        }
        if (name === "tab") {
            chunks.push("\t");
            return;
        }
        if (name === "br" || name === "cr") {
            pushNewline();
            return;
        }
        Array.from(node.childNodes).forEach(walk);
        if (name === "p") pushNewline();
    };
    walk(doc.documentElement);
    return chunks.join("");
}

// ── .doc 旧版二进制：UTF-16LE 可读段启发式提取 ──
function isReadableDocChar(code: number): boolean {
    return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd)
    );
}

function extractUtf16LeRuns(bytes: Uint8Array): string {
    const runs: string[] = [];
    for (let offset = 0; offset < 2; offset++) {
        let current = "";
        for (let i = offset; i + 1 < bytes.length; i += 2) {
            const code = bytes[i] | (bytes[i + 1] << 8);
            if (isReadableDocChar(code)) {
                current += String.fromCharCode(code);
            } else {
                if (current.trim().length >= 4) runs.push(current);
                current = "";
            }
        }
        if (current.trim().length >= 4) runs.push(current);
    }
    return runs.join("\n");
}

async function readLegacyDocText(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const utf16 = extractUtf16LeRuns(bytes);
    if (utf16.length > 20) return utf16;
    const decoded = await file.text();
    return decoded.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]+/g, " ");
}

export async function extractTextFromWordFile(file: File): Promise<string> {
    const name = (file.name || "").toLowerCase();
    let raw: string;
    if (name.endsWith(".docx")) raw = await readDocxText(file);
    else if (name.endsWith(".txt")) raw = await file.text();
    else if (name.endsWith(".doc")) raw = await readLegacyDocText(file);
    else throw new Error("仅支持 .doc / .docx / .txt 文件");
    return normalizeWorldBookText(raw);
}

export async function buildWorldBookFromDoc(file: File): Promise<WorldBookConfig> {
    const text = await extractTextFromWordFile(file);
    if (!text) throw new Error("未能从文档中提取到文本内容");
    const book = createWorldBook(stripExt(file.name));
    const entry: WorldBookEntry = {
        uid: makeEntryUid(),
        key: "",
        content: text,
        comment: `来源：${file.name}`,
        use_regex: false,
        disable: false,
        // 文档导入的世界书本质是「常驻参考/行为准则」（如说话风格指南），不是按关键词触发的
        // 情境设定；空 key + constant=false 会导致 isWorldBookEntryActivated 永远返回 false
        // （静默不生效）。因此默认 constant=true（常驻），用户可在世界书编辑里按需关闭。
        constant: true,
        position: "before_char",
        depth: 0,
        probability: 100,
        useProbability: false,
        role: 0,
        insertion_order: 50,
    };
    book.entries = [entry];
    return book;
}

export type DocImportResult = {
    books: WorldBookConfig[];
    skipped: { name: string; reason: string }[];
};

export async function importWorldBooksFromDocs(files: File[]): Promise<DocImportResult> {
    const books: WorldBookConfig[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const file of files) {
        try {
            books.push(await buildWorldBookFromDoc(file));
        } catch (err) {
            skipped.push({ name: file.name, reason: err instanceof Error ? err.message : "导入失败" });
        }
    }
    return { books, skipped };
}
