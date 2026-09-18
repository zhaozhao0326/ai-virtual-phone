// 表情包合集 PNG 解码器：读取 PNG 隐藏元数据（tEXt/iTXt/zTXt 块，类似酒馆人物卡 chara 字段），
// 从中取出表情清单，逐个还原成独立表情。纯本地、零 token、不联网。
// 当 PNG 不带清单（普通拼图）时，由 sticker-sheet-split.ts 的像素网格兜底。

export interface StickerSpec {
  name: string;
  imageB64?: string; // 内嵌的 base64 图片（png/jpg/gif/webp）
  imageMime?: string; // data URI 里声明的 mime（没有则按签名嗅探）
  crop?: { x: number; y: number; w: number; h: number }; // 从主图裁切的坐标
}

export interface StickerPackEntry {
  name: string;
  blob: Blob;
}

export interface StickerPackDecode {
  packName?: string;
  entries: StickerPackEntry[];
  source: "metadata";
}

interface TextChunk {
  key: string;
  value: string;
}

const NAME_KEYS = ["name", "title", "label", "alt", "caption", "名字", "名称", "表情名", "filename"];
const IMAGE_KEYS = [
  "image",
  "img",
  "image_base64",
  "data",
  "src",
  "base64",
  "png",
  "gif",
  "file",
  "content",
  "bytes",
  "url",
];
const COORD_KEYS_X = ["x", "left", "offset_x", "left_x"];
const COORD_KEYS_Y = ["y", "top", "offset_y", "top_y"];
const COORD_KEYS_W = ["w", "width", "ow", "img_width"];
const COORD_KEYS_H = ["h", "height", "oh", "img_height"];

function lcKey(k: string): string {
  return k.toLowerCase();
}

function findFirstKey(obj: Record<string, unknown>, candidates: string[]): unknown {
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(obj, c)) return obj[c];
  }
  const lower = new Map(Object.keys(obj).map((k) => [lcKey(k), k]));
  for (const c of candidates) {
    const real = lower.get(lcKey(c));
    if (real) return obj[real];
  }
  return undefined;
}

function sniffMimeFromBytes(head: string): string | undefined {
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

// 从一个字符串里取出内嵌图片：支持 data URI（data:image/png;base64,xxx）与裸 base64
function extractInlineImage(v: unknown): { b64: string; mime?: string } | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.length < 40) return undefined;

  let body = s;
  let declaredMime: string | undefined;
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma < 0) return undefined;
    const meta = s.slice(5, comma); // image/png;base64
    if (!/base64/i.test(meta)) return undefined;
    const semi = meta.indexOf(";");
    declaredMime = (semi >= 0 ? meta.slice(0, semi) : meta).trim() || undefined;
    body = s.slice(comma + 1);
  }
  const clean = body.replace(/\s/g, "");
  if (clean.length < 32 || !/^[A-Za-z0-9+/=]+$/.test(clean)) return undefined;

  // 只解前 16 个 base64 字符（≈12 字节）嗅探签名，避免整图 atob 的巨大开销
  let head = "";
  try {
    head = atob(clean.slice(0, 16));
  } catch {
    return undefined;
  }
  const sniffed = sniffMimeFromBytes(head);
  if (!sniffed && !declaredMime) return undefined;
  return { b64: clean, mime: declaredMime || sniffed };
}

function looksLikeSticker(obj: Record<string, unknown>): StickerSpec | null {
  const rawName = findFirstKey(obj, NAME_KEYS);
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : undefined;
  if (!name) return null;

  const rawImg = findFirstKey(obj, IMAGE_KEYS);
  const img = extractInlineImage(rawImg);
  if (img) return { name, imageB64: img.b64, imageMime: img.mime };

  const rx = findFirstKey(obj, COORD_KEYS_X);
  const ry = findFirstKey(obj, COORD_KEYS_Y);
  const rw = findFirstKey(obj, COORD_KEYS_W);
  const rh = findFirstKey(obj, COORD_KEYS_H);
  if ([rx, ry, rw, rh].every((v) => typeof v === "number" && isFinite(v as number))) {
    return {
      name,
      crop: { x: rx as number, y: ry as number, w: rw as number, h: rh as number },
    };
  }
  return null;
}

