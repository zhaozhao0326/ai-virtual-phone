// scripts/check-offline-status-region.mjs
// 线下模式「状态栏（相遇手记）」自检：改线下提示词/解析/渲染/设置后跑一次。
//
//   node scripts/check-offline-status-region.mjs
//
// 覆盖三层：
//   1. 接线：两个引擎都在「token 刹车之后」注入契约；配置层的启用判定与删除条件正确。
//   2. 解析：用文件里真实的 [状态栏] 正则跑样例，确认状态块被摘出且正文被清干净。
//   3. 字段一致性：契约给的字段名 ⊇ 渲染读的字段名 ⊇ 预览样例的字段名（防拼写漂移）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
const failures = [];

function ok(label, condition, detail = "") {
    if (condition) {
        pass += 1;
    } else {
        failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    }
}

const statusRegion = read("lib/chat-status-region.ts");
const template = read("lib/offline-scene-template.ts");
const chatEngine = read("lib/chat-engine.ts");
const groupEngine = read("lib/group-chat-engine.ts");
const offlineStorage = read("lib/chat-offline-storage.ts");
const chatRoom = read("components/chat/chat-room.tsx");
const settingsPanel = read("components/chat/chat-settings-panel.tsx");
const changelog = read("lib/changelog.ts");

// ── 1. 接线 ────────────────────────────────────────────────────────────────
ok("chat-engine 注入线下状态栏", chatEngine.includes('appendOfflineStatusRegionInstruction(llmMessages, session.id, session.isGroup ? "group" : "single");'));
ok("group-chat-engine 注入线下状态栏", groupEngine.includes('appendOfflineStatusRegionInstruction(llmMessages, session.id, "group");'));

