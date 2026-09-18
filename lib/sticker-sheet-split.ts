// lib/sticker-sheet-split.ts
// 表情包「合集图」拆分：一张图里排着 N 个表情（例如曲曲机导出的那种卡片，
// 白底卡片上 2×2 摆着四张猫猫图，下面还有标题/作者/水印），
// 这里把每个表情各自的矩形范围找出来，切成 N 张能单独用的表情。
//
// 为什么需要：合集图原本只能整张当 1 个表情塞进去，用户得自己去截图软件里裁。
//
// 识别方式（纯像素分析，不认死 2×2）：
//   1) 每个像素判成「墨水」（彩色 或 偏暗）还是「底」（白色/浅灰的空隙、卡片白底）；
//   2) 逐行、逐列统计墨水占比：表情图块所在的行/列占比高，图块之间的空隙是底色占比≈0
//      —— 网格就被空隙天然切开；
//   3) 标题、作者、水印这些文字带是细线且墨水占比低，会被两道密度门槛滤掉；
//   4) 网格 = 行带 × 列带 的笛卡尔积，输出每块的矩形。
//
// 全程本地 canvas，不联网、不调用任何模型 —— 零 token、零流量。

export type SheetTile = { x: number; y: number; w: number; h: number };

export type StickerSheetDetection = {
    cols: number;
    rows: number;
    tiles: SheetTile[];
    /** 图块边长的中位数（像素），供 UI 提示用 */
    tileSize: number;
};

/** 少于这个块数就不算合集，按单张图片处理。 */
export const STICKER_SHEET_MIN_TILES = 2;

// ── 判定阈值（均按真实合集图实测标定）──
const INK_SATURATION = 22; // 最高/最低通道差 > 22 → 视为彩色
const INK_LUMINANCE = 205; // 平均亮度 < 205 → 视为偏暗
const BAND_SEED_DENSITY = 0.12; // 行/列进入「候选带」的墨水占比下限
const BAND_KEEP_DENSITY = 0.35; // 候选带的平均墨水占比下限（文字带远达不到）
const BAND_MIN_LENGTH_RATIO = 0.05; // 带长至少占该方向的 5%
const BAND_UNIFORM_TOLERANCE = 0.28; // 带长与中位数的偏差上限（图块等大）
const BAND_MERGE_GAP_RATIO = 0.02; // 相邻带间隙小于该比例时合并（图块内部的一道暗线）
const GUTTER_LIGHT_LUMA = 215; // 空隙要么够亮
const GUTTER_FLAT_MAD = 10; // 要么够平（平均绝对偏差小）

type Band = { start: number; end: number; mean: number };

function isInk(r: number, g: number, b: number): boolean {
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    return mx - mn > INK_SATURATION || (r + g + b) / 3 < INK_LUMINANCE;
}

function buildRowDensity(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number, step: number): Float64Array {
    const density = new Float64Array(height);
    let cols = 0;
    for (let x = 0; x < width; x += step) cols++;
    for (let y = 0; y < height; y++) {
        let ink = 0;
        for (let x = 0; x < width; x += step) {
            const i = (y * width + x) * 4;
            if (isInk(pixels[i], pixels[i + 1], pixels[i + 2])) ink++;
        }
        density[y] = ink / cols;
    }
    return density;
}

function buildColDensity(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number, step: number): Float64Array {
    const density = new Float64Array(width);
    let rows = 0;
    for (let y = 0; y < height; y += step) rows++;
    for (let x = 0; x < width; x++) {
        let ink = 0;
        for (let y = 0; y < height; y += step) {
            const i = (y * width + x) * 4;
            if (isInk(pixels[i], pixels[i + 1], pixels[i + 2])) ink++;
        }
        density[x] = ink / rows;
    }
    return density;
}

/** 从密度曲线里取出「图块带」：先按低门槛切段，再合并、再按密度与等大性过滤。 */
function collectBands(density: Float64Array, minLength: number, mergeGap: number): Band[] {
    const runs: Band[] = [];
    let start = -1;
    for (let i = 0; i <= density.length; i++) {
        const hot = i < density.length && density[i] > BAND_SEED_DENSITY;
        if (hot) {
            if (start < 0) start = i;
            continue;
        }
        if (start >= 0) {
            runs.push({ start, end: i - 1, mean: 0 });
            start = -1;
        }
    }
    if (!runs.length) return [];

    const merged: Band[] = [];
    for (const run of runs) {
        const last = merged[merged.length - 1];
        if (last && run.start - last.end - 1 <= mergeGap) last.end = run.end;
        else merged.push({ start: run.start, end: run.end, mean: 0 });
    }

    const kept: Band[] = [];
    for (const band of merged) {
        const len = band.end - band.start + 1;
        if (len < minLength) continue;
        let sum = 0;
        for (let i = band.start; i <= band.end; i++) sum += density[i];
        const mean = sum / len;
        if (mean < BAND_KEEP_DENSITY) continue;
        kept.push({ start: band.start, end: band.end, mean });
    }
    if (kept.length < 1) return [];

    // 等大性：图块是一样大的，长度离中位数太远的（大概率是大字标题/整块色带）剔除
    const lengths = kept.map((b) => b.end - b.start + 1).sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)];
    const uniform = kept.filter((b) => Math.abs(b.end - b.start + 1 - median) / median <= BAND_UNIFORM_TOLERANCE);

    // 收尾：仍按长度门槛过一遍（等大性过滤后可能出现小带）
    return uniform.filter((b) => b.end - b.start + 1 >= minLength);
}

