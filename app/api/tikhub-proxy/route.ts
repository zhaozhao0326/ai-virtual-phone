import { NextRequest, NextResponse } from "next/server";

// 服务端 TikHub 代理：把浏览器无法直接跨域请求的 TikHub API 改由本站服务器代发，
// 绕开浏览器 CORS 限制（纯前端直连 api.tikhub.io 会被浏览器拦截，表现 Failed to fetch）。
//
// API Key 只存在服务端环境变量 TIKHUB_API_KEY，绝不下发到前端/插件代码，避免泄露。
// 本路由只访问固定的 api.tikhub.io，不接受任意转发目标，无 SSRF 风险。
//
// GET /api/tikhub-proxy?platform=xhs|bili&url=<分享链接>&type=image|video|auto
// 返回 { ok: true, data: {platform,title,author,desc,tags,cover,images,stats,url,noteType} }
//   或 { ok: false, error: "可读原因" }

export const runtime = "nodejs";
export const maxDuration = 20;

const TIKHUB_BASE = "https://api.tikhub.io";
const API_KEY = process.env.TIKHUB_API_KEY;

function corsHeaders(): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
    };
}

export async function OPTIONS() {
    return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: NextRequest) {
    // key 双来源：优先服务端环境变量（推荐，不下发前端）；未配置时接受插件传来的 api_key（单用户私有部署降级）
    const envKey = (process.env.TIKHUB_API_KEY || "").trim();
    const paramKey = (req.nextUrl.searchParams.get("api_key") || "").trim();
    const apiKey = envKey || paramKey;

    if (!apiKey) {
        return NextResponse.json(
            { ok: false, error: "未配置 TikHub API Key：请在 Vercel 环境变量添加 TIKHUB_API_KEY，或在插件设置里填写 TikHub Key。" },
            { status: 500, headers: corsHeaders() },
        );
    }

    const platform = (req.nextUrl.searchParams.get("platform") || "").toLowerCase();
    const rawUrl = req.nextUrl.searchParams.get("url") || "";
    const noteType = (req.nextUrl.searchParams.get("type") || "auto").toLowerCase();

    if (!rawUrl) {
        return NextResponse.json({ ok: false, error: "缺少 url 参数" }, { status: 400, headers: corsHeaders() });
    }

    let tikhubUrl = "";
    if (platform === "xhs") {
        const ep = noteType === "video" ? "get_video_note_detail" : "get_image_note_detail";
        tikhubUrl = `${TIKHUB_BASE}/api/v1/xiaohongshu/app_v2/${ep}?share_text=${encodeURIComponent(rawUrl)}`;
    } else if (platform === "bili") {
        tikhubUrl = `${TIKHUB_BASE}/api/v1/bilibili/web/fetch_one_video_v3?url=${encodeURIComponent(rawUrl)}`;
    } else {
        return NextResponse.json(
            { ok: false, error: "不支持的平台（platform 应为 xhs 或 bili）" },
            { status: 400, headers: corsHeaders() },
        );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18_000);
    try {
        // TikHub 新版要求 api_key 走 Authorization Bearer header（query string 已被拒绝，返回 401）
        const res = await fetch(tikhubUrl, {
            signal: controller.signal,
            headers: {
                "User-Agent": "ai-virtual-phone-tikhub-proxy",
                "Authorization": `Bearer ${apiKey}`,
            },
        });
        clearTimeout(timeout);

        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return NextResponse.json(
                { ok: false, error: `TikHub 返回 ${res.status}：${txt.slice(0, 200)}` },
                { status: 502, headers: corsHeaders() },
            );
        }

        const j = await res.json().catch(() => null);
        const data = normalize(platform, j, rawUrl);
        if (!data) {
            return NextResponse.json(
                { ok: false, error: "TikHub 返回数据无法解析（链接可能无效、已删除或需登录）。" },
                { status: 502, headers: corsHeaders() },
            );
        }
        return NextResponse.json({ ok: true, data }, { status: 200, headers: corsHeaders() });
    } catch (e) {
        clearTimeout(timeout);
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { ok: false, error: msg.includes("abort") ? "TikHub 请求超时（18秒）" : `请求异常：${msg}` },
            { status: 504, headers: corsHeaders() },
        );
    }
}

// ── 归一化：把 TikHub 返回的复杂结构压成插件直接可用的干净对象 ──

function stat(n: any, label: string): string | null {
    const num = typeof n === "number" ? n : parseInt(String(n ?? ""), 10);
    if (!num || num <= 0) return null;
    return `${num} ${label}`;
}

function normalizeTags(t: any): string[] {
    if (!t) return [];
    if (Array.isArray(t)) {
        return t.map((x) => (typeof x === "string" ? x : x?.name || x?.tag || "")).filter(Boolean).slice(0, 10);
    }
    if (typeof t === "string") {
        return t
            .split(/[,，#\s]+/)
            .map((s) => s.replace(/^#/, "").trim())
            .filter(Boolean)
            .slice(0, 10);
    }
    return [];
}

function pick(j: any): any {
    if (!j) return null;
    const data = j.data || j.response || j;
    if (data && (data.title || data.desc || data.content || data.note_id || data.bvid)) return data;
    return null;
}

function normalize(platform: string, j: any, rawUrl: string): any {
    const data = pick(j);
    if (!data) return null;

    if (platform === "xhs") {
        const images = Array.isArray(data.images) ? data.images : data.imageList || [];
        const cover = data.cover || (images[0] && (images[0].url || images[0])) || "";
        const imageList = images.map((im: any) => (typeof im === "string" ? im : im?.url || "")).filter(Boolean);
        return {
            platform: "xhs",
            url: rawUrl,
            title: data.title || "",
            author: data.nickname || data.user?.nickname || "",
            desc: data.desc || data.content || "",
            tags: normalizeTags(data.tag_list),
            cover,
            images: imageList,
            stats: [stat(data.liked_count, "赞"), stat(data.collected_count, "收藏"), stat(data.comment_count, "评论")]
                .filter(Boolean)
                .join(" · "),
            noteType: data.video ? "video" : "image",
        };
    }

    const owner = data.owner?.name || data.owner_name || "";
    const statObj = data.stat || {};
    return {
        platform: "bili",
        url: rawUrl,
        title: data.title || "",
        author: owner,
        desc: data.desc || "",
        tags: [],
        cover: data.pic || "",
        images: data.pic ? [data.pic] : [],
        stats: [stat(statObj.view, "播放"), stat(statObj.danmaku, "弹幕"), stat(statObj.like, "赞")].filter(Boolean).join(" · "),
        noteType: "video",
    };
}
