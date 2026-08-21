// lib/group-admin.ts
// Group admin roles: owner / admin / member, mute state, permission checks,
// action application and the {{groupRoster}} prompt macro.
// Member keys: "self" = the user, otherwise characterId.

import { ChatSession, GroupTodo, loadChatSessions, saveChatSessions, createGroupSession, pushChatMessage, bumpSessionUnread } from "./chat-storage";
import { loadCharacters } from "./character-storage";

export const GROUP_SELF_KEY = "self";

// 防止同一群解散重复触发角色主动私聊（applyGroupAdminAction 单次调用即生效，此为额外保险）
const _dissolvedProactiveFired = new Set<string>();

export type GroupAdminAction =
    | "transfer_owner"
    | "set_admin"
    | "unset_admin"
    | "kick"
    | "invite"
    | "mute"
    | "unmute"
    | "dissolve"
    | "create_group"
    | "rename"
    | "set_announcement"
    | "add_todo"
    | "complete_todo"
    | "remove_todo"
    | "leave_group";

export type GroupRole = "owner" | "admin" | "member";

// ── Roles ──────────────────────────────────────────────

export function getGroupOwnerKey(session: ChatSession): string {
    if (session.groupOwnerId) return session.groupOwnerId;
    // Legacy groups (created before roles existed): the user is the owner.
    // Spectator groups without an explicit owner: first member owns the group.
    if (session.isSpectator) return session.participantIds?.[0] || GROUP_SELF_KEY;
    return GROUP_SELF_KEY;
}

export function getGroupRole(session: ChatSession, key: string): GroupRole {
    if (getGroupOwnerKey(session) === key) return "owner";
    if ((session.groupAdminIds || []).includes(key)) return "admin";
    return "member";
}

/** Is this key currently part of the group? ("self" counts unless spectator) */
export function isGroupMemberKey(session: ChatSession, key: string): boolean {
    if (key === GROUP_SELF_KEY) return !session.isSpectator;
    return (session.participantIds || []).includes(key);
}

// ── Mute state ─────────────────────────────────────────

