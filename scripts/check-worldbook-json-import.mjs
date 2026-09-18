#!/usr/bin/env node
// 世界书 JSON 上传的格式兼容性校验
//
// 背景：同为一本世界书，夹在角色卡里导入能进（走酒馆解析器），
// 单独在「设置 → 世界书 → 导入世界书 (JSON)」上传却被判「不支持该世界书格式」。
// 本脚本用真实样例跑一遍解析器，钉住两件事：
//   ① 过去确实拒收（parseWorldBookFromJson 对酒馆格式抛 UNSUPPORTED_IMPORT_FORMAT）——这是改动的原因
//   ② 现在能收，且解析结果与角色卡那条路一致（条目数/触发词/位置映射/分类都对齐）
//
// 用法: node scripts/check-worldbook-json-import.mjs
// 退出码非 0 = 兼容层坏了。

import { register } from "node:module";
// Windows 上必须用 fileURLToPath：new URL(...).pathname 会得到带前导斜杠且百分号编码的路径
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const hooks = `
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import ts from ${JSON.stringify(pathToFileURL(path.join(root, "node_modules/typescript/lib/typescript.js")).href)};

const ROOT = ${JSON.stringify(root)};
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx", ".mjs", ".js"];
const STUBS = { dexie: "export default class Dexie { version(){return{stores(){return{upgrade(){}}}}} table(){return{}} open(){return Promise.resolve()} }" };

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) {
    return { url: "data:text/javascript;base64," + Buffer.from(STUBS[specifier]).toString("base64"), shortCircuit: true, format: "module" };
  }
  let spec = specifier;
  if (spec.startsWith("@/")) spec = pathToFileURL(resolvePath(ROOT, spec.slice(2))).href;
  else if (spec.startsWith(".") && context.parentURL?.startsWith("file:")) {
    spec = pathToFileURL(resolvePath(dirname(fileURLToPath(context.parentURL)), spec)).href;
  } else return next(specifier, context);
  for (const ext of EXTS) {
    try { readFileSync(fileURLToPath(spec + ext)); return { url: spec + ext, shortCircuit: true, format: "module" }; } catch {}
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.endsWith(".ts") && !url.endsWith(".tsx")) return next(url, context);
  const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
    fileName: fileURLToPath(url),
  }).outputText;
  return { format: "module", shortCircuit: true, source: out };
}
`;

register("data:text/javascript;base64," + Buffer.from(hooks).toString("base64"), pathToFileURL(root + "/"));

const { importWorldBookFromJsonText } = await import(
    pathToFileURL(path.join(root, "lib/worldbook-json-import.ts")).href
);
const { parseWorldBookFromJson, UNSUPPORTED_IMPORT_FORMAT } = await import(
    pathToFileURL(path.join(root, "lib/settings-storage.ts")).href
);

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) {
        pass++;
        return true;
    }
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    return false;
}
const J = (v) => JSON.stringify(v);

// ── 样例：本应用自己导出的格式 ──────────────────────────
const NATIVE = {
    id: "wb-1",
    name: "本应用世界书",
    description: "",
    createdAt: 1,
    updatedAt: 2,
    entries: [
        {
            uid: "e1",
            key: "青丘",
            content: "青丘是九尾狐的故乡。",
            comment: "地理",
            use_regex: false,
            disable: false,
            constant: true,
            position: "before_char",
            depth: 0,
            probability: 100,
            useProbability: false,
            role: 0,
            insertion_order: 100,
        },
    ],
};

// ── 样例：酒馆（SillyTavern）单独导出的世界书 ────────────
// 这一份就是过去被拒收的形态：entries 是字典 + 条目带 selectiveLogic / extensions
const ST_BOOK = {
    name: "酒馆世界书",
    description: "测试用",
    entries: {
        0: {
            uid: 0,
            key: ["青丘", "九尾"],
            keysecondary: [],
            comment: "地理·青丘",
            content: "青丘是九尾狐的故乡。",
            constant: true,
            selective: false,
            selectiveLogic: 0,
            addMemo: true,
            order: 100,
            position: 0,
            disable: false,
            excludeRecursion: false,
            probability: 100,
            useProbability: true,
            extensions: { position: 0, depth: 4, probability: 100 },
        },
        1: {
            uid: 1,
            key: ["昆仑"],
            keysecondary: ["西王母"],
            comment: "地理·昆仑",
            content: "昆仑之丘，西王母所居。",
            constant: false,
            selective: true,
            selectiveLogic: 3,
            order: 90,
            position: 1,
            disable: false,
            extensions: {},
        },
    },
};