/** 采一条矩形条带，返回亮度均值与平均绝对偏差（判「这里是不是底色空隙」）。 */
function sampleStrip(
    pixels: Uint8ClampedArray | Uint8Array,
    width: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
): { luma: number; mad: number } | null {
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w <= 0 || h <= 0) return null;
    // 控制采样量：总点数百来量级就够判断
    const stepX = Math.max(1, Math.round(w / 40));
    const stepY = Math.max(1, Math.round(h / 40));
    const lumas: number[] = [];
    for (let y = y0; y <= y1; y += stepY) {
        for (let x = x0; x <= x1; x += stepX) {
            const i = (y * width + x) * 4;
            lumas.push((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3);
        }
    }
    if (!lumas.length) return null;
    const luma = lumas.reduce((a, b) => a + b, 0) / lumas.length;
    const mad = lumas.reduce((a, b) => a + Math.abs(b - luma), 0) / lumas.length;
    return { luma, mad };
}

/**
 * 主入口：从 RGBA 像素里识别合集网格。
 * 不是合集（认不出至少 2 块等大的图块）时返回 null，调用方按单张处理。
 */
export function detectStickerSheetTiles(
    pixels: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
): StickerSheetDetection | null {
    if (!pixels || width < 64 || height < 64) return null;
    if (pixels.length < width * height * 4) return null;

    const step = Math.max(1, Math.round(Math.min(width, height) / 420));
    const minSide = Math.max(20, Math.round(Math.min(width, height) * 0.05));
    const mergeGap = Math.max(0, Math.round(Math.min(width, height) * BAND_MERGE_GAP_RATIO));

    const rowBands = collectBands(buildRowDensity(pixels, width, height, step), minSide, mergeGap);
    const colBands = collectBands(buildColDensity(pixels, width, height, step), minSide, mergeGap);
    if (!rowBands.length || !colBands.length) return null;
    if (rowBands.length * colBands.length < STICKER_SHEET_MIN_TILES) return null;

    const gridTop = rowBands[0].start;
    const gridBottom = rowBands[rowBands.length - 1].end;
    const gridLeft = colBands[0].start;
    const gridRight = colBands[colBands.length - 1].end;

    // 空隙复核：图块之间应该确实是底色（白/浅灰）——照片里被误切成两条的色带过不了这一关。
    // 只要求「至少有一处空隙成立」，避免对底色不白的合集图误杀。
    const gaps: { luma: number; mad: number }[] = [];
    for (let i = 0; i < colBands.length - 1; i++) {
        const gx0 = colBands[i].end + 1;
        const gx1 = colBands[i + 1].start - 1;
        if (gx1 - gx0 < 1) continue;
        const s = sampleStrip(pixels, width, gx0, gx1, gridTop, gridBottom);
        if (s) gaps.push(s);
    }
    for (let i = 0; i < rowBands.length - 1; i++) {
        const gy0 = rowBands[i].end + 1;
        const gy1 = rowBands[i + 1].start - 1;
        if (gy1 - gy0 < 1) continue;
        const s = sampleStrip(pixels, width, gridLeft, gridRight, gy0, gy1);
        if (s) gaps.push(s);
    }
    if (gaps.length > 0) {
        const backgroundish = gaps.filter((g) => g.luma >= GUTTER_LIGHT_LUMA || g.mad <= GUTTER_FLAT_MAD);
        if (!backgroundish.length) return null;
    }

    const tiles: SheetTile[] = [];
    for (const row of rowBands) {
        for (const col of colBands) {
            tiles.push({
                x: col.start,
                y: row.start,
                w: col.end - col.start + 1,
                h: row.end - row.start + 1,
            });
        }
    }

    const sideLengths = tiles.map((t) => Math.min(t.w, t.h)).sort((a, b) => a - b);
    return {
        cols: colBands.length,
        rows: rowBands.length,
        tiles,
        tileSize: sideLengths[Math.floor(sideLengths.length / 2)],
    };
}

// ── 浏览器侧：解码 → 识别 → 裁切 ──────────────────────────

