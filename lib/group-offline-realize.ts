// lib/group-offline-realize.ts
// 「群聊线下剧情 → 真实群聊」桥：把群聊线下模式产出的散文叙事，抽成「谁说了什么」气泡，
// 落成进同一个真实群会话的 messages（characterId 归位，像角色真的在群里发了那条话）。
//
// 设计铁律（来自用户需求）：
//  - 手动触发：只在用户点「落成真实群」时跑，不后台轮询、不自动同步（安静 / 默认关）。
//  - 一次 LLM 抽取：仅在用户主动触发时烧 1 次 token；抽取后先预览可改再确认，确认才落库。
//  - 零核心破坏：只新增只读抽取 + 调 pushChatMessage，不碰群聊/离线引擎逻辑。
//
// 复用真实契约：
//  - session.participantIds 是群成员 characterId 数组；loadCharacters() 反查名字。
//  - pushChatMessage({ sessionId, role:"assistant", content, characterId }) 落角色气泡。
//  - buildGroupChatPromptMessages(session, []) 复用群聊真实 config 解析；sendLLMRequest 调模型。

import { ChatSession, pushChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { buildGroupChatPromptMessages } from "./group-chat-engine";
import { sendLLMRequest } from "./chat-engine";
import type { LLMMessage } from "./llm-prompt-assembler";
import { loadChatOfflineTurns, type ChatOfflineTurn } from "./chat-offline-storage";

export type GroupMemberRef = { id: string; name: string };

export type ExtractedBubble = {
    /** 模型原始输出行（仅用于调试/去重） */
    raw: string;
    /** 解析出的发言者名字（可能含括号等修饰，仅展示用） */
    speakerName: string;
    /** 解析出的发言正文 */
    line: string;
    /** 命中群成员后的 characterId；未命中为 null（UI 默认「跳过」） */
    speakerId: string | null;
};

export type RealizeResult = { pushed: number; skipped: number };

/** 由 session.participantIds 构建「id → 展示名」花名册 */
function buildRoster(session: ChatSession): GroupMemberRef[] {
    const ids = session.participantIds || [];
    if (ids.length === 0) return [];
    const chars = loadCharacters();
    return ids.map((id) => {
        const c = chars.find((ch) => ch.id === id);
        return { id, name: c?.name || id };
    });
}

/** 把抽取出的发言者名字匹配到真实群成员（精确 → 包含；都不中返回 null） */
function matchSpeaker(name: string, roster: GroupMemberRef[]): string | null {
    const n = (name || "").trim();
    if (!n) return null;
    let hit = roster.find((r) => r.name.toLowerCase() === n.toLowerCase());
    if (hit) return hit.id;
    // 模型可能返回「白羽（小声）」「萧齐：」等带修饰，做包含匹配兜底
    hit = roster.find((r) => n.includes(r.name) || r.name.includes(n));
    if (hit) return hit.id;
    return null;
}

function buildExtractionSystem(rosterNames: string[]): string {
    return [
        "你是一个文本结构化助手。下面是一段「群聊线下剧情」的散文叙事，描述了一个微信群里多位成员线下发生的互动。",
        "请把其中「由群成员说出的对白 / 发言」提取出来，转换成微信群聊里的真实气泡。",
        "规则：",
        "1. 每行输出一条气泡，严格用格式：角色名：发言内容",
        "2. 角色名必须是以下成员之一（不要编造、不要写「用户」）：" + rosterNames.join("、"),
        "3. 只提取「某人说了什么」，不要提取动作 / 神态 / 环境描写（那些不是群消息）。",
        "4. 若某段只有动作没有说话，跳过，不要生成气泡。",
        "5. 保持原话意思，不要改写、不要合并多人的话到同一行、不要添加角色名以外的任何前缀。",
        "6. 按剧情时间顺序输出。",
        "7. 只输出气泡行，不要任何解释、标题或空行。",
    ].join("\n");
}

/**
 * 调用一次 LLM，把群聊线下叙事抽成「角色：一句话」气泡序列。
 * 仅在用户主动触发时调用（烧 1 次 token）。返回已尽力匹配 speakerId 的气泡列表。
 */
export async function extractGroupBubbles(
    session: ChatSession,
    offlineTurns: ChatOfflineTurn[],
    options?: { signal?: AbortSignal },
): Promise<ExtractedBubble[]> {
    const roster = buildRoster(session);
    if (roster.length === 0) return [];

    const prose = offlineTurns
        .map((t) => t.assistantContent)
        .filter((s) => typeof s === "string" && s.trim())
        .join("\n\n");
    if (!prose.trim()) return [];

    // 复用群聊真实 config / preset / regexes 解析，保证走用户给该群绑定的模型与预设
    const { config, preset, regexes } = await buildGroupChatPromptMessages(session, [], {
        appTags: ["group_chat", "offline"],
        excludeOfflineSessionId: session.id,
        disableTools: true,
    });

    const llmMessages: LLMMessage[] = [
        { role: "system", content: buildExtractionSystem(roster.map((r) => r.name)) },
        { role: "user", content: prose },
    ];

    const raw = await sendLLMRequest(
        config,
        preset,
        llmMessages,
        regexes,
        { characterName: `群聊:${session.groupName || "群聊"}` },
        {
            appId: "group_chat",
            appTags: ["group_chat", "offline"],
            debugSessionId: session.id,
            signal: options?.signal,
            purpose: "group-offline-realize",
        },
    );

    return parseBubbles(raw, roster);
}

/** 把模型输出解析为气泡；无法解析出「角色：内容」的行直接丢弃 */
function parseBubbles(raw: string, roster: GroupMemberRef[]): ExtractedBubble[] {
    const lines = (raw || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const out: ExtractedBubble[] = [];
    for (const line of lines) {
        const m = line.match(/^([^：:]+)[：:]\s*([\s\S]*)$/);
        if (!m) continue;
        const speakerName = m[1].trim();
        const text = m[2].trim();
        if (!speakerName || !text) continue;
        out.push({
            raw: line,
            speakerName,
            line: text,
            speakerId: matchSpeaker(speakerName, roster),
        });
    }
    return out;
}

/**
 * 把用户确认过的气泡落成进真实群会话。每条带 speakerId 的气泡以角色身份推一条 assistant 消息
 * （用 senderCharacterId + senderName 归位发言者，与群聊引擎自身落库字段一致）。
 * 落库后广播刷新事件，让真实群视图出现这些气泡。返回落成 / 跳过计数。
 */
export async function realizeOfflineTurnsToGroup(
    session: ChatSession,
    bubbles: { line: string; speakerId: string | null }[],
): Promise<RealizeResult> {
    const chars = loadCharacters();
    const nameOf = (id: string): string => {
        const c = chars.find((ch) => ch.id === id);
        return c?.name || id;
    };
    let pushed = 0;
    let skipped = 0;
    for (const b of bubbles) {
        const line = (b.line || "").trim();
        if (!b.speakerId || !line) {
            skipped += 1;
            continue;
        }
        pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content: line,
            senderCharacterId: b.speakerId,
            senderName: nameOf(b.speakerId),
        });
        pushed += 1;
    }
    if (pushed > 0 && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
        window.dispatchEvent(new CustomEvent("weixin-messages-updated", { detail: { sessionId: session.id } }));
    }
    return { pushed, skipped };
}

/** 便捷：取当前群的离线轮次（供 UI 直接传） */
export function loadGroupOfflineTurns(sessionId: string): ChatOfflineTurn[] {
    return loadChatOfflineTurns(sessionId);
}