// ── 样例：角色卡 JSON（取卡里内嵌的世界书）──────────────
const CARD = {
    name: "某角色",
    description: "角色描述",
    personality: "性格",
    scenario: "场景",
    system_prompt: "write {{char}}'s next reply",
    post_history_instructions: "卡特有追加指令，不该进世界书。",
    character_book: {
        name: "卡内世界书",
        entries: [
            { keys: ["苏黎"], content: "苏黎是主角。", comment: "人物", extensions: {} },
        ],
    },
};

// ── 样例：嵌套字典（文件夹直接当键）─────────────────────
const NESTED = {
    地理: { 青丘国: "青丘是九尾狐的故乡。", 昆仑: "昆仑之丘，西王母所居。" },
    人物: { 苏黎: "苏黎是主角。" },
};

// ── 样例：裸条目数组 ────────────────────────────────────
const ARR = [
    { comment: "条目一", content: "内容一", keys: ["甲"] },
    { comment: "条目二", content: "内容二", keys: ["乙"] },
];

// ── ① 先证明「过去确实拒收」─────────────────────────────
{
    let threw = "";
    try {
        parseWorldBookFromJson(JSON.stringify(ST_BOOK));
    } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
    }
    ok("过去：酒馆格式被 native 解析器拒收", threw === UNSUPPORTED_IMPORT_FORMAT, `threw=${J(threw)}`);

    let threwCard = "";
    try {
        const b = parseWorldBookFromJson(JSON.stringify(CARD));
        threwCard = b ? `entries=${b.entries.length}` : "null";
    } catch (e) {
        threwCard = e instanceof Error ? e.message : String(e);
    }
    ok("过去：角色卡 JSON 在 native 解析器里拿不到任何条目", threwCard === "entries=0", `got=${threwCard}`);

    const nativeBook = parseWorldBookFromJson(JSON.stringify(NATIVE));
    ok(
        "native 格式仍按原样解析（改动没有影响本应用自己的导出）",
        nativeBook && nativeBook.entries.length === 1 && nativeBook.entries[0].key === "青丘",
        J(nativeBook && nativeBook.entries.map((e) => e.key))
    );
}

// ── ② 现在：本应用格式走 native 分支，字段一个不改 ────────
{
    const r = importWorldBookFromJsonText(JSON.stringify(NATIVE), "兜底名");
    ok("native 分支命中", !!r && r.source === "native", J(r && r.source));
    ok("native 分支条目数正确", !!r && r.entryCount === 1, J(r && r.entryCount));
    ok("native 分支书名取自文件", !!r && r.book.name === "本应用世界书", J(r && r.book.name));
    ok(
        "native 分支条目字段原样保留",
        !!r && r.book.entries[0].key === "青丘" && r.book.entries[0].constant === true && r.book.entries[0].position === "before_char",
        J(r && r.book.entries[0])
    );
    ok("native 分支不报 megaSplit", !!r && r.megaSplit === false);
}

// ── ③ 现在：酒馆单独导出的世界书能进 ────────────────────
{
    const r = importWorldBookFromJsonText(JSON.stringify(ST_BOOK), "世界书");
    ok("酒馆格式能被接收（核心修复）", !!r, "返回了 null");
    if (r) {
        ok("酒馆格式来源标记为 tavern", r.source === "tavern", J(r.source));
        ok("酒馆格式条目数正确", r.entryCount === 2, J(r.entryCount));
        ok("酒馆格式书名取自文件", r.book.name === "酒馆世界书", J(r.book.name));
        ok("字典形态 entries 被展开成数组", Array.isArray(r.book.entries) && r.book.entries.length === 2);
        const e0 = r.book.entries.find((e) => e.content.includes("青丘"));
        const e1 = r.book.entries.find((e) => e.content.includes("昆仑"));
        ok("触发词被带过来（key 数组 → 逗号串）", !!e0 && e0.key.includes("青丘") && e0.key.includes("九尾"), J(e0 && e0.key));
        ok("酒馆 position 0 → before_char", !!e0 && e0.position === "before_char", J(e0 && e0.position));
        ok("酒馆 position 1 → after_char", !!e1 && e1.position === "after_char", J(e1 && e1.position));
        ok("常驻标记保留", !!e0 && e0.constant === true, J(e0 && e0.constant));
        ok(
            "选择性条目只保留主触发词",
            !!e1 && e1.key === "昆仑" && !e1.key.includes("西王母"),
            J(e1 && e1.key)
        );
        ok("entry.uid 非空且唯一", new Set(r.book.entries.map((e) => e.uid)).size === 2);
        ok("description 记录了条目数", r.book.description.includes("2 条"), r.book.description);
    }
}