export function getGroupMuteRemainingMs(session: ChatSession, key: string, now?: number): number {
    const until = session.groupMutes?.[key];
    if (!until) return 0;
    const ms = new Date(until).getTime() - (now ?? Date.now());
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function isGroupMuted(session: ChatSession, key: string, now?: number): boolean {
    return getGroupMuteRemainingMs(session, key, now) > 0;
}

export function formatMuteDurationLabel(minutes: number): string {
    if (minutes % 1440 === 0 && minutes >= 1440) return `${minutes / 1440}天`;
    if (minutes % 60 === 0 && minutes >= 60) return `${minutes / 60}小时`;
    return `${minutes}分钟`;
}

export function formatMuteRemainingLabel(ms: number): string {
    const totalMinutes = Math.ceil(ms / 60000);
    if (totalMinutes >= 1440) return `${Math.ceil(totalMinutes / 1440)}天`;
    if (totalMinutes >= 60) return `${Math.ceil(totalMinutes / 60)}小时`;
    return `${Math.max(totalMinutes, 1)}分钟`;
}

// ── Permission matrix ──────────────────────────────────

/**
 * Whether `actorKey` may perform `action` on `targetKey`.
 * Rules mirror WeChat: owner may do everything; admins may kick/invite/mute
 * plain members only; nobody targets the owner; admins don't target admins.
 * Characters may not target the user unless the session opts in.
 */
export function canGroupAdminAct(
    session: ChatSession,
    actorKey: string,
    action: GroupAdminAction,
    targetKey: string,
): boolean {
    if (!actorKey || !targetKey) return false;
    if (!isGroupMemberKey(session, actorKey)) return false;
    // 自主退群：任何成员（含群主）都可主动退出，执行人即目标；群主退群后群主身份自动顺延
    if (action === "leave_group") {
        return actorKey === targetKey;
    }
    const actorRole = getGroupRole(session, actorKey);
    if (actorRole === "member") return false;
    // 解散群不针对某个成员，仅群主可执行
    if (action === "dissolve") return actorRole === "owner";
    // 改群名不针对某个成员（对群本身操作），群主/管理员均可，且 actor 即执行人
    if (action === "rename") return actorRole === "owner" || actorRole === "admin";
    // 群公告 / 群待办：群主/管理员均可操作，actor 即执行人
    if (action === "set_announcement" || action === "add_todo" || action === "complete_todo" || action === "remove_todo") {
        return actorRole === "owner" || actorRole === "admin";
    }
    if (actorKey === targetKey && action !== "unmute") return false;

    // Characters targeting the user: kicking is never allowed (the session
    // can't lose its user), muting requires the opt-in switch; handing the
    // user ownership/admin is harmless and follows the normal matrix.
    if (targetKey === GROUP_SELF_KEY && actorKey !== GROUP_SELF_KEY) {
        if (action === "kick") return false;
        if (action === "mute" && session.allowAdminActionsOnUser !== true) return false;
    }

    switch (action) {
        case "transfer_owner":
        case "set_admin":
        case "unset_admin": {
            if (actorRole !== "owner") return false;
            if (!isGroupMemberKey(session, targetKey)) return false;
            const targetRole = getGroupRole(session, targetKey);
            if (action === "set_admin") return targetRole === "member";
            if (action === "unset_admin") return targetRole === "admin";
            return true; // transfer_owner: any member/admin target
        }
        case "kick":
        case "mute": {
            if (!isGroupMemberKey(session, targetKey)) return false;
            const targetRole = getGroupRole(session, targetKey);
            if (targetRole === "owner") return false;
            if (actorRole === "admin" && targetRole === "admin") return false;
            if (action === "mute" && isGroupMuted(session, targetKey)) return false;
            return true;
        }
        case "unmute": {
            if (!isGroupMuted(session, targetKey)) return false;
            const targetRole = getGroupRole(session, targetKey);
            if (actorRole === "admin" && targetRole === "admin" && actorKey !== targetKey) return false;
            return true;
        }
        case "invite": {
            // Target must be an existing character not already in the group
            if (targetKey === GROUP_SELF_KEY) return false;
            if ((session.participantIds || []).includes(targetKey)) return false;
            return true;
        }
        default:
            return false;
    }
}

// ── Name resolution ────────────────────────────────────

/** Resolve a display name from AI output to a member key. Returns null if unknown. */
export function resolveGroupMemberKeyByName(
    session: ChatSession,
    name: string,
    userName: string,
    options?: { includeOutsiders?: boolean },
): string | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (trimmed === userName || trimmed === "你") return GROUP_SELF_KEY;
    const chars = loadCharacters();
    const inGroup = (session.participantIds || [])
        .map(id => chars.find(c => c.id === id))
        .find(c => c && c.name === trimmed);
    if (inGroup) return inGroup.id;
    if (options?.includeOutsiders) {
        const outsider = chars.find(c => c.name === trimmed);
        if (outsider) return outsider.id;
    }
    return null;
}

export function getGroupMemberDisplayName(key: string, userName: string): string {
    if (key === GROUP_SELF_KEY) return userName;
    const char = loadCharacters().find(c => c.id === key);
    return char?.name || "未知";
}

// ── Notice text (third person; the UI converts the user's name to 你) ──

export function buildGroupAdminNoticeText(
    action: GroupAdminAction,
    actorName: string,
    targetName: string,
    muteMinutes?: number,
): string {
    switch (action) {
        case "transfer_owner":
            if (actorName === targetName) return `${actorName}收回了群主身份`;
            return `${actorName}将群主转让给了${targetName}`;
        case "set_admin": return `${actorName}将${targetName}设为了管理员`;
        case "unset_admin": return `${actorName}取消了${targetName}的管理员`;
        case "kick": return `${actorName}将${targetName}移出了群聊`;
        case "invite": return `${actorName}邀请${targetName}加入了群聊`;
        case "mute": return `${actorName}将${targetName}禁言${formatMuteDurationLabel(muteMinutes || 10)}`;
        case "unmute": return `${actorName}解除了${targetName}的禁言`;
        case "dissolve": return `${actorName}解散了群聊`;
        case "create_group": return `${actorName}创建了群聊`;
        case "rename": return `${actorName}将群名改为了「${targetName}」`;
        case "set_announcement": return `${actorName}设置了群公告：${targetName}`;
        case "add_todo": return `${actorName}添加了群待办：${targetName}`;
        case "complete_todo": return `${actorName}完成了群待办：${targetName}`;
        case "remove_todo": return `${actorName}删除了群待办：${targetName}`;
        case "leave_group": return `${actorName}退出了群聊`;
    }
}

/**
 * Canonical protocol tag for prompt history — same bracket format the AI is
 * taught to output, so user actions and AI actions read identically in context
 * (mirrors how [A领取了B的红包] / call tags replay through history).
 */
