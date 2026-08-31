// verify-card-import.mjs
// 第三方角色卡（酒馆 V2/V3）导入「世界书按分类拆解 + 正则/预设适配」上线即通验证。
//
// 两部分：
//  A. 静态接线断言：读真实源码，确认新模块真的被小手机导入流程与特调导入流程接上，
//     旧的一坨式提取已经拆掉（专治「编译过、调用点没真接」）。
//  B. 运行时逻辑：直接 import lib/tavern-card-parse.ts 跑真函数（纯函数、无浏览器依赖，
//     用 node --experimental-strip-types 直跑，不复制一份复刻逻辑），
//     覆盖分类/切分/触发词补全/常驻兜底/正则/预设/系统提示这些真正会出错的地方。
//
// 运行：node --experimental-strip-types verify-card-import.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const F = {
    parse: ROOT + "lib/tavern-card-parse.ts",
    importer: ROOT + "lib/tavern-card-import.ts",
    charStorage: ROOT + "lib/character-storage.ts",
    phoneApp: ROOT + "components/phone-character-app.tsx",
    mixTransfer: ROOT + "lib/mixology/transfer.ts",
    changelog: ROOT + "lib/changelog.ts",
};
for (const [k, f] of Object.entries(F)) {
    if (!existsSync(f)) { console.error("源码缺失: " + f); process.exit(2); }
}

let failed = 0;
function check(label, cond, detail = "") {
    const mark = cond ? "PASS" : "FAIL";
    if (!cond) failed++;
    console.log(`[${mark}] ${label}${detail ? "  -> " + detail : ""}`);
}
const src = (k) => readFileSync(F[k], "utf8");

console.log("── A. 静态接线 ──");

const parseSrc = src("parse");
const importerSrc = src("importer");
const phoneSrc = src("phoneApp");
const mixSrc = src("mixTransfer");
const charSrc = src("charStorage");
const changelogSrc = src("changelog");

check("A1 解析模块导出分类解析", /export function parseTavernWorldBook/.test(parseSrc));
check("A2 解析模块导出分类路径提取", /export function extractTavernCategoryPath/.test(parseSrc));
check("A3 解析模块导出超长内容切分", /export function splitMegaContent/.test(parseSrc));
check("A4 解析模块导出触发词补全", /export function deriveTavernKeys/.test(parseSrc));
check("A5 解析模块导出正则收集", /export function collectTavernRegexScripts/.test(parseSrc));
check("A6 解析模块导出预设探测", /export function findTavernPresetObject/.test(parseSrc));
check("A7 解析模块导出系统设定条目", /export function collectTavernExtraEntries/.test(parseSrc));
check("A8 解析模块零浏览器依赖（不碰 window/localStorage）",
    !/\bwindow\.|localStorage|indexedDB/.test(parseSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));

