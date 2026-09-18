#!/usr/bin/env node
// 表情包「合集图」拆分的自检：钉住 lib/sticker-sheet-split.ts 的识别结果。
//
// 背景：用户手上的表情包经常是一张「合集卡」（白底卡片上 2×2 摆着四个表情，
// 下面还有标题 / 作者 / 水印）。这种图以前只能整张当 1 个表情，得自己裁；
// 现在上传时自动认出网格并切成 N 张独立表情。
//
// 本脚本不联网、不依赖任何图片解码库：直接构造 RGBA 像素喂给识别函数，
// 逐条断言网格行列数、每块矩形、以及「不该被当成合集」的反面用例。
//
// 真实样本（曲曲机导出的 640×812 卡片，两张）已于开发时用真图验证过：
//   → 都识别为 2 行 × 2 列，块 231~232px，坐标为 x=77/331、y=77/332 一片；
//   且把真图缩到 50% / 30% / 15% 后再识别依旧成立（浏览器里会先缩到 1000px 再分析）。
// 真图未随仓库提交（第三方素材），所以这里用结构等价的合成卡复现同一套判定。
//
// 用法: node scripts/check-sticker-sheet.mjs
// 退出码非 0 = 识别器坏了。

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

export async function resolve(specifier, context, next) {
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

const {
    detectStickerSheetTiles,
    buildSheetStickerNames,
    isGenericImageName,
    STICKER_SHEET_MIN_TILES,
} = await import(pathToFileURL(path.join(root, "lib/sticker-sheet-split.ts")).href);

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; return true; }
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    return false;
}
const J = (v) => JSON.stringify(v);

// ── 合成器：按真实卡片结构画一张合集卡 ──────────────────────
// 浅灰底 + 白色圆角卡片 + N×M 个彩色图块（模拟照片）+ 下方标题/作者/水印文字带
function makeSheet({ cols, rows, width = 640, height = 812, pad = 64, gap = 24, top = 70, footer = 250, tileColor } = {}) {
    const w = width, h = height;
    const pixels = new Uint8ClampedArray(w * h * 4);
    const put = (x, y, r, g, b) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const i = (y * w + x) * 4;
        pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
    };
    // 卡外浅灰底（247，不是纯白：和卡片白底区分开，与真实样本一致）
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, 247, 247, 247);
    // 白色卡片
    for (let y = 30; y < h - 30; y++) for (let x = 40; x < w - 40; x++) put(x, y, 254, 254, 254);

    const tileW = Math.floor((w - pad * 2 - gap * (cols - 1)) / cols);
    const tileH = Math.floor((h - top - footer - gap * (rows - 1)) / rows);
    const rects = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x0 = pad + c * (tileW + gap);
            const y0 = top + r * (tileH + gap);
            const paint = tileColor || ((x, y) => [60 + ((x * 3) % 150), 90 + ((y * 5) % 120), 140 + ((x + y) % 90)]);
            for (let y = y0; y < y0 + tileH; y++) for (let x = x0; x < x0 + tileW; x++) {
                const [rr, gg, bb] = paint(x - x0, y - y0);
                put(x, y, rr, gg, bb);
            }
            rects.push({ x: x0, y: y0, w: tileW, h: tileH });
        }
    }
    // 标题 / 作者 / 水印：稀疏细文字带（真实卡上就是这种「又细又稀」的带）
    const textBand = (y0, x0, len) => {
        for (let x = x0; x < x0 + len; x += 3) for (let y = y0; y < y0 + 16; y++) if (y % 3 !== 0) put(x, y, 40, 40, 40);
    };
    textBand(h - 190, pad, 180);           // 标题（大字号）
    textBand(h - 120, pad, 120);           // 作者
    textBand(h - 120, w - 220, 140);       // 水印
    return { pixels, width: w, height: h, rects, tileW, tileH };
}

