import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const TIMED_WAKE_SCHEDULES_KEY = "ai_phone_timed_wake_schedules_v1";

registerKvMigration(TIMED_WAKE_SCHEDULES_KEY);

export type TimedWakeSchedule = {
    id: string;
    sessionId: string;
    characterId: string;
    fireAt: number;
    createdAt: number;
    delayMinutes: number;
    intent: string;
    /** 创建来源：tool=角色自己约的（"你当时想着"视角）/ user=用户预约（"TA拜托你"视角）。缺省按 tool。 */
    source?: "tool" | "user";
};

export function makeTimedWakeId(sessionId: string): string {
    return `timed_wake_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadTimedWakeSchedules(): TimedWakeSchedule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(TIMED_WAKE_SCHEDULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isTimedWakeSchedule);
    } catch {
        return [];
    }
}

function saveTimedWakeSchedules(schedules: TimedWakeSchedule[]): void {
    if (typeof window === "undefined") return;
    kvSet(TIMED_WAKE_SCHEDULES_KEY, JSON.stringify(schedules));
}

export function saveTimedWakeSchedule(schedule: TimedWakeSchedule): void {
    const all = loadTimedWakeSchedules();
    const next = all.filter(item => item.sessionId !== schedule.sessionId);
    next.push(schedule);
    saveTimedWakeSchedules(next);
}

export function clearTimedWakeSchedule(sessionId: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.sessionId !== sessionId));
}

export function removeTimedWakeSchedule(id: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.id !== id));
}

/**
 * 角色自主续期护栏：角色可以自己约「稍后主动联系」，到点发完还能再约一次，
 * 若对方一直没回应就会变成无限自我续期（隔几分钟一条私聊）。
 * 这里限定「对方没回的情况下最多再主动找 TIMED_WAKE_MAX_CONSECUTIVE 次」，
 * 对方一回复计数立刻清零，不影响正常互动。用户自己创建的定时消息不受此限。
 */
export const TIMED_WAKE_MAX_CONSECUTIVE = 2;

const TIMED_WAKE_CONSEC_PREFIX = "ai_phone_tw_consec_";
const TIMED_WAKE_LAST_FIRE_PREFIX = "ai_phone_tw_last_fire_";

export function getTimedWakeConsecutive(sessionId: string): number {
    if (typeof window === "undefined") return 0;
    return Number(localStorage.getItem(TIMED_WAKE_CONSEC_PREFIX + sessionId) || "0") || 0;
}

export function getTimedWakeLastFireAt(sessionId: string): number {
    if (typeof window === "undefined") return 0;
    return Number(localStorage.getItem(TIMED_WAKE_LAST_FIRE_PREFIX + sessionId) || "0") || 0;
}

/** 到点发过一次后调用：对方在唤醒后仍没回 → 计数 +1；回过 → 清零。返回当前连发数。 */
export function markTimedWakeFired(sessionId: string, lastUserMessageAt: number): number {
    if (typeof window === "undefined") return 0;
    const answered = lastUserMessageAt > getTimedWakeLastFireAt(sessionId);
    const next = answered ? 0 : getTimedWakeConsecutive(sessionId) + 1;
    localStorage.setItem(TIMED_WAKE_CONSEC_PREFIX + sessionId, String(next));
    localStorage.setItem(TIMED_WAKE_LAST_FIRE_PREFIX + sessionId, String(Date.now()));
    return next;
}

/** 角色想再约一次时调用：对方已回则清零并允许；否则看是否还在连发上限内。 */
export function evaluateTimedWakeQuota(sessionId: string, lastUserMessageAt: number): boolean {
    if (typeof window === "undefined") return true;
    if (lastUserMessageAt > getTimedWakeLastFireAt(sessionId)) {
        localStorage.setItem(TIMED_WAKE_CONSEC_PREFIX + sessionId, "0");
        return true;
    }
    return getTimedWakeConsecutive(sessionId) < TIMED_WAKE_MAX_CONSECUTIVE;
}

function isTimedWakeSchedule(value: unknown): value is TimedWakeSchedule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<TimedWakeSchedule>;
    return typeof item.id === "string"
        && typeof item.sessionId === "string"
        && typeof item.characterId === "string"
        && typeof item.fireAt === "number"
        && typeof item.createdAt === "number"
        && typeof item.delayMinutes === "number"
        && typeof item.intent === "string";
}