export function buildGroupAdminBracketText(
    action: GroupAdminAction,
    actorName: string,
    targetName: string,
    muteMinutes?: number,
): string {
    switch (action) {
        case "transfer_owner":
            // 上帝按钮收回群主：非协议动作，写成事实陈述即可
            if (actorName === targetName) return `[${actorName}收回了群主身份]`;
            return `[${actorName}将群主转让给了${targetName}]`;
        case "set_admin": return `[${actorName}将${targetName}设为了管理员]`;
        case "unset_admin": return `[${actorName}取消了${targetName}的管理员]`;
        case "kick": return `[${actorName}将${targetName}移出了群聊]`;
        case "invite": return `[${actorName}邀请${targetName}加入了群聊]`;
        case "mute": return `[${actorName}禁言了${targetName}:${formatMuteDurationLabel(muteMinutes || 10)}]`;
        case "unmute": return `[${actorName}解除了${targetName}的禁言]`;
        case "dissolve": return `[${actorName}解散了群聊]`;
        case "create_group": return `[${actorName}创建了群聊]`;
        case "rename": return `[${actorName}将群名改为了「${targetName}」]`;
        case "set_announcement": return `[${actorName}设置了群公告：${targetName}]`;
        case "add_todo": return `[${actorName}添加了群待办：${targetName}]`;
        case "complete_todo": return `[${actorName}完成了群待办：${targetName}]`;
        case "remove_todo": return `[${actorName}删除了群待办：${targetName}]`;
        case "leave_group": return `[${actorName}退出了群聊]`;
    }
}

// ── Action application ─────────────────────────────────

/**
 * Apply a permitted admin action to the persisted session.
 * Does NOT check permission — call canGroupAdminAct first.
 * Returns the updated fields (also merged into the passed session object).
 */