function tilesMatch(actual, expected, tolerance = 1) {
    if (actual.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
        const a = actual[i], e = expected[i];
        if (Math.abs(a.x - e.x) > tolerance || Math.abs(a.y - e.y) > tolerance) return false;
        if (Math.abs(a.w - e.w) > tolerance || Math.abs(a.h - e.h) > tolerance) return false;
    }
    return true;
}

// ── ① 真实卡片同构：2×2 ──────────────────────────────────
{
    const sheet = makeSheet({ cols: 2, rows: 2 });
    const det = detectStickerSheetTiles(sheet.pixels, sheet.width, sheet.height);
    ok("2×2 合集：能识别", Boolean(det));
    if (det) {
        ok("2×2 合集：2 行 2 列", det.rows === 2 && det.cols === 2, `rows=${det.rows} cols=${det.cols}`);
        ok("2×2 合集：4 块", det.tiles.length === 4, J(det.tiles.length));
        ok("2×2 合集：每块矩形与图块位置一致", tilesMatch(det.tiles, sheet.rects), J(det.tiles) + " vs " + J(sheet.rects));
        ok("2×2 合集：块边长中位数合理", Math.abs(det.tileSize - Math.min(sheet.tileW, sheet.tileH)) <= 1, J(det.tileSize));
        // 标题/作者/水印带不能被当成图块
        const footerTop = sheet.height - 200;
        ok("2×2 合集：标题与水印没被当成表情", det.tiles.every((t) => t.y + t.h <= footerTop), J(det.tiles.map((t) => t.y + t.h)));
    }
}

// ── ② 其它排布：3×3 / 1×4 / 4×1 / 2×3 ────────────────────
for (const [cols, rows] of [[3, 3], [1, 4], [4, 1], [2, 3], [3, 1]]) {
    const sheet = makeSheet({ cols, rows, top: 60, footer: 210 });
    const det = detectStickerSheetTiles(sheet.pixels, sheet.width, sheet.height);
    const label = `${rows}行${cols}列`;
    ok(`${label}：能识别`, Boolean(det));
    if (det) {
        ok(`${label}：行列数正确`, det.rows === rows && det.cols === cols, `rows=${det.rows} cols=${det.cols}`);
        ok(`${label}：块数 = ${rows * cols}`, det.tiles.length === rows * cols, J(det.tiles.length));
        ok(`${label}：矩形与图块一致`, tilesMatch(det.tiles, sheet.rects), J(det.tiles) + " vs " + J(sheet.rects));
    }
}

// ── ③ 缩到分析尺寸后依然成立（浏览器先把图缩到 ≤1000px 再识别）──
{
    const sheet = makeSheet({ cols: 2, rows: 2 });
    const factor = 2; // 每 2×2 像素取一点，等价于缩到 50%
    const sw = Math.floor(sheet.width / factor), sh = Math.floor(sheet.height / factor);
    const small = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const src = ((y * factor) * sheet.width + x * factor) * 4;
        const dst = (y * sw + x) * 4;
        small[dst] = sheet.pixels[src]; small[dst + 1] = sheet.pixels[src + 1];
        small[dst + 2] = sheet.pixels[src + 2]; small[dst + 3] = 255;
    }
    const det = detectStickerSheetTiles(small, sw, sh);
    ok("缩小一半后仍识别为 2×2", Boolean(det) && det.rows === 2 && det.cols === 2, det ? `rows=${det.rows} cols=${det.cols}` : "null");
}