// ── ④ 现在：角色卡 JSON 也能当世界书传 ──────────────────
{
    const r = importWorldBookFromJsonText(JSON.stringify(CARD), "世界书");
    ok("角色卡 JSON 能被接收", !!r, "返回了 null");
    if (r) {
        ok("角色卡来源标记为 card", r.source === "card", J(r.source));
        ok("取的是卡内世界书的名字", r.book.name === "卡内世界书", J(r.book.name));
        ok("只取世界书条目，不带角色卡特有字段", r.entryCount === 1, J(r.entryCount));
        ok(
            "角色卡特有指令没有被塞成条目",
            !r.book.entries.some((e) => e.content.includes("卡特有追加指令")),
            J(r.book.entries.map((e) => e.content))
        );
    }
}

// ── ⑤ 嵌套字典 / 裸数组 / 垃圾输入 ──────────────────────
{
    const r = importWorldBookFromJsonText(JSON.stringify(NESTED), "世界书");
    ok("嵌套字典能解析", !!r && r.entryCount === 3, J(r && r.entryCount));
    ok("嵌套字典保留分类", !!r && r.categoryCount >= 2, J(r && r.categoryCount));
    ok("分类写进了条目", !!r && r.book.entries.some((e) => (e.category || "").includes("地理")), J(r && r.book.entries.map((e) => e.category)));

    const a = importWorldBookFromJsonText(JSON.stringify(ARR), "世界书");
    ok("裸条目数组能解析", !!a && a.entryCount === 2, J(a && a.entryCount));
    ok("裸数组条目触发词正确", !!a && a.book.entries.map((e) => e.key).sort().join("|") === "乙|甲", J(a && a.book.entries.map((e) => e.key)));

    ok("无效 JSON 返回 null 而不是抛错", importWorldBookFromJsonText("{oops") === null);
    ok("无条目对象返回 null", importWorldBookFromJsonText(JSON.stringify({ hello: 1 })) === null);
    ok("空 entries 返回 null", importWorldBookFromJsonText(JSON.stringify({ entries: [] })) === null);
    ok("内容是空的条目不算数", importWorldBookFromJsonText(JSON.stringify([{ keys: ["x"], content: "   " }])) === null);
    ok("JSON 标量返回 null", importWorldBookFromJsonText("42") === null);
}

// ── ⑥ 上传入口确实换成了兼容层（防回归）────────────────
{
    const src = readFileSync(path.join(root, "components/settings/worldbook-manager.tsx"), "utf8");
    ok("上传入口调用兼容层", src.includes("importWorldBookFromJsonText(text, file.name.replace(/\\.[^.]+$/, \"\"))"));
    ok("上传入口不再直接用 native 解析器", !src.includes("parseWorldBookFromJson(text)"));
    const lib = readFileSync(path.join(root, "lib/worldbook-json-import.ts"), "utf8");
    ok("兼容层复用了酒馆解析器", lib.includes("parseTavernWorldBook("));
    ok("兼容层复用了 native 解析器", lib.includes("parseWorldBookFromJson("));
    ok("兼容层没有自己重写条目解析", !lib.includes("function buildEntry") && !lib.includes("insertion_order:"));
    ok("兼容层不带入角色卡特有条目", lib.includes("g.extraOnly"));
}

// ── 输出 ────────────────────────────────────────────────
if (failures.length) {
    console.error(`\n❌ 世界书 JSON 兼容性校验失败 ${failures.length} 项（通过 ${pass} 项）：\n`);
    for (const f of failures) console.error(`   · ${f}`);
    process.exit(1);
}
console.log(`✅ 世界书 JSON 兼容性校验通过：${pass} 项断言全绿`);