check("A9 落库模块按分类建多本世界书", /for \(const group of parsedBook\.groups\)/.test(importerSrc) && /createWorldBook\(/.test(importerSrc));
check("A10 落库模块保存并绑定世界书", /saveWorldBooks\(/.test(importerSrc) && /worldBookIds/.test(importerSrc));
check("A11 落库模块保存正则组并绑定", /saveRegexes\(/.test(importerSrc) && /regexIds/.test(importerSrc));
check("A12 落库模块导入预设但不自动绑定 presetId", /savePresets\(/.test(importerSrc) && !/presetId:/.test(importerSrc));
check("A13 落库模块 PNG 同时认 ccv3 与 chara", /"ccv3"/.test(importerSrc) && /"chara"/.test(importerSrc));
check("A14 character-storage 导出 PNG 文本块读取供复用", /export function readPngTextChunk/.test(charSrc));

check("A15 小手机 JSON 导入走新流程", /importCardExtras\(readTavernCardFromJsonText\(text\)/.test(phoneSrc));
check("A16 小手机 PNG 导入走新流程", /importCardExtras\(readTavernCardFromPng\(buffer\)/.test(phoneSrc));
check("A17 旧的一坨式提取已移除", !/extractSillyTavernWorldBookFrom/.test(phoneSrc) && !/attachEmbeddedWorldBook/.test(phoneSrc));
check("A18 旧的一坨式提取函数已从 character-storage 删除", !/export function extractSillyTavernWorldBookFromPng/.test(charSrc));

check("A19 特调侧复用同一套世界书分类解析", /parseTavernWorldBook\(data, name\)/.test(mixSrc));
check("A20 特调侧正则转滤网材料", /kind: "filter"/.test(mixSrc) && /collectTavernRegexScripts\(/.test(mixSrc));
check("A21 特调侧不再拼一坨世界书", !/name: `\$\{name\}·世界书`,/.test(mixSrc));
check("A22 特调侧预设摊成基底材料", /flattenTavernPresetPrompts\(/.test(mixSrc));

check("A23 V3 卡 assets 里带的图可作头像兜底", /src\.assets/.test(charSrc) && /validAvatar\(asset\.uri/.test(charSrc));
check("A24 changelog 版本已升到 1.7.68", /APP_VERSION = "1\.7\.68"/.test(changelogSrc));
check("A25 changelog 头部记录了本次改动", /version: "1\.7\.68"/.test(changelogSrc) && /特调世界书按分类拆解/.test(changelogSrc));

console.log("\n── B. 运行时逻辑（跑真函数）──");

let P;
try {
    P = await import("./lib/tavern-card-parse.ts");
    check("B0 真实解析模块可被 node 直接加载", true);
} catch (e) {
    check("B0 真实解析模块可被 node 直接加载", false, String(e && e.message));
    console.log(`\n结果：${failed} 项失败`);
    process.exit(1);
}

const {
    unwrapTavernCard,
    parseTavernWorldBook,
    buildFolderNameMap,
    extractTavernCategoryPath,
    deriveTavernKeys,
    splitMegaContent,
    mapTavernPosition,
    collectTavernRegexScripts,
    findTavernPresetObject,
    flattenTavernPresetPrompts,
    collectTavernExtraEntries,
    describeCategories,
} = P;

// —— B1 分类识别（用户抱怨的「地理文件夹没提炼出来」）——
check("B1.1 category 字段识别", JSON.stringify(extractTavernCategoryPath({ category: "地理", comment: "青丘" })) === '["地理"]');
check("B1.2 多级文件夹路径拆分", JSON.stringify(extractTavernCategoryPath({ category: "地理/城市" })) === '["地理","城市"]');
check("B1.3 comment 括号前缀识别", JSON.stringify(extractTavernCategoryPath({ comment: "【地理】青丘国" })) === '["地理"]');
check("B1.4 comment 路径前缀识别", JSON.stringify(extractTavernCategoryPath({ comment: "地理/青丘国" })) === '["地理"]');
check("B1.5 extensions 里的分类兜底", JSON.stringify(extractTavernCategoryPath({ extensions: { folder: "组织" } })) === '["组织"]');
check("B1.6 普通标题不被误判成分类", JSON.stringify(extractTavernCategoryPath({ comment: "青丘国" })) === "[]");
check("B1.7 带句读的斜杠不是路径", JSON.stringify(extractTavernCategoryPath({ comment: "早上/晚上，他都在" })) === "[]");
check("B1.8 文件夹 id 按书里的文件夹表翻译成名字",
    JSON.stringify(extractTavernCategoryPath({ folder: "f_007" }, buildFolderNameMap({ folders: [{ id: "f_007", name: "地理" }] }))) === '["地理"]');
check("B1.9 文件夹表缺失时 id 原样保留（不猜）",
    JSON.stringify(extractTavernCategoryPath({ folder: "f_007" })) === '["f_007"]');

// —— B1 续：用户真机卡里会遇到的「文件夹里含子文件夹」——
const folderTreeBook = {
    folders: [
        { id: "f_geo", name: "地理", parent: null },
        { id: "f_sub", name: "青丘国", parent: "f_geo" },
        { id: "f_ppl", name: "人物", parent: null },
    ],
};
check("B1.10 父级文件夹链拼成 地理/青丘国",
    JSON.stringify(extractTavernCategoryPath({ folder: "f_sub" }, buildFolderNameMap(folderTreeBook))) === '["地理","青丘国"]');
check("B1.11 数字文件夹 id 也能解析",
    JSON.stringify(extractTavernCategoryPath({ folder: 2 }, buildFolderNameMap({
        folders: [{ id: 1, name: "地理", parent: null }, { id: 2, name: "青丘国", parent: 1 }],
    }))) === '["地理","青丘国"]');
check("B1.12 多文件夹数组取首个可解析的",
    JSON.stringify(extractTavernCategoryPath({ folder: ["f_ppl", "f_sub"] }, buildFolderNameMap(folderTreeBook))) === '["人物"]');

// —— B1 续：整本世界书格式直接跑回真实分组 ——
const nestedBook = parseTavernWorldBook({
    name: "角色",
    character_book: {
        name: "世界观",
        地理: { 青丘国: "青丘是狐国，位于东方。", 昆仑: "昆仑是神山。" },
        人物: { 陛下: "陛下统治青丘。", 将军: "将军镇守边关。" },
    },
}, "角色");
check("B1.13 嵌套字典世界书被识别（不再 null）", !!nestedBook);
check("B1.14 嵌套字典按顶层文件夹分两类", nestedBook && JSON.stringify(nestedBook.stats.categories) === '["地理","人物"]');

const parentChainBook = parseTavernWorldBook({
    name: "角色",
    character_book: {
        name: "世界观",
        entries: [
            { id: "1", keys: ["青丘"], content: "青丘是狐国。", folder: "f_sub", insertion_order: 1 },
            { id: "2", keys: ["陛下"], content: "陛下统治。", folder: "f_ppl", insertion_order: 2 },
        ],
        folders: [
            { id: "f_geo", name: "地理", parent: null },
            { id: "f_sub", name: "青丘国", parent: "f_geo" },
            { id: "f_ppl", name: "人物", parent: null },
        ],
    },
}, "角色");
check("B1.15 标准 entries + 文件夹父级链拆出 地理/青丘国",
    parentChainBook && JSON.stringify(parentChainBook.stats.categories) === '["地理/青丘国","人物"]');


// —— B2 触发词补全 + 常驻兜底（导入了却永不生效的核心坑）——
const noKey = parseTavernWorldBook(
    {
        character_book: {
            name: "设定集",
            entries: [
                { keys: [], comment: "青丘国", content: "青丘是九尾狐的故乡。" },
                { keys: ["狐火"], comment: "狐火", content: "蓝色的火焰。" },
                {},
            ],
        },
    },
    "测试角色"
);
check("B2.1 无 keys 的条目补全了触发词", noKey.groups[0].entries[0].key.includes("青丘国"), noKey.groups[0].entries[0].key);
check("B2.2 补全的条目不再被设成常驻", noKey.groups[0].entries[0].constant === false);
check("B2.3 有 keys 的条目保持原触发词", noKey.groups[0].entries[1].key === "狐火");
check("B2.4 空条目被丢弃", noKey.stats.entries === 2, `entries=${noKey.stats.entries}`);
check("B2.5 完全没有可提炼信息才退化常驻", (() => {
    const book = parseTavernWorldBook({ character_book: { entries: [{ content: "。！？" }] } }, "X");
    return book.groups[0].entries[0].constant === true && book.stats.forcedConstant === 1;
})());
check("B2.6 每条都能被激活（不复现空 key + 非常驻 = 永不生效）", noKey.groups.every((g) =>
    g.entries.every((e) => e.constant || e.key.split(",").filter(Boolean).length > 0)));
check("B2.7 非选择性条目合并次关键词", (() => {
    const book = parseTavernWorldBook(
        { character_book: { entries: [{ keys: ["青丘"], secondary_keys: ["九尾"], selective: false, content: "正文" }] } },
        "X"
    );
    return book.groups[0].entries[0].key === "青丘,九尾";
})());
check("B2.8 选择性条目只留主关键词", (() => {
    const book = parseTavernWorldBook(
        { character_book: { entries: [{ keys: ["青丘"], secondary_keys: ["九尾"], selective: true, content: "正文" }] } },
        "X"
    );
    return book.groups[0].entries[0].key === "青丘";
})());

// —— B3 整本按分类拆开 ——
const multi = parseTavernWorldBook(
    {
        character_book: {
            name: "山海世界书",
            entries: [
                { category: "地理", comment: "青丘", content: "青丘之山。" },
                { category: "地理", comment: "不周", content: "不周山。" },
                { category: "人物", comment: "阿嬗", content: "守山人。" },
                { category: "组织", comment: "天枢", content: "观测机构。" },
                { comment: "杂项", content: "一些零散设定。" },
            ],
        },
    },
    "测试角色"
);
check("B3.1 按分类分成多组", multi.groups.length === 4, `groups=${multi.groups.map((g) => g.category).join("/")}`);
check("B3.2 分类名正确（未分类一组不计数）", multi.stats.categories.join("|") === "地理|人物|组织", multi.stats.categories.join("|"));
check("B3.3 地理组有 2 条", multi.groups.find((g) => g.category === "地理").entries.length === 2);
check("B3.4 组内保持原书顺序", multi.groups[0].entries[0].comment.includes("青丘"));
check("B3.5 无分类条目归入空分类（整本不分类时保持一册）",
    JSON.stringify(multi.groups.find((g) => g.category === "").entries.length) === "1");

// —— B4 超长一条被压成整本 → 按标题切分 ——
const mega = [
    "# 世界设定",
    "这是总纲。",
    "## 地理",
    "青丘之山，多玉。".repeat(120),
    "### 青丘",
    "九尾狐的故乡。".repeat(60),
    "### 不周",
    "天柱所立之处。".repeat(60),
    "## 人物",
    "阿嬗是守山人。".repeat(120),
    "### 阿嬗",
    "她守着山口的灯。".repeat(60),
].join("\n");
const megaBook = parseTavernWorldBook(
    { character_book: { name: "整本一坨", entries: [{ comment: "全部设定", content: mega }] } },
    "测试角色"
);
check("B4.1 超长单条触发了切分", megaBook.stats.megaSplit === true);
check("B4.2 切出的条目多于 3 条", megaBook.stats.entries >= 4, `entries=${megaBook.stats.entries}`);
check("B4.3 二级标题成了分类", megaBook.stats.categories.includes("地理") && megaBook.stats.categories.includes("人物"),
    megaBook.stats.categories.join("|"));
check("B4.4 三级标题成了条目标题", megaBook.groups.some((g) => g.entries.some((e) => e.comment.includes("青丘"))));
check("B4.5 切分后仍全部可激活", megaBook.groups.every((g) =>
    g.entries.every((e) => e.constant || e.key.split(",").filter(Boolean).length > 0)));
check("B4.6 短内容不会被误切", splitMegaContent("很短的一段话。\n另一句话。") === null);

// —— B5 位置 / 顺序映射 ——
check("B5.1 position 0 → before_char", mapTavernPosition(0) === "before_char");
check("B5.2 position 4 → before_an", mapTavernPosition(4) === "before_an");
check("B5.3 position 字符串数字也能映射", mapTavernPosition("1") === "after_char");
check("B5.4 缺省位置兜底", mapTavernPosition(undefined) === "before_char");

// —— B6 正则脚本 ——
const card = unwrapTavernCard({
    spec: "chara_card_v2",
    data: {
        name: "阿嬗",
        extensions: {
            regex_scripts: [
                { scriptName: "去星号", findRegex: "\\*+", replaceString: "", placement: [2] },
                { scriptName: "去星号", findRegex: "\\*+", replaceString: "", placement: [2] },
                { findRegex: "^### ", replaceString: "", disabled: true },
            ],
        },
    },
});
const rules = collectTavernRegexScripts(card.root, card.data);
check("B6.1 从 extensions 里取到正则", rules.length === 2, `rules=${rules.length}`);
check("B6.2 完全重复的脚本被去重", rules.filter((r) => r.findRegex === "\\*+").length === 1);
check("B6.3 缺失 placement 时默认走输入+输出", JSON.stringify(rules[1].placement) === "[1,2]", JSON.stringify(rules[1].placement));
check("B6.4 disabled 正确映射", rules[1].disabled === true);
check("B6.5 无 findRegex 的脚本被丢弃", !rules.some((r) => !r.findRegex));
check("B6.6 顶层 regex_scripts 也能取到",
    collectTavernRegexScripts({ regex_scripts: [{ findRegex: "a", replaceString: "b" }] }, {}).length === 1);

// —— B7 预设 ——
const presetObj = {
    name: "叙事预设",
    prompts: [
        { identifier: "p1", name: "视角", content: "用第二人称。", enabled: true },
        { identifier: "p2", name: "长度", content: "每轮三句以内。", enabled: false },
    ],
    prompt_order: [{ identifier: "p1", enabled: true }, { identifier: "p2", enabled: false }],
};
const presetCard = unwrapTavernCard({ spec: "chara_card_v2", data: { name: "阿嬗", preset: presetObj } });
const hit = findTavernPresetObject(presetCard.root, presetCard.data, "阿嬗");
check("B7.1 data.preset 能被找到", Boolean(hit) && hit.name === "叙事预设");
check("B7.2 预设只摊出启用的条目", (() => {
    const text = flattenTavernPresetPrompts(hit.obj);
    return text.includes("第二人称") && !text.includes("三句以内");
})());
check("B7.3 extensions 里的预设也能找到",
    Boolean(findTavernPresetObject({}, { name: "X", extensions: { preset: presetObj } }, "X")));
check("B7.4 没有预设时返回 null", findTavernPresetObject({}, { name: "X" }, "X") === null);

// —— B8 系统提示 / 追加指令 / 作者注释 ——
const extras = collectTavernExtraEntries({
    name: "阿嬗",
    system_prompt: "用克制、留白的笔调叙事。",
    post_history_instructions: "每次回复不超过三句。",
    creator_notes: "这张卡适合慢节奏长跑团。",
    depth_prompt: { prompt: "她记得山口的灯。", depth: 4 },
});
check("B8.1 extras 条目都生成了", extras.length === 4, `extras=${extras.length}`);
check("B8.2 系统提示常驻且最靠前", extras[0].entry.constant === true && extras[0].entry.insertion_order === 0 && extras[0].entry.position === "before_char");
check("B8.3 追加指令放在角色卡之后", extras.some((e) => e.entry.position === "after_char" && e.entry.insertion_order === 1000));
check("B8.4 作者注释不常驻（省 token）", extras.some((e) => e.categoryPath[0] === "作者注释" && e.entry.constant === false));
check("B8.5 深度提示带 depth", extras.some((e) => e.entry.depth === 4));
check("B8.6 酒馆默认系统提示模板被跳过",
    collectTavernExtraEntries({ name: "X", system_prompt: "Write {{char}}'s next reply in a fictional chat. ".repeat(10) })
        .every((e) => !e.categoryPath.includes("系统设定") || !e.entry.content.includes("Write {{char}}")));
check("B8.7 超长系统提示默认停用（不爆 token）", (() => {
    const long = collectTavernExtraEntries({ name: "X", system_prompt: "设定".repeat(1200) });
    const sp = long.find((e) => e.entry.comment.includes("系统提示"));
    return sp && sp.entry.disable === true;
})());

// —— B9 汇总文案 ——
check("B9.1 分类汇总不啰嗦", describeCategories(["地理", "人物", "组织", "器物", "事件", "杂项"]).includes("等 6 类"));
check("B9.2 无分类时给明确说法", describeCategories([]) === "未分类");

console.log(`\n结果：${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