// ── ④ 反面用例：不该被当成合集 ────────────────────────────
{
    // 单张照片：上蓝天下沙滩，中间一道窄分界线
    const w = 600, h = 800;
    const pixels = new Uint8ClampedArray(w * h * 4);
    const put = (x, y, r, g, b) => { const i = (y * w + x) * 4; pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) y < 400 ? put(x, y, 90, 150, 230) : put(x, y, 220, 200, 160);
    for (let y = 396; y < 404; y++) for (let x = 0; x < w; x++) put(x, y, 30, 30, 30);
    ok("单张照片（明暗两段）不判为合集", detectStickerSheetTiles(pixels, w, h) === null);
}
{
    // 单张纯色照片
    const w = 500, h = 500;
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { pixels[i * 4] = 120; pixels[i * 4 + 1] = 160; pixels[i * 4 + 2] = 90; pixels[i * 4 + 3] = 255; }
    ok("单张纯色图不判为合集", detectStickerSheetTiles(pixels, w, h) === null);
}
{
    // 全白图
    const w = 400, h = 400;
    const pixels = new Uint8ClampedArray(w * h * 4).fill(255);
    ok("全白图不判为合集", detectStickerSheetTiles(pixels, w, h) === null);
}
{
    // 只有文字（白底黑字），没有图块
    const w = 500, h = 700;
    const pixels = new Uint8ClampedArray(w * h * 4).fill(255);
    const put = (x, y) => { const i = (y * w + x) * 4; pixels[i] = 20; pixels[i + 1] = 20; pixels[i + 2] = 20; };
    for (let line = 0; line < 8; line++) {
        const y0 = 60 + line * 70;
        for (let x = 60; x < 440; x += 4) for (let y = y0; y < y0 + 22; y++) put(x, y);
    }
    ok("纯文字图不判为合集", detectStickerSheetTiles(pixels, w, h) === null);
}
{
    // 图片太小（低于可用下限）
    const small = new Uint8ClampedArray(40 * 40 * 4).fill(255);
    ok("过小的图不判为合集", detectStickerSheetTiles(small, 40, 40) === null);
}
{
    // 参数非法：像素长度对不上
    const pixels = new Uint8ClampedArray(100 * 100 * 4);
    ok("像素长度与尺寸不匹配时返回 null", detectStickerSheetTiles(pixels, 200, 200) === null);
}

// ── ⑤ 命名 ────────────────────────────────────────────────
{
    ok("合集命名：按序号加后缀", J(buildSheetStickerNames("低脂小猫", 3)) === J(["低脂小猫1", "低脂小猫2", "低脂小猫3"]), J(buildSheetStickerNames("低脂小猫", 3)));
    ok("合集命名：只有 1 块时不加序号", J(buildSheetStickerNames("低脂小猫", 1)) === J(["低脂小猫"]));
    ok("合集命名：空名字兜底为「表情」", buildSheetStickerNames("   ", 2)[0] === "表情1");
    ok("合集命名：超长名字被截断", buildSheetStickerNames("一".repeat(60), 1)[0].length <= 24);
    ok("合集命名：序号连续", J(buildSheetStickerNames("猫", 4)) === J(["猫1", "猫2", "猫3", "猫4"]));
}
{
    ok("无意义文件名：clipboard-xxx.jpg 算无意义", isGenericImageName("clipboard-2026-09-18T02-32-34-454Z-5fd9130a.jpg"));
    ok("无意义文件名：tmp_xxx 算无意义", isGenericImageName("tmp_cff470f4bd3c54db67310a2117987d4c7f57da9ec09d3b2f.png"));
    ok("无意义文件名：IMG_1234 算无意义", isGenericImageName("IMG_1234.PNG"));
    ok("无意义文件名：截图 算无意义", isGenericImageName("截图 2026-09-18.png"));
    ok("无意义文件名：纯数字算无意义", isGenericImageName("1234567890.png"));
    ok("有意义文件名：低脂小猫 不算无意义", !isGenericImageName("低脂小猫.png"));
    ok("有意义文件名：模糊小咪 不算无意义", !isGenericImageName("模糊小咪.jpg"));
    ok("有意义文件名：cat-hug 不算无意义", !isGenericImageName("cat-hug.webp"));
}

// ── ⑥ 常量 ───────────────────────────────────────────────
ok("合集至少要有 2 块才算合集", STICKER_SHEET_MIN_TILES === 2, J(STICKER_SHEET_MIN_TILES));

// ── 汇总 ─────────────────────────────────────────────────
console.log(`sticker-sheet-split 自检：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
}
console.log("全部通过 ✓");
