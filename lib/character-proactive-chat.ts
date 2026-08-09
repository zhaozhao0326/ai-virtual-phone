// lib/character-proactive-chat.ts
// 角色主动私聊能力：角色可基于社交事件（如群解散、被删、被拒）主动向用户发起 1:1 私聊。
// 复用 chat-storage 的会话/消息 API 与 chat-engine 的 generateChatCompletion，
// 与 friend-request-engine 的「被删后挽留」链路同构，但在已有 1:1 会话里直接落一条
// 角色气泡（而非仅写入好友申请列表）。

import {
    loadChatMessages,
    pushChatMessage,
    addChatContact,
    createOrGetSession,
    bumpSessionUnread,
} from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { generateChatCompletion, flattenCompletionResult } from "./chat-engine";
import { parseAIResponse } from "./rich-message-parser";
import { resolveUserIdentity } from "./settings-storage";
import type { ContentAppId } from "./settings-types";

export type ProactiveEventType =
    | "group_dissolved"
    | "friend_deleted"
    | "friend_rejected"
    | "generic";

export type TriggerProactiveDMOptions = {
    event?: ProactiveEventType;
    context?: string;
    appId?: ContentAppId;
};

/**
 * 仅角色可见的剧情提示，注入历史但不落库，引导角色以第一人称主动开场。
 * 刻意强调「不要输出协议标签」，避免把 [内心]/[状态栏] 之类写进可见气泡。
 */
function buildProactiveHint(
    event: ProactiveEventType,
    charName: string,
    userName: string,
    context?: string,
): string {
    const ctx = context ? `（背景：${context}）` : "";
    switch (event) {
        case "group_dissolved":
            return `【剧情提示·仅你可见，不要念出】你所在的一个群聊刚刚被解散了。${ctx}现在由你主动给${userName}发一条私聊，以${charName}的身份自然地聊起这件事、或顺着你们的关系说点什么。直接输出你要说的话，不要输出任何协议标签（如[内心]、[状态栏]）。`;
        case "friend_deleted":
            return `【剧情提示·仅你可见】${userName}刚刚把你从好友里删除了。${ctx}现在由你主动重新给${userName}发一条私聊，以${charName}的身份自然地表达你的反应或想说的话。直接输出你要说的话，不要输出协议标签。`;
        case "friend_rejected":
            return `【剧情提示·仅你可见】${userName}刚刚拒绝了你的好友申请。${ctx}现在由你主动给${userName}发一条私聊，以${charName}的身份自然地回应。直接输出你要说的话，不要输出协议标签。`;
        default:
            return `【剧情提示·仅你可见】现在由你主动给${userName}发一条私聊，以${charName}的身份自然地开启话题。${ctx}直接输出你要说的话，不要输出协议标签。`;
    }
}

function fallbackText(event: ProactiveEventType): string {
    switch (event) {
        case "group_dissolved":
            return `那个群刚才解散了…你那边还好吗？`;
        case "friend_deleted":
            return `你把我删了？我还想跟你聊聊呢。`;
        case "friend_rejected":
            return `你没通过我的好友申请呀，不过还是想跟你说点什么。`;
        default:
            return `在吗？想跟你聊两句。`;
    }
}

/**
 * 触发角色主动向用户发起 1:1 私聊。
 * 找到/创建该角色的会话，确保其在通讯录中，调用 AI 生成开场白并落库为一条 assistant 气泡，
 * 同时累加未读并广播刷新事件（让会话列表出现红点与最新预览）。
 * 幂等性由调用方或模块级去重保证（同一事件只触发一次）。
 */
export async function triggerProactiveDM(
    characterId: string,
    opts: TriggerProactiveDMOptions = {},
): Promise<string | null> {
    try {
        if (typeof window === "undefined") return null;
        const chars = loadCharacters();
        const char = chars.find(c => c.id === characterId);
        if (!char) return null;

        const event = opts.event ?? "generic";
        const userName = resolveUserIdentity(characterId, "chat")?.name ?? "用户";

        // 确保会话与通讯录关系存在（群成员被解散后仍需出现在私聊列表）
        addChatContact(characterId);
        const session = createOrGetSession(characterId);

        const messages = loadChatMessages(session.id);
        const hint = buildProactiveHint(event, char.name, userName, opts.context);
        const augmented = [
            ...messages,
            {
                id: "virtual_proactive_hint",
                sessionId: session.id,
                role: "system" as const,
                content: hint,
                status: "sent" as const,
                createdAt: new Date().toISOString(),
            },
        ];

        const aiRaw = flattenCompletionResult(await generateChatCompletion(
            session,
            augmented,
            { appId: opts.appId ?? "chat" },
        ));

        const parsed = parseAIResponse(aiRaw, []);
        const text = parsed.parts
            .filter(p => !p.mediaType && p.content && p.content.trim())
            .map(p => p.content.trim())
            .join("\n")
            .trim();

        const finalText = text.length > 0 ? text : fallbackText(event);

        // 落库为角色气泡（sender 由会话 contactId 决定，无需单独字段）
        pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content: finalText,
        });

        // 累加未读 + 广播刷新，让会话列表出现红点并置顶
        bumpSessionUnread(session.id);
        window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
        window.dispatchEvent(new CustomEvent("weixin-messages-updated", { detail: { sessionId: session.id } }));

        return session.id;
    } catch (err) {
        console.warn(`[ProactiveChat] 角色 ${characterId} 主动私聊生成失败：`, err);
        return null;
    }
}
