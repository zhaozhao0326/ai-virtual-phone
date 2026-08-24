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

// ── 归一化：把 TikHub 返回的嵌套结构压成插件直接可用的干净对象 ──
// TikHub 各端点笔记对象的层级不统一（data / data.data / data.note_list[0] /
// data.items[0] / response 等），互动数据在 interact_info 里，正文字段叫 desc/content/body。
// 这里用「候选路径 + 递归兜底」避免单一层级假设导致解析失败。

function stat(n: any, label: string): string | null {
    const num = typeof n === "number" ? n : parseInt(String(n ?? ""), 10);
    if (!num || num <= 0) return null;
    return `${num.toLocaleString("en-US")} ${label}`;
}

function normalizeTags(t: any): string[] {
    if (!t) return [];
    if (Array.isArray(t)) {
        return t.map((x) => (typeof x === "string" ? x : x?.name || x?.tag || x?.title || "")).filter(Boolean).slice(0, 10);
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

// 深度优先找到「看起来像笔记」的对象：含 title / note_id / desc / content 之一即可。
function findNote(obj: any, depth = 0): any {
    if (!obj || typeof obj !== "object" || depth > 7) return null;
    if (obj.title || obj.note_id || obj.note_id_str || obj.desc || obj.content || obj.caption) return obj;
    if (Array.isArray(obj)) {
        for (const it of obj) {
            const r = findNote(it, depth + 1);
            if (r) return r;
        }
        return null;
    }
    for (const k of Object.keys(obj)) {
        const r = findNote(obj[k], depth + 1);
        if (r) return r;
    }
    return null;
}

function locateNote(j: any): any {
    if (!j) return null;
    const candidates = [
        j?.data?.data,
        j?.data?.note,
        j?.data?.note_list?.[0],
        j?.data?.notes?.[0],
        j?.data?.items?.[0],
        j?.data?.list?.[0],
        Array.isArray(j?.data) ? j.data[0] : null,
        j?.data,
        j?.response?.data,
        j?.response,
        j,
    ];
    for (const c of candidates) {
        const f = findNote(c);
        if (f) return f;
    }
    return null;
}

function normalize(platform: string, j: any, rawUrl: string): any {
    const note = locateNote(j);
    if (!note) return null;

    if (platform === "xhs") {
        const images = Array.isArray(note.image_list)
            ? note.image_list
            : Array.isArray(note.images)
              ? note.images
              : note.imageList || [];
        const imageList = images
            .map((im: any) => (typeof im === "string" ? im : im?.url || im?.src || ""))
            .filter(Boolean);
        const cover = note.cover || note.cover_url || imageList[0] || "";
        const interact = note.interact_info || note.interaction_info || note.interactionInfo || {};
        const descRaw = note.desc || note.content || note.body || note.note_desc || note.caption || note.summary || "";
        const stats = [
            stat(note.liked_count ?? interact.liked_count ?? interact.likedCount, "赞"),
            stat(note.collected_count ?? interact.collected_count ?? interact.collectedCount, "收藏"),
            stat(note.comment_count ?? interact.comment_count ?? interact.commentCount, "评论"),
            stat(note.share_count ?? interact.share_count ?? interact.shareCount, "分享"),
        ]
            .filter(Boolean)
            .join(" · ");
        return {
            platform: "xhs",
            url: rawUrl,
            title: note.title || note.caption || "",
            author: note.user?.nickname || note.user?.name || note.nickname || note.author || "",
            desc: typeof descRaw === "string" ? descRaw : "",
            tags: normalizeTags(note.tag_list || note.tags || note.topic_list),
            cover,
            images: imageList,
            stats,
            noteType: note.video || note.type === "video" ? "video" : "image",
        };
    }

    // bili
    const owner = note.owner?.name || note.owner_name || note.author || note.uploader || "";
    const st = note.stat || note.statistic || note.archive_stat || {};
    const descRaw = note.desc || note.description || "";
    return {
        platform: "bili",
        url: rawUrl,
        title: note.title || "",
        author: owner,
        desc: typeof descRaw === "string" ? descRaw : "",
        tags: normalizeTags(note.tag || note.tags),
        cover: note.pic || note.cover || "",
        images: note.pic ? [note.pic] : [],
        stats: [
            stat(st.view ?? st.view_count ?? note.view, "播放"),
            stat(st.danmaku ?? note.danmaku, "弹幕"),
            stat(st.like ?? st.liked_count ?? note.like, "赞"),
        ]
            .filter(Boolean)
            .join(" · "),
        noteType: "video",
    };
}