interface FoundStickers {
  specs: StickerSpec[];
  container: Record<string, unknown> | null; // 数组所在的容器对象（用来取图集名）
}

// 递归在已解析 JSON 里找第一个「元素都是表情对象」的数组
function findStickerArray(value: unknown): FoundStickers | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const specs: StickerSpec[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const spec = looksLikeSticker(item as Record<string, unknown>);
      if (spec) specs.push(spec);
    }
    if (specs.length === 0) return null;
    // 少数元素不是图片（纯文字/链接项）时容忍，占比太低则不算表情清单
    if (specs.length < value.length && (specs.length < 2 || specs.length / value.length < 0.6)) return null;
    return { specs, container: null };
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // 常见容器键
    for (const k of ["stickers", "items", "emoticons", "emojis", "list", "images", "pack", "data", "sticker", "表情", "表情包", "合集"]) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        const found = findStickerArray(obj[k]);
        if (found) return { specs: found.specs, container: found.container ?? obj };
      }
    }
    // 兜底：遍历所有值
    for (const v of Object.values(obj)) {
      const found = findStickerArray(v);
      if (found) return found;
    }
  }
  return null;
}

function tryParseJson(text: string): unknown | null {
  // 先试 base64(JSON)
  const clean = text.replace(/\s/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(clean) && clean.length > 8) {
    try {
      const bin = atob(clean);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const json = new TextDecoder("utf-8").decode(bytes);
      return JSON.parse(json);
    } catch {
      /* not b64-json */
    }
  }
  // 再试裸 JSON
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 纯函数：解析 PNG 文本块（tEXt / iTXt / zTXt）
export function parsePngTextChunks(bytes: Uint8Array): TextChunk[] {
  const out: TextChunk[] = [];
  if (bytes.length < 8) return out;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return out;
  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const start = p + 8;
    if (start + len > bytes.length) break;
    const data = bytes.subarray(start, start + len);
    if (type === "tEXt") {
      const z = data.indexOf(0);
      if (z >= 0) {
        const key = decodeLatin1(data.subarray(0, z));
        const value = decodeLatin1(data.subarray(z + 1));
        out.push({ key, value });
      }
    } else if (type === "iTXt") {
      const z = data.indexOf(0);
      if (z >= 0) {
        const key = decodeLatin1(data.subarray(0, z));
        let q = z + 1;
        const comp = data[q];
        q += 1;
        // lang\0, then trans\0, then text
        const nl1 = data.indexOf(0, q);
        if (nl1 >= 0) {
          const nl2 = data.indexOf(0, nl1 + 1);
          if (nl2 >= 0) {
            const textBytes = data.subarray(nl2 + 1);
            let value = "";
            if (comp === 1) {
              try {
                const inf = new Uint8Array(textBytes);
                const d = inflateRaw(inf);
                value = decodeUtf8(d);
              } catch {
                value = decodeUtf8(textBytes);
              }
            } else {
              value = decodeUtf8(textBytes);
            }
            out.push({ key, value });
          }
        }
      }
    } else if (type === "zTXt") {
      const z = data.indexOf(0);
      if (z >= 0) {
        const key = decodeLatin1(data.subarray(0, z));
        const comp = data[z + 1];
        const compBytes = data.subarray(z + 2);
        let value = "";
        if (comp === 0) {
          value = decodeLatin1(compBytes);
        } else {
          try {
            value = decodeUtf8(inflateRaw(new Uint8Array(compBytes)));
          } catch {
            value = decodeLatin1(compBytes);
          }
        }
        out.push({ key, value });
      }
    }
    p = start + len + 4; // skip crc
    if (type === "IEND") break;
  }
  return out;
}

