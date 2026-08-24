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
import { loadMemoryConfig } from "./memory-storage";
import { retrieveMemoriesForPrompt } from "./memory-service";
import { buildCharacterTimeContext } from "./character-time";
import type { ContentAppId } from "./settings-types";

/**
 * 当前时刻描述：`2026年8月24日21:00，星期一（晚上）`。
 * 用角色本地时区；异常时静默降级为空串（不影响生成）。
 */
function describeCurrentMoment(timeZone?: string | null, now = new Date()): string {
    try {
        const hour = Number(
            new Intl.DateTimeFormat("en-US", {
                timeZone: timeZone || undefined,
                hour: "2-digit",
                hourCycle: "h23",
            }).formatToParts(now).find(p => p.type === "hour")?.value ?? now.getHours(),
        );
        let period = "晚上";
        if (hour >= 0 && hour < 5) period = "深夜";
        else if (hour < 8) period = "清晨";
        else if (hour < 11) period = "上午";
        else if (hour < 14) period = "中午";
        else if (hour < 18) period = "下午";
        else if (hour < 20) period = "傍晚";
        const ctx = buildCharacterTimeContext(timeZone, now);
        return `${ctx.timeContext}（${period}）`;
    } catch {
        return "";
    }
}

export type ProactiveEventType =
    | "group_dissolved"
    | "friend_deleted"
    | "friend_rejected"
    | "memory_care"
    | "generic";

export type TriggerProactiveDMOptions = {
    event?: ProactiveEventType;
    context?: string;
    /** memory_care：检索到的记忆摘要，让角色"想起"过往 */
    memoryContext?: string;
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
    memoryContext?: string,
    timeContextText?: string,
): string {
    const ctx = context ? `（背景：${context}）` : "";
    const timePart = timeContextText && timeContextText.trim()
        ? `\n现在是${timeContextText.trim()}。`
        : "";
    switch (event) {
        case "group_dissolved":
            return `【剧情提示·仅你可见，不要念出】你所在的一个群聊刚刚被解散了。${ctx}现在由你主动给${userName}发一条私聊，以${charName}的身份自然地聊起这件事、或顺着你们的关系说点什么。直接输出你要说的话，不要输出任何协议标签（如[内心]、[状态栏]）。`;
        case "friend_deleted":
            return `【剧情提示·仅你可见】${userName}刚刚把你从好友里删除了。${ctx}现在由你主动重新给${userName}发一条私聊，以${charName}的身份自然地表达你的反应或想说的话。直接输出你要说的话，不要输出协议标签。`;
        case "friend_rejected":
            return `【剧情提示·仅你可见】${userName}刚刚拒绝了你的好友申请。${ctx}现在由你主动给${userName}发一条私聊，以${charName}的身份自然地回应。直接输出你要说的话，不要输出协议标签。`;
        case "memory_care": {
            const memoryPart = memoryContext && memoryContext.trim()
                ? `\n你想起了一些你们之间的过往：\n${memoryContext.trim()}\n`
                : "";
            return `【剧情提示·仅你可见，不要念出】${timePart}你刚刚想起了和${userName}之间的共同经历。${memoryPart}${ctx}现在由你主动给${userName}发一条私聊，以${charName}的身份自然地提起其中一件你们一起经历过的、值得怀念或关心的事。注意要贴合当下的时间与情境：只提现在这个时间点说依然自然、合适的话题；如果记忆里的往事与当前时段明显不搭（例如深夜时分不宜提早上上学、早餐、晨跑这类事），就换一件更合适的事，或换个贴合当下的关心角度（比如问问今天过得怎么样、有没有好好吃饭、早点休息）。语气要像真的想起老朋友一样自然、有温度，不要机械复述记忆原文。直接输出你要说的话，不要输出任何协议标签（如[内心]、[状态栏]）。`;
        }
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
        case "memory_care":
            return `突然想起你，最近还好吗？`;
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
        const hint = buildProactiveHint(event, char.name, userName, opts.context, opts.memoryContext, describeCurrentMoment(char.timeZone));
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

/**
 * 记忆唤起主动关心：检索该角色的长期记忆（共同经历/重要事件/关系），
 * 若有可提起的过往则触发主动私聊，让角色"想起"这些记忆并自然提起。
 * 无记忆可提时静默返回 null，不打扰用户。
 */
export async function triggerMemoryCareDM(
    characterId: string,
    opts: { appId?: ContentAppId } = {},
): Promise<string | null> {
    try {
        if (typeof window === "undefined") return null;
        const chars = loadCharacters();
        const char = chars.find(c => c.id === characterId);
        if (!char) return null;

        // 检索长期记忆（共同经历/重要事件/彼此关系），取最相关的几条
        const config = loadMemoryConfig();
        const memories = await retrieveMemoriesForPrompt(
            characterId,
            `和${char.name}之间的共同经历、重要事件、彼此的关系与了解`,
            config,
        );
        const memoryLines = memories
            .slice(0, 3)
            .map(m => m.content.trim())
            .filter(Boolean);
        if (memoryLines.length === 0) {
            console.log(`[MemoryCare] 角色 ${characterId} 暂无长期记忆，跳过主动关心`);
            return null;
        }

        return triggerProactiveDM(characterId, {
            event: "memory_care",
            memoryContext: memoryLines.join("\n"),
            appId: opts.appId ?? "chat",
        });
    } catch (err) {
        console.warn(`[MemoryCare] 角色 ${characterId} 记忆唤起失败：`, err);
        return null;
    }
}
