#!/usr/bin/env node
// 表情包合集 PNG 解码器自检：验证「读 PNG 隐藏元数据 → 取表情清单 → 还原每张图」的链路。
// 用一张合成的表情包 PNG（tEXt 块里塞了 base64 清单，模拟酒馆人物卡式结构）喂给纯函数，
// 断言能正确拿出名字列表、并能把内嵌 base64 还原成合法图片 Blob。
// 退出码非 0 = 解码器坏了。用法: node scripts/check-sticker-pack.mjs

import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
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
  }
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

const { parsePngTextChunks, detectStickerSpecs, isLikelyStickerPackPng, b64ToBlob } = await import(
  pathToFileURL(path.join(root, "lib/sticker-pack-png.ts")).href
);

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  return false;
}

const fixture = path.join(root, "scripts/fixtures/sticker-pack.png");
ok("fixture exists", existsSync(fixture), fixture);

if (existsSync(fixture)) {
  const bytes = new Uint8Array(readFileSync(fixture));
  const chunks = parsePngTextChunks(bytes);
  ok("found tEXt chunk(s)", chunks.length >= 1, `got ${chunks.length}`);
  // 真·QuPhone 导出用 key = "quphone"
  ok("has 'quphone' chunk", chunks.some((c) => c.key === "quphone"));

  const detected = detectStickerSpecs(chunks);
  ok("detected non-null", detected !== null);
  if (detected) {
    // 图集名取自嵌套的 sticker.name
    ok("packName from nested sticker.name", detected.packName === "测试合集", `got ${JSON.stringify(detected.packName)}`);
    ok("3 stickers", detected.specs.length === 3, `got ${detected.specs.length}`);
    ok("names match", JSON.stringify(detected.specs.map((s) => s.name)) === JSON.stringify(["开心", "难过", "摆烂"]), JSON.stringify(detected.specs.map((s) => s.name)));
    ok("all have base64 image", detected.specs.every((s) => typeof s.imageB64 === "string" && s.imageB64.length > 0));
    ok("no data-URI prefix leaked into base64", detected.specs.every((s) => !s.imageB64.startsWith("data:")));
    // data URI 里声明的 mime 要被识别出来（前两张 png、第三张 jpg）
    ok("mime from data URI", JSON.stringify(detected.specs.map((s) => s.imageMime)) === JSON.stringify(["image/png", "image/png", "image/jpeg"]), JSON.stringify(detected.specs.map((s) => s.imageMime)));

    // 还原内嵌 base64 成 Blob，验证签名与 mime 都对
    const blob0 = await b64ToBlob(detected.specs[0].imageB64, detected.specs[0].imageMime);
    const head0 = new Uint8Array(await blob0.arrayBuffer()).slice(0, 8);
    ok("b64 -> valid PNG blob", head0[0] === 0x89 && head0[1] === 0x50 && head0[2] === 0x4e && head0[3] === 0x47, `bytes ${[...head0].join(",")}`);
    ok("PNG blob mime", blob0.type === "image/png", blob0.type);

    const blob2 = await b64ToBlob(detected.specs[2].imageB64, detected.specs[2].imageMime);
    const head2 = new Uint8Array(await blob2.arrayBuffer()).slice(0, 4);
    ok("b64 -> valid JPEG blob", head2[0] === 0xff && head2[1] === 0xd8, `bytes ${[...head2].join(",")}`);
    ok("JPEG blob mime", blob2.type === "image/jpeg", blob2.type);
  }

  ok("isLikelyStickerPackPng true", isLikelyStickerPackPng(bytes) === true);
}

// 反面：最小的合法 PNG（无文本块）不应被当成表情包
const minPng = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020000" +
    "01e221bc330000000049454e44ae426082",
  "hex"
);
ok("plain PNG not sticker pack", isLikelyStickerPackPng(new Uint8Array(minPng)) === false);

// 可选：额外传一个真实表情包 PNG 的路径，做一次端到端解码验证
//   node scripts/check-sticker-pack.mjs "C:/path/to/real-pack.png"
const realPath = process.argv[2];
if (realPath) {
  if (!existsSync(realPath)) {
    ok("real file exists", false, realPath);
  } else {
    const rb = new Uint8Array(readFileSync(realPath));
    const rd = detectStickerSpecs(parsePngTextChunks(rb));
    ok("real file: pack detected", rd !== null, realPath);
    if (rd) {
      let valid = 0;
      for (const s of rd.specs) {
        if (!s.imageB64) continue;
        const bl = await b64ToBlob(s.imageB64, s.imageMime);
        const hd = new Uint8Array(await bl.arrayBuffer()).slice(0, 3);
        const isImg = (hd[0] === 0x89 && hd[1] === 0x50) || (hd[0] === 0xff && hd[1] === 0xd8) || (hd[0] === 0x47 && hd[1] === 0x49);
        if (isImg) valid++;
      }
      ok("real file: every image decodes", valid === rd.specs.length, `${valid}/${rd.specs.length}`);
      console.log(`  real: packName=${JSON.stringify(rd.packName)} count=${rd.specs.length} images=${valid}`);
    }
  }
}

console.log(`\ncheck:sticker-pack — ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL:", f);
  process.exit(1);
}
console.log("all green");
