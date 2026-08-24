// lib/music-together.ts
// 音乐「一起听」：用户选一位角色配对，共享正在播放；角色在对话中被告知
// 「你正和 TA 一起听这首歌」，可自然提起。借鉴 IB-Mobile 的 Listen Together，
// 但落成小手机自己的轻量形态：配对状态存 localStorage，正在播放经模块级
// 单例桥接（React context 播放状态 → 纯 lib 的 chat-engine prompt 组装）。

import { kvGet, kvSet } from "./kv-db";
import type { MusicTrack } from "./music-storage";

const TOGETHER_CHAR_KEY = "ai_phone_listen_together_char_v1";
const TOGETHER_SINCE_KEY = "ai_phone_listen_together_since_v1";

// ── 配对状态 ──

export function getListenTogetherCharacterId(): string | null {
    if (typeof window === "undefined") return null;
    try {
        const v = kvGet(TOGETHER_CHAR_KEY);
        return v ? String(v) : null;
    } catch {
        return null;
    }
}

export function getListenTogetherSince(): number {
    if (typeof window === "undefined") return 0;
    try {
        return Number(kvGet(TOGETHER_SINCE_KEY) || 0) || 0;
    } catch {
        return 0;
    }
}

/** 配对（开始一起听）或解除配对（传 null）。 */
export function setListenTogether(characterId: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (characterId) {
            kvSet(TOGETHER_CHAR_KEY, characterId);
            kvSet(TOGETHER_SINCE_KEY, String(Date.now()));
        } else {
            kvSet(TOGETHER_CHAR_KEY, "");
            kvSet(TOGETHER_SINCE_KEY, "0");
        }
    } catch {
        // ignore
    }
}

/** 已累计一起听的分钟数（取整）。 */
export function getListenTogetherMinutes(): number {
    const since = getListenTogetherSince();
    if (!since) return 0;
    return Math.max(1, Math.round((Date.now() - since) / 60000));
}

// ── 正在播放桥接（React context → chat-engine） ──
// MusicProvider 在播放状态变化时写入，chat-engine 组装 prompt 时读取。

let _nowPlaying: { title: string; artist: string } | null = null;
let _nowPlayingAt = 0;

export function setNowPlayingForPrompt(track: MusicTrack | null): void {
    if (!track) {
        _nowPlaying = null;
        _nowPlayingAt = 0;
        return;
    }
    _nowPlaying = { title: track.title, artist: track.artist || "" };
    _nowPlayingAt = Date.now();
}

export function getNowPlayingForPrompt(): { title: string; artist: string } | null {
    // 播放中状态超过 10 分钟未刷新视为已停止（防御陈旧状态）
    if (!_nowPlaying || Date.now() - _nowPlayingAt > 10 * 60 * 1000) return null;
    return _nowPlaying;
}

/**
 * 生成「正在一起听」注入文本：
 * - 有配对角色且正在播放 → 返回提示
 * - 无配对 / 未播放 → 返回 null（不注入）
 */
export function buildListenTogetherPrompt(): string | null {
    const charId = getListenTogetherCharacterId();
    if (!charId) return null;
    const track = getNowPlayingForPrompt();
    if (!track) return null;
    const minutes = getListenTogetherMinutes();
    const song = `${track.title}${track.artist ? ` · ${track.artist}` : ""}`;
    return [
        `【一起听】你正在和 {{user}} 一起听「${song}」，已经一起听了 ${minutes} 分钟。`,
        "这是你们共享的时刻，可以自然地在对话中提起这首歌、聊聊感受；不知道说什么时也可以安静陪听。",
    ].join("\n");
}
