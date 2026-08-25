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

type FetchResult =
    | { ok: true; data: any; platform: string; mode: string; isList: boolean }
    | { ok: false; status: number; body: string };

async function tryFetchTikHub(tikhubUrl: string, apiKey: string, platform: string, mode: string, isList: boolean, signal: AbortSignal): Promise<FetchResult> {
    const res = await fetch(tikhubUrl, {
        signal,
        headers: {
            "User-Agent": "ai-virtual-phone-tikhub-proxy",
            "Authorization": `Bearer ${apiKey}`,
        },
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ok: false, status: res.status, body: txt.slice(0, 400) };
    }

    const j = await res.json().catch(() => null);
    return { ok: true, data: j, platform, mode, isList };
}

function makeTikHubUrl(req: NextRequest): { tikhubUrl: string; isList: boolean; mode: string; platform: string } | NextResponse {
    const mode = (req.nextUrl.searchParams.get("mode") || "detail").toLowerCase();
    const platform = (req.nextUrl.searchParams.get("platform") || "xhs").toLowerCase();
    const rawUrl = req.nextUrl.searchParams.get("url") || "";
    const keyword = (req.nextUrl.searchParams.get("keyword") || "").trim();
    const noteType = (req.nextUrl.searchParams.get("type") || "auto").toLowerCase();
    const sortType = (req.nextUrl.searchParams.get("sort") || "popularity_descending").toLowerCase();
    const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10) || 1;

    let tikhubUrl = "";
    let isList = false;

    if (mode === "search") {
        if (!keyword) {
            return NextResponse.json({ ok: false, error: "search 模式需要 keyword 参数" }, { status: 400, headers: corsHeaders() });
        }
        isList = true;
        if (platform === "bili") {
            tikhubUrl = `${TIKHUB_BASE}/api/v1/bilibili/web/search_video_v2?keyword=${encodeURIComponent(keyword)}&page=${page}`;
        } else {
            tikhubUrl = `${TIKHUB_BASE}/api/v1/xiaohongshu/app_v2/search_notes?keyword=${encodeURIComponent(keyword)}&page=${page}&sort_type=${sortType}`;
        }
    } else if (mode === "homefeed") {
        isList = true;
        tikhubUrl = `${TIKHUB_BASE}/api/v1/xiaohongshu/web_v3/fetch_homefeed?page=${page}`;
    } else {
        if (!rawUrl) {
            return NextResponse.json({ ok: false, error: "缺少 url 参数" }, { status: 400, headers: corsHeaders() });
        }
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
    }

    return { tikhubUrl, isList, mode, platform };
}

function finalizeResponse(j: any, platform: string, mode: string, isList: boolean, rawUrl: string): NextResponse {
    if (isList) {
        const items = normalizeList(platform, j);
        if (!items || items.length === 0) {
            return NextResponse.json(
                { ok: false, error: "未从返回数据中解析出任何笔记（链接可能无效或需登录）。" },
                { status: 502, headers: corsHeaders() },
            );
        }
        return NextResponse.json(
            { ok: true, data: { platform, mode, items, count: items.length } },
            { status: 200, headers: corsHeaders() },
        );
    }

    const data = normalize(platform, j, rawUrl);
    if (!data) {
        return NextResponse.json(
            { ok: false, error: "TikHub 返回数据无法解析（链接可能无效、已删除或需登录）。" },
            { status: 502, headers: corsHeaders() },
        );
    }
    return NextResponse.json({ ok: true, data }, { status: 200, headers: corsHeaders() });
}