const ANALYSIS_MAX_SIDE = 1000; // 识别在缩小图上做（省内存），裁切仍用原图

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas | null {
    if (typeof OffscreenCanvas !== "undefined") {
        try { return new OffscreenCanvas(width, height); } catch { /* 退回 DOM canvas */ }
    }
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob | null> {
    if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
        return canvas.convertToBlob({ type: "image/png" }).catch(() => null);
    }
    const el = canvas as HTMLCanvasElement;
    return new Promise((resolve) => {
        try { el.toBlob((b) => resolve(b), "image/png"); } catch { resolve(null); }
    });
}

function drawToCanvas(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number) {
    const canvas = createCanvas(dw, dh);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
    return canvas;
}

export type StickerSheetSplit = { tiles: Blob[]; cols: number; rows: number; tileSize: number };

/**
 * 把一张合集图切成多张独立表情。不是合集（或解码失败）返回 null，调用方按单张处理。
 * 全程本地，不联网。
 */
export async function splitStickerSheet(blob: Blob): Promise<StickerSheetSplit | null> {
    if (typeof window === "undefined" || typeof createImageBitmap !== "function") return null;
    let bitmap: ImageBitmap | null = null;
    try {
        bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions);
        const width = bitmap.width;
        const height = bitmap.height;
        if (!width || !height) return null;

        // ① 缩小图上做识别
        const scale = Math.min(1, ANALYSIS_MAX_SIDE / Math.max(width, height));
        const aw = Math.max(1, Math.round(width * scale));
        const ah = Math.max(1, Math.round(height * scale));
        const analysis = drawToCanvas(bitmap, 0, 0, width, height, aw, ah);
        if (!analysis) return null;
        const actx = analysis.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!actx || typeof actx.getImageData !== "function") return null;
        const imageData = actx.getImageData(0, 0, aw, ah);
        const detection = detectStickerSheetTiles(imageData.data, aw, ah);
        if (!detection) return null;

        // ② 矩形映射回原图坐标，用原图裁切（保持清晰度）
        const inverse = 1 / scale;
        const tiles: Blob[] = [];
        for (const tile of detection.tiles) {
            const sx = Math.max(0, Math.round(tile.x * inverse));
            const sy = Math.max(0, Math.round(tile.y * inverse));
            const sw = Math.min(width - sx, Math.round(tile.w * inverse));
            const sh = Math.min(height - sy, Math.round(tile.h * inverse));
            if (sw < 16 || sh < 16) continue;
            const canvas = drawToCanvas(bitmap, sx, sy, sw, sh, sw, sh);
            if (!canvas) continue;
            const out = await canvasToBlob(canvas);
            if (out) tiles.push(out);
        }
        if (tiles.length < STICKER_SHEET_MIN_TILES) return null;
        return {
            tiles,
            cols: detection.cols,
            rows: detection.rows,
            tileSize: Math.round(detection.tileSize * inverse),
        };
    } catch {
        return null;
    } finally {
        try { bitmap?.close?.(); } catch { /* ignore */ }
    }
}

// ── 命名 ─────────────────────────────────────────────────

/** 各平台自动生成的图片名前缀：这些名字当表情名没有任何信息量。 */
const GENERIC_NAME_PREFIXES = [
    "clipboard", "imageasset", "wechatimg", "mmexport", "bxfile", "untitled",
    "screenshot", "screencapture", "screen shot", "image", "img", "photo", "pic", "tmp", "temp",
];

/** 文件名是否属于「一看就没意义」的自动命名（截图 / 剪贴板 / 时间戳 / UUID）。 */
export function isGenericImageName(name: string): boolean {
    const base = name.replace(/\.[^.]+$/, "").trim().toLowerCase();
    if (!base) return true;
    // 中文名一般是用户自己起的，只有「截图」「未命名」这类才无意义
    if (/^(截图|图片|照片|未命名|表情包|表情)[\s\-_.0-9]*$/.test(base)) return true;
    // 纯数字 / 纯时间戳
    if (/^[\d\s\-_.]+$/.test(base)) return true;
    for (const prefix of GENERIC_NAME_PREFIXES) {
        if (base === prefix) return true;
        if (!base.startsWith(prefix)) continue;
        const rest = base.slice(prefix.length).replace(/^[\s\-_.]+/, "");
        if (!rest) return true;
        // 前缀后面只剩时间戳 / UUID / 纯数字 → 无意义
        if (/^[\da-f\s\-_.:tz]+$/.test(rest)) return true;
    }
    return base.length < 2;
}

/**
 * 给拆出来的第 i 块起名：base1、base2 ……（1 个就不加序号）。
 * 名字会进提示词供角色挑表情，所以调用方应把 base 换成有意义的词。
 */
export function buildSheetStickerNames(base: string, count: number): string[] {
    const trimmed = (base || "").trim().replace(/\s+/g, " ").slice(0, 24) || "表情";
    if (count <= 1) return [trimmed];
    return Array.from({ length: count }, (_, i) => `${trimmed}${i + 1}`);
}
