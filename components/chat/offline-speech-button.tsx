"use client";

// components/chat/offline-speech-button.tsx
// 线下模式角色消息上的「朗读」控件：长得像单聊语音条，点一下用角色自己的声音把
// 台词念出来，再点一下停。单聊线下读该角色台词；群聊线下按「谁说的」拆成多个按钮，
// 每个按钮挂对应角色的嗓音，不串音。只在角色绑定了语音（如 MiniMax）时用它，
// 没绑就自动用设备自带中文朗读兜底。

import { memo, useEffect, useMemo, useState } from "react";
import {
    getActiveSpeechKey,
    subscribeSpeech,
    playCharacterSpeech,
} from "@/lib/speech-read-aloud";
import {
    extractSpokenLines,
    splitBySpeakers,
    type SpeakerSegment,
} from "@/lib/offline-speech-text";
import type { ContentAppId } from "@/lib/settings-types";

type Speaker = { id: string; name: string };

function SpeechChip({
    turnId,
    seg,
    showName,
    appId,
}: {
    turnId: string;
    seg: SpeakerSegment;
    showName: boolean;
    appId?: ContentAppId;
}) {
    const [active, setActive] = useState(false);
    const key = `offline:${turnId}:${seg.characterId}`;
    useEffect(() => {
        const unsub = subscribeSpeech(() => setActive(getActiveSpeechKey() === key));
        setActive(getActiveSpeechKey() === key);
        return unsub;
    }, [key]);

    return (
        <button
            type="button"
            className="chat-offline-tts"
            data-playing={active ? "" : undefined}
            onClick={(e) => {
                e.stopPropagation();
                void playCharacterSpeech(key, seg.characterId, seg.lines, appId);
            }}
            aria-label={active ? `停止朗读 ${seg.name}` : `朗读 ${seg.name} 的发言`}
            title={active ? `停止朗读 ${seg.name}` : `朗读 ${seg.name} 的发言`}
        >
            {active ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
            ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M4 9v6h4l5 5V4L8 9H4z" />
                    <path d="M16 8.5a4.5 4.5 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
            )}
            {showName && <span className="chat-offline-tts-name">{seg.name}</span>}
            {active && (
                <span className="chat-offline-tts-bars" aria-hidden="true">
                    <span className="chat-offline-tts-bar" style={{ animationDelay: "0s" }} />
                    <span className="chat-offline-tts-bar" style={{ animationDelay: "0.12s" }} />
                    <span className="chat-offline-tts-bar" style={{ animationDelay: "0.24s" }} />
                </span>
            )}
        </button>
    );
}

function OfflineSpeechControlsInner({
    turnId,
    text,
    speakers,
    isGroup,
    appId,
}: {
    turnId: string;
    text: string;
    speakers: Speaker[];
    isGroup: boolean;
    appId?: ContentAppId;
}) {
    const segments = useMemo<SpeakerSegment[]>(() => {
        if (!text) return [];
        // 群聊线下是「第三人称连续叙事」（模型不输出「角色名：」标签，见 builtin-preset 的
        // group_chat_offline_format），无法可靠地把台词归属到某个角色。为避免把 A 的台词错配成
        // B 的嗓音（用户明确「别弄差了」），群聊线下整段用中性嗓音朗读，不做按人拆分。
        if (isGroup) {
            const lines = extractSpokenLines(text);
            if (!lines) return [];
            return [{ characterId: "", name: "这段场景", lines }];
        }
        const sp = speakers[0];
        if (!sp) return [];
        const lines = extractSpokenLines(text);
        if (!lines) return [];
        return [{ characterId: sp.id, name: sp.name, lines }];
    }, [text, isGroup, speakers]);

    if (!segments.length) return null;
    const showName = isGroup || segments.length > 1;

    return (
        <div className="chat-offline-tts-row">
            {segments.map((seg, i) => (
                <SpeechChip key={`${seg.characterId}-${i}`} turnId={turnId} seg={seg} showName={showName} appId={appId} />
            ))}
        </div>
    );
}

export const OfflineSpeechControls = memo(OfflineSpeechControlsInner);