export async function GET(req: NextRequest) {
    // key 双来源：优先服务端环境变量（推荐，不下发前端）；插件/参数 key 作为备用
    const envKey = (process.env.TIKHUB_API_KEY || "").trim();
    const paramKey = (req.nextUrl.searchParams.get("api_key") || "").trim();

    if (!envKey && !paramKey) {
        return NextResponse.json(
            { ok: false, error: "未配置 TikHub API Key：请在 Vercel 环境变量添加 TIKHUB_API_KEY，或在插件设置里填写 TikHub Key。" },
            { status: 500, headers: corsHeaders() },
        );
    }

    const rawUrl = req.nextUrl.searchParams.get("url") || "";
    const urlResult = makeTikHubUrl(req);
    if (urlResult instanceof NextResponse) return urlResult;
    const { tikhubUrl, isList, mode, platform } = urlResult;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18_000);

    try {
        const keysToTry = envKey
            ? envKey !== paramKey && paramKey
                ? [envKey, paramKey]
                : [envKey]
            : [paramKey];

        let lastError: { status: number; body: string } | null = null;

        for (const apiKey of keysToTry) {
            const result = await tryFetchTikHub(tikhubUrl, apiKey, platform, mode, isList, controller.signal);
            if (result.ok) {
                clearTimeout(timeout);
                return finalizeResponse(result.data, result.platform, result.mode, result.isList, rawUrl);
            }
            lastError = { status: result.status, body: result.body };
            // 401 才继续尝试下一个 key；其他错误直接返回
            if (result.status !== 401) break;
        }

        clearTimeout(timeout);

        const status = lastError?.status ?? 502;
        const body = lastError?.body ?? "";
        const is401 = status === 401;
        const error = is401
            ? `TikHub API Key 无效或已过期：${body.slice(0, 120)}。请检查 Vercel 环境变量 TIKHUB_API_KEY 或插件设置里的 TikHub Key。`
            : `TikHub 返回 ${status}：${body.slice(0, 200)}`;

        return NextResponse.json({ ok: false, error }, { status: is401 ? 401 : 502, headers: corsHeaders() });
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

// ── 列表归一化：把 search / homefeed 返回的笔记列表压成模型/插件直接可用的数组 ──
// TikHub 列表接口返回结构各异：data.notes / data.note_list / data.items / data.cards，
// 单个笔记有时包在 note / note_card 里。这里用候选容器 + 兜底深度收集兼容。

function collectNotes(obj: any, depth = 0, out: any[] = []): any[] {
    if (!obj || typeof obj !== "object" || depth > 6) return out;
    if (obj.title || obj.note_id || obj.note_id_str || obj.desc || obj.content) out.push(obj);
    const arr = Array.isArray(obj) ? obj : null;
    if (arr) {
        for (const it of arr) collectNotes(it, depth + 1, out);
        return out;
    }
    for (const k of Object.keys(obj)) collectNotes(obj[k], depth + 1, out);
    return out;
}

function normalizeList(platform: string, j: any): any[] {
    if (!j) return [];

    const candidates: any[] = [
        j?.data?.notes,
        j?.data?.note_list,
        j?.data?.items,
        j?.data?.list,
        j?.data?.cards,
        j?.data?.note_cards,
        Array.isArray(j?.data) ? j.data : null,
        j?.items,
        j?.notes,
    ].filter(Boolean);

    let rawList: any[] = [];
    for (const c of candidates) {
        if (Array.isArray(c) && c.length) {
            rawList = c;
            break;
        }
    }
    if (!rawList.length) rawList = collectNotes(j);

    return rawList
        .map((raw) => {
            const n = raw?.note || raw?.note_card || raw || {};
            const images = Array.isArray(n.image_list)
                ? n.image_list
                : Array.isArray(n.images)
                  ? n.images
                  : n.imageList || [];
            const imageList = images
                .map((im: any) => (typeof im === "string" ? im : im?.url || im?.src || im?.cover?.url || ""))
                .filter(Boolean);
            const cover = n.cover || n.cover_url || n.cover?.url || imageList[0] || "";
            const interact = n.interact_info || n.interaction_info || n.interactionInfo || {};
            const descRaw =
                n.desc || n.content || n.body || n.note_desc || n.caption || n.summary || "";
            const stats = [
                stat(n.liked_count ?? interact.liked_count ?? interact.likedCount, "赞"),
                stat(n.collected_count ?? interact.collected_count ?? interact.collectedCount, "收藏"),
                stat(n.comment_count ?? interact.comment_count ?? interact.commentCount, "评论"),
            ]
                .filter(Boolean)
                .join(" · ");
            const noteId = n.note_id || n.note_id_str || "";
            return {
                platform,
                title: n.title || n.caption || "",
                author: n.user?.nickname || n.user?.name || n.nickname || n.author || "",
                desc: typeof descRaw === "string" ? descRaw.slice(0, 220) : "",
                tags: normalizeTags(n.tag_list || n.tags || n.topic_list),
                cover,
                images: imageList,
                stats,
                url: noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : n.share_url || n.url || "",
                noteType: n.video || n.type === "video" ? "video" : "image",
            };
        })
        .filter((x) => x.title || x.desc)
        .slice(0, 12);
}