{
    // 两个引擎都是线上/线下共用函数，注入必须卡在 isOfflineMode 里，
    // 否则用户一开线下状态栏，线上聊天也会被灌进线下契约。
    const singleGuard = /if \(isOfflineMode\) \{\s*\r?\n\s*appendOfflineStatusRegionInstruction\(llmMessages, session\.id, session\.isGroup/;
    const groupGuard = /if \(isOfflineMode\) \{\s*\r?\n\s*appendOfflineStatusRegionInstruction\(llmMessages, session\.id, "group"\);/;
    ok("chat-engine 注入卡在 isOfflineMode 内", singleGuard.test(chatEngine));
    ok("group-chat-engine 注入卡在 isOfflineMode 内", groupGuard.test(groupEngine));
}

{
    // 注入必须在 token 刹车之后，否则这条 system 消息会被裁掉
    const budget = chatEngine.indexOf("llmMessages = enforceTotalTokenBudget(llmMessages, tokenBudget);");
    const inject = chatEngine.indexOf('appendOfflineStatusRegionInstruction(llmMessages, session.id,');
    ok("token 刹车先于注入执行", budget > 0 && inject > budget, `budget@${budget} inject@${inject}`);
}

ok("启用判定只看 offline 开关", /export function isOfflineStatusRegionActive[\s\S]{0,160}?return config\.offline === true;/.test(statusRegion));
ok("删除条件保留 offline 配置", statusRegion.includes('&& config.offline !== true) {'));
ok("契约走内置兜底", statusRegion.includes("export function resolveOfflineContract"));
ok("渲染走内置兜底", statusRegion.includes("export function resolveOfflineRenderHtml"));
ok("未启用时契约正文为空", /if \(!isOfflineStatusRegionActive\(config\)\) return "";/.test(statusRegion));

ok("chat-room 保存点全部写入 statusRaw", (chatRoom.match(/statusRaw: (result|parsed)\.statusRaw/g) || []).length === 3);
ok("chat-room 浮层用线下渲染常量", chatRoom.includes("<CustomStatusFrame html={statusSheet.render} raw={statusSheet.statusRaw} />"));
ok("chat-room 关掉渲染时历史仍可读", chatRoom.includes("text={statusSheet.statusRaw}"));

// 摘要与状态栏并成一块：聊天记录里只留一个小标签，点开是浮层，不再行内展开撑长版面
ok("chat-room 不再单独渲染摘要折叠块", !chatRoom.includes('className="chat-offline-summary-fold"'));
ok("摘要并进同一个浮层", chatRoom.includes("chat-status-sheet-summary") && chatRoom.includes("text={statusSheet.summary}"));
ok("小标签点开浮层", chatRoom.includes("className=\"chat-offline-status-trigger\"") && chatRoom.includes("setStatusSheet({"));
ok("浮层沿用底部弹窗骨架（浮在记录之上）", chatRoom.includes('className="modal-sheet chat-status-sheet"'));
ok("已移除行内展开状态", !chatRoom.includes("expandedOfflineStatusId"));

ok("设置页有线下开关入口", settingsPanel.includes("线下模式状态栏"));
ok("设置页线上保存不会覆盖线下配置", settingsPanel.includes('saveStatusRegion({ ...statusRegion, mode: contract && renderHtml ? "custom" : "off"'));
ok("设置页可编辑线下契约", settingsPanel.includes("openStatusRegionDialog(\"offline\")"));

// 不写死版本号：只要求「APP_VERSION 与日志最新一条版本一致，且 ≥ 1.7.87 且不是旧版」。
// 写死 1.7.87 的写法每升一次版本就误报一次红，属于自检自身的坑。
{
    const appVer = (changelog.match(/export const APP_VERSION = "([^"]+)";/) || [])[1] || "";
    const headVer = (changelog.match(/version: "([^"]+)",\s*\r?\n\s*date:/) || [])[1] || "";
    const cmp = (a, b) => {
        const pa = String(a).split(".").map(Number);
        const pb = String(b).split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d;
        }
        return 0;
    };
    ok("变更日志：APP_VERSION 与最新条目版本一致", !!appVer && appVer === headVer, `APP_VERSION=${appVer} 最新条目=${headVer}`);
    ok("变更日志：版本不低于引入线下状态栏的 1.7.87", cmp(appVer, "1.7.87") >= 0, appVer);
}

for (const [rel, text] of [
    ["lib/chat-status-region.ts", statusRegion],
    ["lib/offline-scene-template.ts", template],
    ["lib/chat-engine.ts", chatEngine],
]) {
    const lfOnly = text.split("\n").length - 1 - (text.match(/\r\n/g) || []).length;
    ok(`${rel} 换行统一 CRLF`, lfOnly === 0, `LF_only=${lfOnly}`);
}

// ── 2. 解析：[状态栏] 块要摘出去、正文要清干净 ──────────────────────────────
{
    const blockLiteral = String.raw`\[状态栏\]([\s\S]*?)\[\/状态栏\]`;
    ok("解析用的是 [状态栏] 块正则", offlineStorage.includes(blockLiteral));

    const blockRe = new RegExp(blockLiteral);
    const blockReG = new RegExp(blockLiteral, "g");
    const contentRe = /<content>([\s\S]*?)<\/content>/i;

    const statusBody = "天气=秋夜微雨初歇，走廊湿冷\n位置=市局三号楼三楼单身宿舍\n情绪=放松、踏实";
    const parse = (raw) => {
        const content = (raw.match(contentRe)?.[1] || "").trim();
        const match = content.match(blockRe) || raw.match(blockRe);
        const statusRaw = match?.[1]?.trim() || "";
        const cleaned = statusRaw ? content.replace(blockReG, "").trim() : content;
        return { statusRaw, cleaned };
    };

    const inside = parse(`<content>他推门进来，屋里还留着饭菜的味道。\n[状态栏]\n${statusBody}\n[/状态栏]</content>\n<summary>他回来了。</summary>`);
    ok("正文内状态块被摘出", inside.statusRaw === statusBody);
    ok("正文内状态块不残留", !inside.cleaned.includes("状态栏") && inside.cleaned.includes("他推门进来"));

    const outside = parse(`[状态栏]\n${statusBody}\n[/状态栏]\n<content>他把外套挂在门后。</content>`);
    ok("正文外状态块也能摘出", outside.statusRaw === statusBody);
    ok("正文外状态块不污染正文", outside.cleaned === "他把外套挂在门后。");

    const none = parse(`<content>两个人谁都没先开口。</content>`);
    ok("未启用时不误判（statusRaw 为空）", none.statusRaw === "" && none.cleaned === "两个人谁都没先开口。");
}

// ── 3. 字段一致性：契约 ⊇ 渲染 / 预览 ──────────────────────────────────────
{
    // 契约是数组字面量，每行形如 `    "天气=<=说明>"`（带缩进与引号），所以先剥掉行首缩进和引号再取键
    const contractKeys = new Set(
        [...template.matchAll(/^\s*"([^"=\n]+)=\s*<=/gm)].map((m) => m[1].trim()),
    );
    ok("从契约里解析出字段", contractKeys.size >= 9, `keys=${[...contractKeys].join(",")}`);

    const renderKeys = [...template.matchAll(/\["[^"]+", "([^"]+)"\]/g)].map((m) => m[1]);
    const renderMissing = renderKeys.filter((k) => !contractKeys.has(k));
    ok("渲染读的字段都在契约里", renderMissing.length === 0 && renderKeys.length >= 9, `missing=${renderMissing.join(",")}`);

    // 「本轮」字段必须两侧都没有：摘要才是这一轮概括的唯一来源（也是进短期记忆的那份），
    // 再让模型写一遍「本轮」＝同一件事两个说法，费 token 又会对不上。
    ok("契约已去掉与摘要重复的「本轮」", !contractKeys.has("本轮"));
    ok("渲染已去掉与摘要重复的「本轮剧情」行", !renderKeys.includes("本轮"));

    // 只取预览常量自己的那段，别把渲染 HTML / 契约一起吃进来
    const previewStart = template.indexOf("export const OFFLINE_SCENE_STARTER_PREVIEW");
    const previewBlock = previewStart >= 0 ? template.slice(previewStart) : "";
    const previewKeys = [...previewBlock.matchAll(/^\s*"([^"=\n]+)=/gm)].map((m) => m[1].trim());
    const previewMissing = [...new Set(previewKeys)].filter((k) => !contractKeys.has(k));
    ok("预览样例的字段都在契约里", previewMissing.length === 0, `missing=${previewMissing.join(",")}`);

    ok("渲染读 window.STATUS_RAW", template.includes("window.STATUS_RAW"));

    // 契约正文（不含注释）里不能出现 {{...}}：这条注入消息不过宏引擎，写了会原样送到模型
    const contractStart = template.indexOf("export const OFFLINE_SCENE_STARTER_CONTRACT");
    const contractBlock = contractStart >= 0 ? template.slice(contractStart, previewStart) : "";
    ok("契约不写 {{user}}（注入消息不经宏引擎）", contractBlock.length > 0 && !contractBlock.includes("{{"));
}

// ── 结果 ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
    console.error(`\n[FAIL] ${failures.length} 项未通过：`);
    for (const item of failures) console.error(`  - ${item}`);
    console.error(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
    process.exit(1);
}
console.log(`[OK] 线下状态栏自检全通过（${pass} 项断言）`);
