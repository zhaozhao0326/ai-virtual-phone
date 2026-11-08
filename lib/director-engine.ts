// 导演对讲机引擎
// 用户与「导演」（AI 表演指导）的私密侧聊：导演能回看这段戏的演出记录，
// 回答用户关于角色演绎的疑问、调教表演，并在达成共识时沉淀「执导指令」，
// 该指令会被注入角色下一轮上下文，实现「沟通好后重新演绎新剧情」。

import { type ChatSession, type ChatMessage, type DirectorMessage, loadChatMessages } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadBindingConfig, resolveBinding, loadApiConfigs, resolveUserIdentity } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";

const DIRECTOR_MARKER = "【执导指令】";

export type DirectorReplyResult = {
    /** 导演对用户的答复（已剥离执导指令标记） */
    reply: string;
    /** 沉淀下来的执导指令（空串表示本轮未达成共识） */
    directive: string;
    error?: string;
};

/**
 * 调用导演模型，返回答复与（可能的）执导指令。
 * directorLog 必须已包含本轮用户消息（作为最后一条），history 为主聊天的可见消息。
 */
export async function generateDirectorReply(
    session: ChatSession,
    directorLog: DirectorMessage[],
    history?: ChatMessage[],
): Promise<DirectorReplyResult> {
    const character = loadCharacters().find(c => c.id === session.contactId);
    const charName = character?.name || "角色";

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, session.contactId, "chat");
    const config = loadApiConfigs().find(c => c.id === slot.apiConfigId);
    if (!config) {
        return { reply: "", directive: "", error: "该角色尚未绑定 API 配置，请先在设置里绑定模型。" };
    }

    const userIdentity = resolveUserIdentity(session.contactId, "chat");
    const userName = userIdentity?.name || "你";

    const chatHistory = history ?? loadChatMessages(session.id);
    const record = chatHistory
        .filter(m => !m.isRetracted && m.role !== "system" && m.mediaType !== "system_instruction")
        .slice(-30)
        .map(m => {
            const who = m.role === "user" ? userName : (m.senderName || charName);
            const text = (m.content ?? "").trim() || (m.mediaType ? `[${m.mediaType}]` : "");
            return `${who}：${text}`;
        })
        .join("\n");

    const systemPrompt = `你是角色「${charName}」这场戏的导演 / 表演指导，而用户（${userName}）是这场戏的玩家。你拥有这段戏的【演出记录】（如下）。

你的职责：
1. 当用户提问（例如"他为什么这么黏人""刚才那句语气不对""前面那段情绪太淡了"）或抱怨演绎不好时，先回看【演出记录】，结合具体台词指出问题所在，或直接回答用户。
2. 给出可操作的调整建议——角色下一轮该怎么演、语气 / 情绪 / 动作 / 关系距离该怎么调。
3. 当你们就"角色接下来该怎么演"达成共识、用户准备继续推进剧情时，在本轮回复的【最末尾】用单独一行输出：
${DIRECTOR_MARKER}<简洁、可直接用于角色下一轮演绎的指令，2–4 句，用中文，聚焦"行为 / 语气 / 情绪 / 距离"等表演层面>

注意：
- 如果用户只是提问或闲聊、尚未达成共识，不要输出${DIRECTOR_MARKER}标记。
- 你说话要像片场导演：简洁、具体、接地气，不要长篇大论，用中文。
- 你面对的是玩家本人，不是角色；不要以角色口吻说话。`;

    const messages: { role: string; content: string }[] = [
        { role: "system", content: systemPrompt },
        {
            role: "system",
            content: `【演出记录】（角色「${charName}」与${userName}的最近对话，供你回看）\n${record || "（暂无记录）"}`,
        },
    ];
    for (const m of directorLog) {
        messages.push({ role: m.role, content: m.content });
    }

    const res = await simpleLLMCall(config, messages, {
        temperature: 0.6,
        max_tokens: 1200,
        disableThinking: true,
        purpose: "director",
        characterName: charName,
    });

    if (res.error || !res.content) {
        return { reply: "", directive: "", error: res.error || "导演暂时没有回应。" };
    }

    const { reply, directive } = parseDirective(res.content);
    return { reply, directive };
}

/** 从导演回复中剥离【执导指令】标记，拆出答复正文与执导指令。 */
export function parseDirective(text: string): { reply: string; directive: string } {
    const idx = text.indexOf(DIRECTOR_MARKER);
    if (idx < 0) return { reply: text.trim(), directive: "" };
    const reply = text.slice(0, idx).trim();
    const directive = text.slice(idx + DIRECTOR_MARKER.length).trim();
    return { reply, directive };
}