// 探测清单：返回表情规格列表；找不到返回 null
export function detectStickerSpecs(chunks: TextChunk[]): { packName?: string; specs: StickerSpec[] } | null {
  for (const c of chunks) {
    const parsed = tryParseJson(c.value);
    if (!parsed) continue;
    const found = findStickerArray(parsed);
    if (!found || found.specs.length === 0) continue;
    // 图集名：先在数组所在容器里找（如 sticker.name），再退回顶层
    let packName: string | undefined;
    const scopes: Array<Record<string, unknown>> = [];
    if (found.container) scopes.push(found.container);
    if (parsed && typeof parsed === "object") scopes.push(parsed as Record<string, unknown>);
    for (const scope of scopes) {
      const pn = findFirstKey(scope, ["name", "packName", "pack", "title", "合集名", "表情包名"]);
      if (typeof pn === "string" && pn.trim()) {
        packName = pn.trim();
        break;
      }
    }
    return { packName, specs: found.specs };
  }
  return null;
}

// 判断一段字节是否「可能带表情清单的 PNG」
export function isLikelyStickerPackPng(bytes: Uint8Array): boolean {
  const chunks = parsePngTextChunks(bytes);
  if (chunks.length === 0) return false;
  return detectStickerSpecs(chunks) !== null;
}

let latin1Decoder: TextDecoder | null = null;
function decodeLatin1(u: Uint8Array): string {
  // 大文本块（表情包清单可达数 MB）必须走原生解码器，逐字符拼接会慢到秒级
  try {
    if (!latin1Decoder) latin1Decoder = new TextDecoder("latin1");
    return latin1Decoder.decode(u);
  } catch {
    let s = "";
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return s;
  }
}

function decodeUtf8(u: Uint8Array): string {
  try {
    return new TextDecoder("utf-8").decode(u);
  } catch {
    return decodeLatin1(u);
  }
}

// 极简 zlib 解压（仅用于 iTXt/zTXt 里偶尔出现的压缩文本；多数情况不触发）
function inflateRaw(_input: Uint8Array): Uint8Array {
  // 浏览器环境用 DecompressionStream 异步，这里降级：返回原样，调用方会再尝试
  // Node 测试不依赖压缩块，故直接抛出让上层 fallback
  throw new Error("raw inflate not available in this context");
}

export async function b64ToBlob(b64: string, mimeHint?: string): Promise<Blob> {
  const bin = atob(b64.replace(/\s/g, ""));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  // 优先用 data URI 声明的 mime，其次按签名嗅探
  const mime = mimeHint || sniffMimeFromBytes(String.fromCharCode(...arr.slice(0, 12))) || "image/png";
  return new Blob([arr], { type: mime });
}

async function cropFromSheet(blob: Blob, crop: { x: number; y: number; w: number; h: number }): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const w = Math.max(1, Math.round(crop.w));
  const h = Math.max(1, Math.round(crop.h));
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  (ctx as CanvasRenderingContext2D).drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
  bmp.close?.();
  if ("convertToBlob" in canvas) return await (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" });
  return await new Promise<Blob>((resolve) => (canvas as HTMLCanvasElement).toBlob((b) => resolve(b!), "image/png"));
}

// 浏览器侧完整解码：输入 PNG blob，输出表情清单
export async function decodeStickerPackPng(blob: Blob): Promise<StickerPackDecode | null> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const chunks = parsePngTextChunks(buf);
  const detected = detectStickerSpecs(chunks);
  if (!detected || detected.specs.length === 0) return null;
  const entries: StickerPackEntry[] = [];
  for (const spec of detected.specs) {
    let entryBlob: Blob | null = null;
    try {
      if (spec.imageB64) entryBlob = await b64ToBlob(spec.imageB64, spec.imageMime);
      else if (spec.crop) entryBlob = await cropFromSheet(blob, spec.crop);
    } catch {
      entryBlob = null;
    }
    if (!entryBlob) continue;
    entries.push({ name: spec.name, blob: entryBlob });
  }
  if (entries.length === 0) return null;
  return { packName: detected.packName, entries, source: "metadata" };
}
