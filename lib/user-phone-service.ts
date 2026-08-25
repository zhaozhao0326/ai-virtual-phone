// lib/user-phone-service.ts
// 用户「面具手机」关系网视图：让角色能查到与用户（当前面具）相关的社交数据。
//
// 角色视角看到的"用户手机"：
//   1. 用户当前使用的面具（昵称/简介）
//   2. 通讯录：用户给每个角色的备注（nickname）
//   3. 该角色与用户的最近对话
//   4. 用户与其他角色的对话（只给最近 1 条预览 + 存在提示，克制不越界）
//
// 数据全部来自小手机本地既有数据（面具/通讯录/聊天记录），无新增存储。

import { loadChatContacts, loadChatSessions, loadChatMessages } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadUserIdentities, resolveUserIdentity } from "./settings-storage";

const SELF_CHAT_PREVIEW = 8;      // 该角色与用户的最近消息条数
const OTHERS_CHAT_PREVIEW = 1;    // 用户与其他角色对话的预览条数（克制）

export function buildUserRelationshipView(characterId: string, characterName: string, appId?: string): string {
    const lines: string[] = [];
    const ctx = appId ?? "chat";
    const userName = resolveUserIdentity(characterId, ctx)?.name || "用户";

    // 1. 用户当前面具
    const identity = resolveUserIdentity(characterId, ctx);
    lines.push(`【用户「${userName}」的当前名片】`);
    if (identity?.bio) lines.push(`简介：${identity.bio}`);
    else lines.push("（无简介）");
    lines.push("");

    // 2. 通讯录：用户给各角色的备注
    const contacts = loadChatContacts();
    const chars = loadCharacters();
    const contactLines: string[] = [];
    for (const contact of contacts) {
        const char = chars.find(c => c.id === contact.characterId);
        const charName = char?.name || contact.characterId.slice(0, 8);
        const remark = contact.nickname?.trim();
        contactLines.push(remark && remark !== charName
            ? `${charName}（用户备注：${remark}）`
            : charName);
    }
    lines.push(`【用户的通讯录（共 ${contactLines.length} 位）】`);
    lines.push(contactLines.length ? contactLines.join("、") : "（空的）");
    lines.push("");

    // 3. 该角色与用户的最近对话
    const sessions = loadChatSessions();
    const selfSession = sessions.find(s => s.contactId === characterId && !s.isGroup);
    if (selfSession) {
        const messages = loadChatMessages(selfSession.id)
            .filter(m => m.role === "user" || m.role === "assistant")
            .slice(-SELF_CHAT_PREVIEW);
        lines.push(`【你和用户最近的对话（${messages.length} 条）】`);
        if (messages.length === 0) {
            lines.push("（还没有聊过天）");
        } else {
            for (const m of messages) {
                const who = m.role === "user" ? userName : characterName;
                const text = String(m.content || "").replace(/\s+/g, " ").slice(0, 60);
                lines.push(`${who}：${text}${text.length >= 60 ? "…" : ""}`);
            }
        }
    }
    lines.push("");

    // 4. 用户与其他角色的对话（存在提示 + 最近 1 条预览）
    const otherLines: string[] = [];
    for (const session of sessions) {
        if (session.isGroup || session.contactId === characterId) continue;
        const char = chars.find(c => c.id === session.contactId);
        const otherName = char?.name || session.contactId.slice(0, 8);
        const messages = loadChatMessages(session.id)
            .filter(m => m.role === "user" || m.role === "assistant");
        if (messages.length === 0) continue;
        const last = messages[messages.length - 1];
        const who = last.role === "user" ? userName : otherName;
        const text = String(last.content || "").replace(/\s+/g, " ").slice(0, 50);
        otherLines.push(`${otherName} 和用户聊过（最近：${who}：${text}${text.length >= 50 ? "…" : ""}）`);
    }
    lines.push(`【用户和其他角色的往来（${otherLines.length} 位）】`);
    lines.push(otherLines.length ? otherLines.join("\n") : "（没有其他往来）");

    return lines.join("\n");
}

export function countUserIdentities(): number {
    try {
        return loadUserIdentities().length;
    } catch {
        return 0;
    }
}