export function applyGroupAdminAction(
    session: ChatSession,
    action: GroupAdminAction,
    actorKey: string,
    targetKey: string,
    muteMinutes?: number,
    newGroupName?: string,
    newAnnouncement?: string,
    todoText?: string,
): Partial<ChatSession> {
    const updates: Partial<ChatSession> = {};
    switch (action) {
        case "transfer_owner": {
            updates.groupOwnerId = targetKey;
            // New owner leaves the admin list; ex-owner becomes a plain member
            updates.groupAdminIds = (session.groupAdminIds || []).filter(id => id !== targetKey);
            break;
        }
        case "set_admin": {
            const admins = new Set(session.groupAdminIds || []);
            admins.add(targetKey);
            updates.groupAdminIds = [...admins];
            break;
        }
        case "unset_admin": {
            updates.groupAdminIds = (session.groupAdminIds || []).filter(id => id !== targetKey);
            break;
        }
        case "kick": {
            if (targetKey !== GROUP_SELF_KEY) {
                updates.participantIds = (session.participantIds || []).filter(id => id !== targetKey);
            }
            updates.groupAdminIds = (session.groupAdminIds || []).filter(id => id !== targetKey);
            if (session.groupMutes?.[targetKey]) {
                const mutes = { ...session.groupMutes };
                delete mutes[targetKey];
                updates.groupMutes = mutes;
            }
            break;
        }
        case "invite": {
            const ids = session.participantIds || [];
            if (!ids.includes(targetKey)) updates.participantIds = [...ids, targetKey];
            break;
        }
        case "leave_group": {
            // 成员自主退群：从群成员/管理员/禁言名单中移除自己
            const leavingKey = targetKey;
            if (leavingKey !== GROUP_SELF_KEY) {
                updates.participantIds = (session.participantIds || []).filter(id => id !== leavingKey);
            }
            updates.groupAdminIds = (session.groupAdminIds || []).filter(id => id !== leavingKey);
            if (session.groupMutes?.[leavingKey]) {
                const mutes = { ...session.groupMutes };
                delete mutes[leavingKey];
                updates.groupMutes = mutes;
            }
            // 群主退群：群主位置自动顺延给剩余第一名成员（新群主移出管理员名单）
            if (getGroupOwnerKey(session) === leavingKey) {
                const remaining = (updates.participantIds ?? session.participantIds ?? []).filter(id => id !== leavingKey);
                if (remaining.length > 0) {
                    updates.groupOwnerId = remaining[0];
                    updates.groupAdminIds = (updates.groupAdminIds ?? session.groupAdminIds ?? []).filter(id => id !== remaining[0]);
                } else {
                    updates.groupOwnerId = "";
                }
            }
            break;
        }
        case "mute": {
            const until = new Date(Date.now() + (muteMinutes || 10) * 60000).toISOString();
            updates.groupMutes = { ...(session.groupMutes || {}), [targetKey]: until };
            break;
        }
        case "unmute": {
            const mutes = { ...(session.groupMutes || {}) };
            delete mutes[targetKey];
            updates.groupMutes = mutes;
            break;
        }
        case "dissolve": {
            updates.dissolved = true;
            break;
        }
        case "rename": {
            const name = (newGroupName || "").trim();
            if (name) updates.groupName = name;
            break;
        }
        case "set_announcement": {
            updates.groupAnnouncement = (newAnnouncement || "").trim();
            break;
        }
        case "add_todo": {
            const text = (todoText || "").trim();
            if (text) {
                const todo: GroupTodo = {
                    id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    text,
                    done: false,
                    createdBy: actorKey,
                    createdAt: new Date().toISOString(),
                };
                updates.groupTodos = [...(session.groupTodos || []), todo];
            }
            break;
        }
        case "complete_todo": {
            const text = (todoText || "").trim().toLowerCase();
            if (text) {
                updates.groupTodos = (session.groupTodos || []).map(t =>
                    t.text.trim().toLowerCase() === text ? { ...t, done: true } : t,
                );
            }
            break;
        }
        case "remove_todo": {
            const text = (todoText || "").trim().toLowerCase();
            if (text) {
                updates.groupTodos = (session.groupTodos || []).filter(
                    t => t.text.trim().toLowerCase() !== text,
                );
            }
            break;
        }
    }

    if (action === "dissolve") {
        // 解散是剧情节点：广播事件供角色社交引擎消费（如群里其他角色私聊用户讨论此事）。
        // 群聊历史全部保留，仅标记 dissolved，不调用 deleteChatSession。
        const ownerKey = getGroupOwnerKey(session);
        const remainingMemberKeys = (session.participantIds || []).filter(id => id !== ownerKey);
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("group-dissolved", {
                detail: { sessionId: session.id, ownerKey, remainingMemberKeys },
            }));
            // 角色自主社交：让群里剩余的第一个角色在解散后主动向用户发私聊。
            // 动态 import 以避免与 chat-engine 形成静态循环依赖；同一解散仅触发一次。
            if (remainingMemberKeys.length > 0) {
                const targetKey = remainingMemberKeys[0];
                if (!_dissolvedProactiveFired.has(session.id)) {
                    _dissolvedProactiveFired.add(session.id);
                    void import("./character-proactive-chat")
                        .then(mod => mod.triggerProactiveDM(targetKey, {
                            event: "group_dissolved",
                            context: `群「${session.groupName || "未命名群"}」被${getGroupMemberDisplayName(ownerKey, "你")}解散了`,
                        }))
                        .catch(err => console.warn("[GroupAdmin] 解散后主动私聊触发失败：", err));
                }
            }
        }
    }

    const sessions = loadChatSessions();
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx !== -1) {
        sessions[idx] = { ...sessions[idx], ...updates };
        saveChatSessions(sessions);
    }
    Object.assign(session, updates);
    return updates;
}

// ── 角色自主建群（消费 [X建了一个群 | 群名: ... | 成员: ...] 标签） ──

export interface CreateGroupResult {
    sessionId: string;
    groupName: string;
}

// 防止同一标签在一次生成里被分块/双路径重复触发建多个群
const _createGroupFired = new Set<string>();

/**
 * 角色主动创建一个新群并把用户拉进去。
 * - 发起角色成为群主（groupOwnerId = actorCharacterId）
 * - 用户在群内（被拉入）
 * - 标签里点名的其他角色也加入
 * 返回新群会话信息；标签非法或重复触发时返回 null。
 */
