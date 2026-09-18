// lib/speech-read-aloud.ts
// 线下模式「朗读角色发言」的播放控制器（单例）。
//
// 每个角色都可能在设置里绑定了自己的语音（如 MiniMax / OpenAI TTS）。朗读时：
//  - 优先用该角色自己的语音配置（resolveVoiceConfig）走 tts-service 合成，再用 playAudioBlob 播放
//    —— 这样「角色 A 说的话用 A 的声音，角色 B 用 B 的声音」，不会串角色。
//  - 角色没绑语音时，回落到浏览器内置 SpeechSynthesis（免费、零 token），用中文嗓音兜底。
//
// 单例：全局同时只播一条。点新角色 / 新条会先停掉正在播的，避免几个声音叠在一起。

import { resolveVoiceConfig, synthesizeSpeech, playAudioBlob } from "./tts-service";
import type { ContentAppId } from "./settings-types";

type SpeechListener = () => void;

let activeKey: string | null = null;
let activeAbort: (() => void) | null = null;
let activeUtterance: SpeechSynthesisUtterance | null = null;
const listeners = new Set<SpeechListener>();

function emit() {
    listeners.forEach((l) => { try { l(); } catch { /* ignore */ } });
}

export function subscribeSpeech(listener: SpeechListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getActiveSpeechKey(): string | null {
    return activeKey;
}

function stopCurrent() {
    if (activeAbort) { try { activeAbort(); } catch { /* ignore */ } activeAbort = null; }
    if (activeUtterance) {
        try {
            if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
        } catch { /* ignore */ }
        activeUtterance = null;
    }
}

export function stopSpeech(): void {
    stopCurrent();
    if (activeKey !== null) {
        activeKey = null;
        emit();
    }
}

/**
 * 取角色语音配置：先按会话类型（群聊 group_chat / 单聊 chat）找，找不到再退到 chat 全局绑定。
 * 这样角色在单聊里绑的嗓音，群聊线下也能用上。
 */
function resolveVoice(characterId: string, appId: ContentAppId | undefined): ReturnType<typeof resolveVoiceConfig> {
    const primary = resolveVoiceConfig(characterId, appId);
    if (primary) return primary;
    if (appId && appId !== "chat") return resolveVoiceConfig(characterId, "chat");
    return null;
}

/**
 * 朗读某角色说的一段话。
 * - key：用来区分「现在是不是我在播」（同一 key 再点一次 = 停）。
 * - characterId：决定用哪个角色的嗓音（MiniMax / 浏览器兜底）。
 * - text：要读的文本（已经是该角色自己的台词）。
 * - appId：会话类型，用于解析角色语音绑定。
 */
export async function playCharacterSpeech(
    key: string,
    characterId: string,
    text: string,
    appId?: ContentAppId,
): Promise<void> {
    if (typeof window === "undefined") return;
    if (!text || !text.trim()) return;
    if (activeKey === key) {
        stopSpeech();
        return;
    }
    stopCurrent();

    const cfg = resolveVoice(characterId, appId);
    if (cfg) {
        try {
            const blob = await synthesizeSpeech(text, cfg);
            if (!blob) throw new Error("合成未返回音频");
            const player = playAudioBlob(blob);
            activeAbort = player.abort;
            const onEnd = () => {
                if (activeKey === key) {
                    activeKey = null;
                    activeAbort = null;
                    emit();
                }
            };
            void player.promise.then(onEnd).catch(onEnd);
            activeKey = key;
            emit();
            return;
        } catch {
            // 合成失败（没配 key / 网络问题等）→ 回落浏览器朗读
        }
    }

    // 浏览器内置朗读兜底（免费、零 token）
    if (!("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const zh = voices.find((v) => /^zh/i.test(v.lang))
        || voices.find((v) => /chinese|中文|普通话/i.test(v.name))
        || null;
    if (zh) utterance.voice = zh;
    utterance.lang = zh?.lang || "zh-CN";
    utterance.rate = 1;
    utterance.pitch = 1;
    const onDone = () => {
        if (activeKey === key) {
            activeKey = null;
            activeUtterance = null;
            emit();
        }
    };
    utterance.onend = onDone;
    utterance.onerror = onDone;
    activeUtterance = utterance;
    activeKey = key;
    emit();
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    window.speechSynthesis.speak(utterance);
}
