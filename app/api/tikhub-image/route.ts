import { NextRequest, NextResponse } from "next/server";

// 图片代理：前端直接 <img src> 引用小红书 / B站 CDN 时，常被对方防盗链（referer 校验）或
// 跨域策略拦截导致封面图加载失败、卡片只有文字。这里由本站服务端代拉图片再原样返回，
// 前端改为引用本域名 /api/tikhub-image?url=<图片地址>，彻底绕开防盗链与跨域限制。
//
// SSRF 防护：只允许白名单域名后缀，禁止任意转发目标（内网/元数据地址等一律拒掉）。

export const runtime = "nodejs";
export const maxDuration = 20;

const ALLOWED_SUFFIX = [
  ".xhscdn.com",
  ".xiaohongshu.com",
  ".hdslb.com",
  ".bilibili.com",
  ".bilivideo.com",
];

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=86400",
  };
}

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("url") || "").trim();
  if (!raw) {
    return new NextResponse("missing url", { status: 400 });
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return new NextResponse("invalid url", { status: 400 });
  }

  if (u.protocol !== "https:") {
    return new NextResponse("only https allowed", { status: 403 });
  }
  if (!ALLOWED_SUFFIX.some((s) => u.hostname.endsWith(s))) {
    return new NextResponse("host not allowed", { status: 403 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(u.toString(), {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Referer": u.origin + "/",
      },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return new NextResponse("upstream " + res.status, { status: 502 });
    }

    const buf = await res.arrayBuffer();
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") || "image/jpeg",
        ...corsHeaders(),
      },
    });
  } catch (e) {
    clearTimeout(timeout);
    const msg = e instanceof Error ? e.message : String(e);
    return new NextResponse(msg.includes("abort") ? "upstream timeout" : "fetch error", {
      status: 504,
    });
  }
}
