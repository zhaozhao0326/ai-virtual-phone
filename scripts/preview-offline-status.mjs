// scripts/preview-offline-status.mjs
// 线下「状态栏 + 摘要」合并后的肉眼验收页：不看真机也能确认小标签 / 浮层 / 内置卡片长什么样。
//
//   node scripts/preview-offline-status.mjs [输出目录]
//
// 产出两个 html：
//   *.tag.html   —— 只有小标签的聊天记录（浮层关闭态）
//   *.sheet.html —— 点开后的浮层（真实样式 + 真实内置卡片）
//
// 关键点：CSS 与渲染模板都是**从仓库源文件里抽出来的真货**，不是这里另写一份，
// 所以看到的就是真机上的样子。主题变量取值自 styles/tokens.css 亮色档。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SRC_TEMPLATE = read("lib/offline-scene-template.ts");
const CSS_CHAT = read("styles/chat.css");
const CSS_COMPONENTS = read("styles/components.css");

/** 抽出「选择器里含 needle 的整条规则」，保留原样。 */
function pickRules(css, needles) {
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css)) !== null) {
        const selector = m[1].trim();
        if (selector.startsWith("@")) continue; // @media / @keyframes 交给下面单独搬
        if (needles.some((n) => selector.includes(n))) out.push(`${selector} {${m[2]}}`);
    }
    return out.join("\n");
}

/** 整段搬走 @keyframes（弹窗动画要用）。 */
function pickKeyframes(css, names) {
    const out = [];
    for (const name of names) {
        const start = css.indexOf(`@keyframes ${name}`);
        if (start < 0) continue;
        const open = css.indexOf("{", start);
        let depth = 0;
        let i = open;
        for (; i < css.length; i += 1) {
            if (css[i] === "{") depth += 1;
            else if (css[i] === "}") {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        out.push(css.slice(start, i + 1));
    }
    return out.join("\n");
}

/** 从模板源码抽模板字符串常量（模板里的 \\ 要还原成 \）。 */
function extractTemplateLiteral(name) {
    const marker = `export const ${name} = \``;
    const start = SRC_TEMPLATE.indexOf(marker);
    if (start < 0) throw new Error(`找不到常量 ${name}`);
    let i = start + marker.length;
    let out = "";
    while (i < SRC_TEMPLATE.length) {
        const ch = SRC_TEMPLATE[i];
        if (ch === "\\") {
            const next = SRC_TEMPLATE[i + 1];
            if (next === "`") { out += "`"; i += 2; continue; }
            if (next === "\\") { out += "\\"; i += 2; continue; }
            out += ch + next;
            i += 2;
            continue;
        }
        if (ch === "`") break;
        out += ch;
        i += 1;
    }
    return out;
}

/** 从模板源码抽 [ "a", "b" ].join("\n") 形式的示例数据。 */
function extractArrayJoin(name) {
    const marker = `export const ${name} = [`;
    const start = SRC_TEMPLATE.indexOf(marker);
    if (start < 0) throw new Error(`找不到常量 ${name}`);
    const end = SRC_TEMPLATE.indexOf("].join(", start);
    const body = SRC_TEMPLATE.slice(start + marker.length, end);
    return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"))
        .join("\n");
}

const render = extractTemplateLiteral("OFFLINE_SCENE_STARTER_RENDER");
const previewRaw = extractArrayJoin("OFFLINE_SCENE_STARTER_PREVIEW");

// 亮色档主题变量（照抄 styles/tokens.css 的取值，只为让预览能显示颜色）
const THEME = `:root{
  --c-page-body-bg:#F1F2F6; --c-card-border:#E0E0E0; --c-panel:#FFFFFF;
  --c-text-title:#2C3440; --c-text:#797E85; --c-icon:#A0A3A8;
  --c-overlay:rgba(0,0,0,.35); --app-text-scale:1;
}`;

const CSS = [
    THEME,
    pickRules(CSS_COMPONENTS, [".modal-overlay", ".modal-overlay-bottom", ".modal-sheet"]),
    pickKeyframes(CSS_COMPONENTS, ["modalFadeIn", "modalSlideUp"]),
    pickRules(CSS_CHAT, [".chat-offline-status-trigger", ".chat-status-sheet"]),
].join("\n\n");

const SHEET_CHROME = `
                        <div class="chat-status-sheet-handle"></div>
                        <div class="chat-status-sheet-header">
                            <span class="chat-status-sheet-title">状态栏</span>
                            <button type="button" class="chat-status-sheet-close" aria-label="关闭">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                            </button>
                        </div>
                        <div class="chat-status-sheet-body">
                            ${render}
                            <div class="chat-status-sheet-summary">
                                <div class="chat-status-sheet-summary-label">摘要（summary）</div>
                                <div>他推门进来，看见桌上还温着的饭菜，没说话先把外套挂好。叫了一声「老公」之后，之前那点账的事就翻篇了。</div>
                            </div>
                        </div>`;

// 聊天记录里的一条助手回复 + 末尾的小标签
const TURN = `
  <div style="padding:14px 16px 18px;font:15px/1.75 -apple-system,system-ui,'PingFang SC',sans-serif;color:var(--c-text-title)">
    <p style="margin:0 0 .85em">他把外套挂在门后，顺手把桌上的碗往你那边推了推。「吃完了？」</p>
    <p style="margin:0 0 .85em">屋里还留着五花肉的余温，锅盖边缘凝了一圈油花。他没急着坐下，先从冰箱里拎出一瓶凉白开，拧开放在你手边。</p>
    <p style="margin:0">「外面下过雨，走廊滑，等会儿我去把灯全开了。」</p>
    <button type="button" class="chat-offline-status-trigger">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      <span>状态栏</span>
    </button>
  </div>`;

const page = (body, title) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
html,body{margin:0;background:var(--c-page-body-bg)}
.phone{width:100%;min-height:100vh}
</style><style>${CSS}</style></head>
<body><div class="phone">${body}</div></body></html>`;

// 卡片渲染脚本要读 window.STATUS_RAW，所以在 head 里先注入数据
const withRaw = (html) => html.replace(
    "</head>",
    `<script>window.STATUS_RAW=${JSON.stringify(previewRaw)};</` + `script></head>`,
);

const outDir = process.argv[2] || ROOT;
const tagPath = path.join(outDir, ".preview-offline-status.tag.html");
const sheetPath = path.join(outDir, ".preview-offline-status.sheet.html");

fs.writeFileSync(tagPath, withRaw(page(TURN, "线下状态栏 · 关闭态")), "utf8");
fs.writeFileSync(
    sheetPath,
    withRaw(page(
        `${TURN}
<div class="modal-overlay modal-overlay-bottom">
  <div class="modal-sheet chat-status-sheet">${SHEET_CHROME}</div>
</div>`,
        "线下状态栏 · 打开态",
    )),
    "utf8",
);

console.log(`[OK] 关闭态：${tagPath}`);
console.log(`[OK] 打开态：${sheetPath}`);
console.log(`     卡片字段 ${previewRaw.split("\n").length} 个，渲染 HTML ${render.length} 字符`);
