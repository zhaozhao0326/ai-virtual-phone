// lib/schedule-cleanup.ts
// 删除角色时的排期大扫除：本地排期 + 服务端预约一次性全部清掉。
// 背景（真实事故）：用户删掉角色卡、关掉预设里的主动消息后，角色仍在自动发私聊。
// 根因：删除角色只从角色数组移除，既不清理 1:1 会话，也不清理已排期的
//   定时唤醒 / 冷场重连 / 追问链，更不取消已预约到服务端的离线任务——
//   服务端任务到点执行时不检查角色是否还存在，冷场重连链还会自动续排。
// 本函数在角色销毁入口（phone-character-app 销毁确认）调用，根治该问题。
import { loadTimedWakeSchedules, removeTimedWakeSchedule } from "./timed-wake-storage";
import { loadIdleReconnectRules, removeIdleReconnectRule } from "./idle-reconnect-storage";
import { loadChatSessions, loadAllFollowUpSchedules, clearFollowUpSchedule, deleteChatSession } from "./chat-storage";
import { cancelBailoutKey, cancelBailoutPrefix, cancelFollowUpBailout } from "./push-bailout-client";

/** 角色销毁时调用：清掉该角色名下所有 1:1 会话及其排期（本地 + 服务端预约）。
 *  群聊不删（群是共享容器，删除角色后群内发言候选经白名单过滤自然失效）。 */
export function purgeCharacterRelatedData(characterId: string): void {
    const sessions = loadChatSessions().filter(s => !s.isGroup && s.contactId === characterId);
    const sessionIds = new Set(sessions.map(s => s.id));

    // ① 稍后主动联系：本地排期 + 服务端一次性任务
    for (const sched of loadTimedWakeSchedules().filter(s => s.characterId === characterId)) {
        removeTimedWakeSchedule(sched.id);
        void cancelBailoutKey(`timedwake:${sched.id}`);
    }

    // ② 冷场重连：本地规则 + 服务端续排链（服务端生成完会自动续下一轮，必须显式取消）
    for (const rule of loadIdleReconnectRules().filter(r => r.characterId === characterId)) {
        removeIdleReconnectRule(rule.id);
        void cancelBailoutPrefix(`idle:${rule.id}:`);
    }

    // ③ 追问链（follow-up）：本地 + 服务端
    for (const sched of loadAllFollowUpSchedules().filter(s => sessionIds.has(s.sessionId))) {
        clearFollowUpSchedule(sched.sessionId);
        cancelFollowUpBailout(sched.sessionId);
    }

    // ④ 删除 1:1 会话本身（含消息）：本地任何触发路径（fireTimedWake / fireIdleReconnect）
    //    按 session 查不到即 return，双重保险。
    for (const s of sessions) deleteChatSession(s.id);
}