export function applyAIProactiveGroupCreate(
    actorCharacterId: string,
    data: { adminActorName?: string; groupName?: string; memberNames?: string },
): CreateGroupResult | null {
    if (!actorCharacterId || actorCharacterId === GROUP_SELF_KEY) return null;
    const chars = loadCharacters();
    const actorChar = chars.find(c => c.id === actorCharacterId);
    const actorName = (data.adminActorName || "").trim() || actorChar?.name || "有人";
    const groupName = (data.groupName || "").trim() || `${actorName}的群聊`;

    // 解析成员名 → 角色 ID（"你"/"我"/"用户" 跳过，用户单独加入）
    const memberIds: string[] = [];
    const rawNames = (data.memberNames || "")
        .split(/[,，、]/)
        .map(s => s.trim())
        .filter(Boolean);
    for (const nm of rawNames) {
        if (nm === "你" || nm === "我" || nm === "用户") continue;
        const char = chars.find(c => c.name === nm);
        if (char && !memberIds.includes(char.id)) memberIds.push(char.id);
    }

    // 去重：同一（发起者 + 群名 + 成员）在一次生成内不重复建群
    const dedupeKey = `${actorCharacterId}|${groupName}|${memberIds.join(",")}`;
    if (_createGroupFired.has(dedupeKey)) return null;

    const participantIds = [actorCharacterId, ...memberIds, GROUP_SELF_KEY];
    const newSession = createGroupSession(groupName, participantIds, {
        isSpectator: false,
        ownerId: actorCharacterId,
    });

    // 系统提示：谁创建了群、把你拉了进去
    pushChatMessage({
        sessionId: newSession.id,
        role: "system",
        content: `${actorName} 创建了群聊「${groupName}」并把你拉了进来`,
    });

    // 会话列表刷新 + 新群红点
    bumpSessionUnread(newSession.id);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: newSession.id } }));
        window.dispatchEvent(new CustomEvent("weixin-messages-updated", { detail: { sessionId: newSession.id } }));
    }

    _createGroupFired.add(dedupeKey);
    // 短延时清理去重键，避免后续剧情真要建同名群被永久挡住
    setTimeout(() => _createGroupFired.delete(dedupeKey), 60000);

    return { sessionId: newSession.id, groupName };
}

/** Drop expired mute entries from storage (passive expiry). */
export function pruneExpiredGroupMutes(session: ChatSession): void {
    const mutes = session.groupMutes;
    if (!mutes) return;
    const now = Date.now();
    const active: Record<string, string> = {};
    let changed = false;
    for (const [key, until] of Object.entries(mutes)) {
        const ms = new Date(until).getTime() - now;
        if (Number.isFinite(ms) && ms > 0) active[key] = until;
        else changed = true;
    }
    if (!changed) return;
    const sessions = loadChatSessions();
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx !== -1) {
        sessions[idx] = { ...sessions[idx], groupMutes: active };
        saveChatSessions(sessions);
    }
    session.groupMutes = active;
}

// ── {{groupRoster}} macro ──────────────────────────────

/**
 * Build the roster block injected via the {{groupRoster}} preset macro.
 * Pure data: who owns the group, who administrates, who is muted.
 */
export function buildGroupRosterMacro(
    session: ChatSession,
    memberNames: { id: string; name: string }[],
    userName: string,
): string {
    pruneExpiredGroupMutes(session);
    const nameOf = (key: string): string => {
        if (key === GROUP_SELF_KEY) return `${userName}（用户本人）`;
        return memberNames.find(m => m.id === key)?.name || "未知";
    };
    const ownerKey = getGroupOwnerKey(session);
    const adminKeys = (session.groupAdminIds || []).filter(key => key !== ownerKey && isGroupMemberKey(session, key));
    const allKeys: string[] = [
        ...(session.isSpectator ? [] : [GROUP_SELF_KEY]),
        ...memberNames.map(m => m.id),
    ];
    const plainKeys = allKeys.filter(key => key !== ownerKey && !adminKeys.includes(key));

    const lines: string[] = ["<group_roster>"];
    lines.push(`群主：${nameOf(ownerKey)}`);
    if (adminKeys.length > 0) lines.push(`管理员：${adminKeys.map(nameOf).join("、")}`);
    if (plainKeys.length > 0) lines.push(`普通成员：${plainKeys.map(nameOf).join("、")}`);
    const mutedEntries = Object.keys(session.groupMutes || {})
        .filter(key => isGroupMemberKey(session, key))
        .map(key => {
            const ms = getGroupMuteRemainingMs(session, key);
            return ms > 0 ? `${nameOf(key)}（剩余${formatMuteRemainingLabel(ms)}）` : "";
        })
        .filter(Boolean);
    if (mutedEntries.length > 0) {
        lines.push(`禁言中：${mutedEntries.join("、")}（被禁言者在解除前不得发出任何群消息，线下场景不受影响）`);
    }
    lines.push("</group_roster>");
    return lines.join("\n");
}
