import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, type Dispatcher } from "undici";

// ── Vercel 服务端聊天/文本生成中转 ──────────────────────────────
// 浏览器（尤其海外不可直连 Cli 代理的设备，如小米手机）只连国内 Vercel，
// 由部署在海外的 Vercel 函数去调上游 OpenAI 兼容 / Gemini / Anthropic 端点。
// 客户端把 buildProviderRequest 算好的 { url, headers, body } 原样透传过来，
// 服务器只做转发，不解析业务、不落盘 apiKey（Authorization 走 header 透传，与裸连等价）。

export const maxDuration = 120;

function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

async function externalFetch(url: string, init: RequestInit): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  return dispatcher
    ? fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher })
    : fetch(url, init);
}

type ChatRelayRequest = {
  targetUrl?: string;
  headers?: Record<string, string>;
  body?: string;
};

export async function POST(req: NextRequest) {
  let input: ChatRelayRequest;
  try {
    input = await req.json() as ChatRelayRequest;
  } catch {
    return NextResponse.json({ error: "请求体不是有效 JSON" }, { status: 400 });
  }

  const { targetUrl, headers, body } = input;
  if (!targetUrl) return NextResponse.json({ error: "缺少 targetUrl" }, { status: 400 });
  if (!body) return NextResponse.json({ error: "缺少 body" }, { status: 400 });

  // SSRF 基础防护：仅允许 http/https 上游
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return NextResponse.json({ error: "非法的上游协议" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "非法的 targetUrl" }, { status: 400 });
  }

  // 剥离浏览器注入、服务端转发无意义或有害的 header；保留 Authorization 等用户头（含 apiKey）
  const forwardHeaders: Record<string, string> = { ...(headers || {}) };
  delete forwardHeaders["host"];
  delete forwardHeaders["connection"];
  delete forwardHeaders["content-length"];
  delete forwardHeaders["transfer-encoding"];

  let upstream: Response;
  try {
    upstream = await externalFetch(targetUrl, {
      method: "POST",
      headers: forwardHeaders,
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[CHAT-RELAY] upstream fetch failed:", message);
    return NextResponse.json({ error: `Relay 连接上游失败: ${message}` }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || "application/json";
  const isStream = contentType.includes("text/event-stream") || contentType.includes("application/stream+json");

  if (isStream && upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}
