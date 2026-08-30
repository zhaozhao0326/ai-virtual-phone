/**
 * Background follow-up service.
 * Runs independently of any React component — fires follow-ups
 * even when the user is not inside the chat room.
 * Messages are saved to storage; UI is notified via CustomEvent.
 */

import {
    loadChatSessions,
    loadChatMessages,
    pushChatMessage,
    loadAllFollowUpSchedules,
    saveFollowUpSchedule,
    clearFollowUpSchedule,
    updateMessageMediaStatus,
    updateMessageMediaData,
    createResponseBatchId,
    getLatestCharacterStateValues,
} from "./chat-storage";
import type { ChatMessage, StateValue } from "./chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "./chat-engine";
import { armFollowUpBailout, armIdleReconnectBailout, cancelBailoutKey, cancelBailoutPrefix, cancelFollowUpBailout, startBailoutHeartbeat } from "./push-bailout-client";
import { isWithinPushQuietHours } from "./push-client";
import {
    IDLE_RECONNECT_MAX_CONSECUTIVE,
    loadIdleReconnectRules,
    markIdleReconnectFired,
    resetIdleReconnectForSession,
    suppressIdleReconnectUntil,
    type IdleReconnectRule,
} from "./idle-reconnect-storage";
import {
    GROUP_WARMUP_EXCHANGE_MAX_LINES,
    GROUP_WARMUP_MAX_CONSECUTIVE,
    loadGroupWarmupEnabled,
    loadGroupWarmupRules,
    markGroupWarmupFired,
    suppressGroupWarmupUntil,
    resetGroupWarmupForSession,
} from "./group-warmup-storage";
import {
    getFollowUpCharOverride,
    getFollowUpGraceUntil,
    getGlobalFollowUpGraceUntil,
    loadFollowUpConfig,
    setFollowUpCharOverride,
    recordFollowUpGrace,
    clearFollowUpGrace,
} from "./settings-storage";
import { parseAIResponse } from "./rich-message-parser";
import type { ParsedMessagePart } from "./rich-message-parser";
import { isKnownStickerLabel } from "./sticker-data";
import { loadCharacters } from "./character-storage";
import { bgSetInterval, bgSetTimeout } from "./bg-timer";
import { dispatchChatMessageNotice } from "./chat-notification-events";
import { settleShoppingPaymentRequest } from "./shopping-payment-request";
import {
    createPendingChatGeneratedImageData,
    generateAndApplyChatGeneratedImage,
    isPendingChatGeneratedImageMessage,
} from "./generated-image-retry";
import {
    loadTimedWakeSchedules,
    markTimedWakeFired,
    removeTimedWakeSchedule,
    type TimedWakeSchedule,
} from "./timed-wake-storage";
import { triggerMemoryCareDM } from "./character-proactive-chat";
import { maybeRunCharacterInternalLife, isDreamEnabled } from "./dream-service";
import {
    getMenstrualPeriodCareEvent,
    hasMenstrualPeriodCareTriggered,
    loadMenstrualConfig,
    loadMenstrualRecords,
    saveMenstrualPeriodCareTrigger,
    type MenstrualPeriodCareEvent,
} from "./menstrual-storage";

// ── Constants ──────────────────────────────────────────────
export const MAX_FOLLOW_UPS = 3;
const POLL_INTERVAL_MS = 3000; // check every 3 s
const PERIOD_CARE_POLL_INTERVAL_MS = 60_000;
const BACKGROUND_MESSAGE_STAGGER_MS = 800;
// 记忆唤起主动关心：用户超过 6 小时没回、且该角色有可提起的长期记忆时，角色主动私聊提起共同经历
const MEMORY_CARE_POLL_INTERVAL_MS = 60_000;
const MEMORY_CARE_MIN_IDLE_MS = 6 * 60 * 60 * 1000;
const MEMORY_CARE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 同一角色 24h 内最多主动关心一次
const MEMORY_CARE_LAST_TS_PREFIX = "ai_phone_mem_care_last_";
const MEMORY_CARE_ENABLED_KEY = "ai_phone_mem_care_enabled";
const MEMORY_CARE_ENABLED_PER_CHAR_PREFIX = "ai_phone_mem_care_enabled_char_";

/**
 * 每角色独立硬开关（人物聊天设置栏可单独关掉某个角色）：
 * - 传 characterId：优先读该角色自己的 key，缺省回退全局默认（兼容老数据）
 * - 不传：读全局默认（"我"页的全局开关，作为所有角色的默认值）
 */
export function isMemoryCareEnabled(characterId?: string): boolean {
    if (typeof window === "undefined") return true;
    try {
        const raw = characterId
            ? localStorage.getItem(MEMORY_CARE_ENABLED_PER_CHAR_PREFIX + characterId)
            : null;
        const v = raw ?? localStorage.getItem(MEMORY_CARE_ENABLED_KEY);
        if (v === null) return false; // 默认关闭：记忆唤起主动关心为增量辅助功能，默认不主动打扰用户
        return v !== "0" && v !== "false";
    } catch {
        return true;
    }
}

export function setMemoryCareEnabled(enabled: boolean, characterId?: string): void {
    if (typeof window === "undefined") return;
    try {
        const key = characterId
            ? MEMORY_CARE_ENABLED_PER_CHAR_PREFIX + characterId
            : MEMORY_CARE_ENABLED_KEY;
        localStorage.setItem(key, enabled ? "1" : "0");
    } catch {
        // ignore
    }
}
const SCHEDULED_OUTBOX_GRACE_MS = 8000;

function resolveFollowUpSenderName(sessionId: string): string {
    const sess = loadChatSessions().find(s => s.id === sessionId);
    if (!sess) return "角色";
    if (sess.isGroup) return sess.groupName?.trim() || "群聊";
    const alias = sess.alias?.trim();
    if (alias) return alias;
    return loadCharacters().find(character => character.id === sess.contactId)?.name?.trim() || "角色";
}

function resolveTimedWakeElapsedMinutes(sched: TimedWakeSchedule, history: ChatMessage[], atMs: number): number {
    if (sched.source === "user") {
        const lastUser = [...history].reverse().find(message => message.role === "user");
        const lastUserAt = lastUser ? Date.parse(lastUser.createdAt) : sched.createdAt;
        return Math.max(1, Math.round((atMs - lastUserAt) / 60000));
    }
    return Math.max(1, Math.round((atMs - sched.createdAt) / 60000));
}

// ── Module state ───────────────────────────────────────────
let stopInterval: (() => void) | null = null;
let periodCareUpdateHandler: (() => void) | null = null;
const firingSet = new Set<string>(); // sessions currently mid-API-call
const cancelledWhileFiring = new Set<string>(); // cancelled during in-flight API call
const timedWakeFiringSet = new Set<string>();
const periodCareFiringSet = new Set<string>();
const backgroundReplyFiringSet = new Set<string>();
const memoryCareFiringSet = new Set<string>();
let lastMemoryCarePollAt = 0;
// 正在后台生成回复的会话（追问/定时唤醒/经期关心/统一后台回复）。
// 聊天室挂载时查询它：中途进入也能立刻显示「正在输入」，补上事件错过的缝
const backgroundGeneratingSessions = new Set<string>();
const cancelledBackgroundSessions = new Set<string>();

/** 该会话是否正有后台回复在生成（聊天室中途挂载时用来恢复输入中状态）。 */
export function isBackgroundReplyGenerating(sessionId: string): boolean {
    return backgroundGeneratingSessions.has(sessionId);
}

export function cancelBackgroundGeneration(sessionId: string): void {
    if (!backgroundGeneratingSessions.has(sessionId) && !firingSet.has(sessionId)) return;
    cancelledBackgroundSessions.add(sessionId);
    if (firingSet.has(sessionId)) cancelledWhileFiring.add(sessionId);
    cancelFollowUpBailout(sessionId);
}

function isBackgroundGenerationCancelled(sessionId: string): boolean {
    return cancelledBackgroundSessions.has(sessionId);
}
let lastPeriodCarePollAt = 0;
let scheduledOutboxGraceUntil = 0;
let scheduledOutboxVisibilityHandler: (() => void) | null = null;
let scheduledOutboxFocusHandler: (() => void) | null = null;
let scheduledOutboxPageShowHandler: (() => void) | null = null;

function extendScheduledOutboxGrace(): void {
    scheduledOutboxGraceUntil = Math.max(scheduledOutboxGraceUntil, Date.now() + SCHEDULED_OUTBOX_GRACE_MS);
}

// ── Public API ─────────────────────────────────────────────

export function startFollowUpService() {
    if (stopInterval) return; // already running
    console.log("[FollowUp] Service started, polling every", POLL_INTERVAL_MS, "ms");
    extendScheduledOutboxGrace();
    stopInterval = bgSetInterval(pollSchedules, POLL_INTERVAL_MS);
    if (typeof window !== "undefined") {
        periodCareUpdateHandler = () => {
            lastPeriodCarePollAt = 0;
            pollMenstrualPeriodCare(Date.now());
        };
        window.addEventListener("menstrual-period-care-updated", periodCareUpdateHandler);
        scheduledOutboxVisibilityHandler = () => {
            if (!document.hidden) { extendScheduledOutboxGrace(); kickGroupWarmupCheck(); }
        };
        scheduledOutboxFocusHandler = () => { extendScheduledOutboxGrace(); kickGroupWarmupCheck(); };
        scheduledOutboxPageShowHandler = () => { extendScheduledOutboxGrace(); kickGroupWarmupCheck(); };
        document.addEventListener("visibilitychange", scheduledOutboxVisibilityHandler);
        window.addEventListener("focus", scheduledOutboxFocusHandler);
        window.addEventListener("pageshow", scheduledOutboxPageShowHandler);
    }
    // 进 App 立即补一次冷场检查（不保活回来时后台心跳是死的，靠这次补触发）
    kickGroupWarmupCheck();
}

export function stopFollowUpService() {
    if (stopInterval) { stopInterval(); stopInterval = null; }
    if (typeof window !== "undefined" && periodCareUpdateHandler) {
        window.removeEventListener("menstrual-period-care-updated", periodCareUpdateHandler);
        periodCareUpdateHandler = null;
    }
    if (typeof window !== "undefined") {
        if (scheduledOutboxVisibilityHandler) {
            document.removeEventListener("visibilitychange", scheduledOutboxVisibilityHandler);
            scheduledOutboxVisibilityHandler = null;
        }
        if (scheduledOutboxFocusHandler) {
            window.removeEventListener("focus", scheduledOutboxFocusHandler);
            scheduledOutboxFocusHandler = null;
        }
        if (scheduledOutboxPageShowHandler) {
            window.removeEventListener("pageshow", scheduledOutboxPageShowHandler);
            scheduledOutboxPageShowHandler = null;
        }
    }
}

/** Schedule a follow-up for a session (called by ChatRoom after AI replies).
 *  Purely anxiety-driven: no anxiety field or below threshold → no follow-up. */
export function scheduleFollowUp(sessionId: string, count: number, stateValues?: StateValue[]) {
    const config = loadFollowUpConfig();

    // 总开关：关掉后不再安排任何焦虑驱动追问（原机制无开关、且模型可持续输出高焦虑值导致无限追发）
    if (!config.enabled) {
        clearFollowUpSchedule(sessionId);
        cancelFollowUpBailout(sessionId);
        return;
    }

    // 全局关闭冷却期：全局总开关被关过，重新打开后 24h 内不立即续排，防旧高焦虑上下文反复
    if (Date.now() < getGlobalFollowUpGraceUntil()) {
        clearFollowUpSchedule(sessionId);
        cancelFollowUpBailout(sessionId);
        return;
    }

    // 每角色独立开关 + 关闭冷却期（1:1 会话按 contactId 判断；群聊继续跟随全局）
    const followSession = loadChatSessions().find(s => s.id === sessionId);
    if (followSession && !followSession.isGroup && followSession.contactId) {
        const override = getFollowUpCharOverride(followSession.contactId);
        const charEnabled = override === null ? config.enabled : override;
        if (!charEnabled) {
            clearFollowUpSchedule(sessionId);
            cancelFollowUpBailout(sessionId);
            return;
        }
        if (Date.now() < getFollowUpGraceUntil(followSession.contactId)) {
            clearFollowUpSchedule(sessionId);
            cancelFollowUpBailout(sessionId);
            return;
        }
    }

    if (!stateValues || stateValues.length === 0) {
        console.log(`[FollowUp] No state values, not scheduling.`);
        clearFollowUpSchedule(sessionId);
        cancelFollowUpBailout(sessionId);
        return;
    }

    const anxietyEntry = stateValues.find(sv => sv.name === config.anxietyFieldName);
    if (!anxietyEntry) {
        console.log(`[FollowUp] No "${config.anxietyFieldName}" field found, not scheduling.`);
        clearFollowUpSchedule(sessionId);
        cancelFollowUpBailout(sessionId);
        return;
    }

    if (anxietyEntry.value < config.anxietyThreshold) {
        console.log(`[FollowUp] Anxiety ${anxietyEntry.value} < threshold ${config.anxietyThreshold}, not scheduling.`);
        clearFollowUpSchedule(sessionId);
        cancelFollowUpBailout(sessionId);
        return;
    }

    // Linear interpolation: threshold → maxDelay, 100 → minDelay
    const range = 100 - config.anxietyThreshold;
    const t = range > 0 ? (anxietyEntry.value - config.anxietyThreshold) / range : 1;
    const delaySec = Math.round(config.anxietyMaxDelay + t * (config.anxietyMinDelay - config.anxietyMaxDelay));
    const fireAt = Date.now() + delaySec * 1000;
    console.log(`[FollowUp] Anxiety-driven: value=${anxietyEntry.value}, delay=${delaySec}s, session=${sessionId}, count=${count}`);
    saveFollowUpSchedule({ sessionId, fireAt, count, delaySec });
    // 离线推送兜底：把本轮追问的完整请求快照预约到服务端，App 被杀时由服务端接管
    void armFollowUpBailout(sessionId, count, delaySec, fireAt);
}

/** 关闭某角色的焦虑追问：清其所有 1:1 会话的已排追问（本地+服务端）并记 24h 冷却期，
 *  冷却期内即使重新打开也不立即续排（防上下文积压的高焦虑值一开就反复）。 */
export function disableFollowUpForCharacter(characterId: string): void {
    setFollowUpCharOverride(characterId, false);
    recordFollowUpGrace(characterId);
    const sessions = loadChatSessions().filter(s => !s.isGroup && s.contactId === characterId);
    for (const s of sessions) {
        clearFollowUpSchedule(s.id);
        cancelFollowUpBailout(s.id);
    }
}

/** 打开某角色的焦虑追问。冷却期保留（由 scheduleFollowUp 的 grace 检查兜底），让高焦虑上下文自然消退。 */
export function enableFollowUpForCharacter(characterId: string): void {
    setFollowUpCharOverride(characterId, true);
}

export async function requestBackgroundChatReply(sessionId: string): Promise<{ ok: boolean; skipped?: string }> {
    if (backgroundReplyFiringSet.has(sessionId)) return { ok: false, skipped: "already_running" };
    const session = loadChatSessions().find(s => s.id === sessionId);
    if (!session) return { ok: false, skipped: "missing_session" };

    backgroundReplyFiringSet.add(sessionId);
    try {
        const latestMessages = loadChatMessages(session.id);
        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));
        const rounds = await generateBackgroundCompletionRounds(
            session,
            latestMessages,
            { appTags: session.isGroup ? undefined : ["chat", "text"] },
        );
        if (isBackgroundGenerationCancelled(session.id)) return { ok: false, skipped: "cancelled" };
        const { hasVisible, stateValues } = await saveBackgroundCompletionRounds(
            rounds,
            session.id,
            0,
            undefined,
            latestMessages,
        );
        if (hasVisible) scheduleFollowUp(session.id, 0, stateValues);
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
        return { ok: true };
    } catch (error: any) {
        console.error("[BackgroundReply] Error:", error);
        pushChatMessage({
            sessionId,
            role: "system",
            content: `⚠️ 后台回复失败: ${error?.message || String(error)}`,
        });
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId } }));
        return { ok: false };
    } finally {
        backgroundGeneratingSessions.delete(sessionId);
        cancelledBackgroundSessions.delete(sessionId);
        backgroundReplyFiringSet.delete(sessionId);
    }
}

/** Cancel any pending follow-up for a session (called when user sends a message). */
export function cancelFollowUp(sessionId: string) {
    clearFollowUpSchedule(sessionId);
    cancelFollowUpBailout(sessionId);
    // 用户发了消息：冷场重连计数清零，按新周期重挂服务端预约
    const idleRule = resetIdleReconnectForSession(sessionId);
    if (idleRule) void armIdleReconnectBailout({ ...idleRule, consecutiveCount: 0 });
    // 用户在群里发了消息：该群冷场计数清零（有互动就不强制触发）
    resetGroupWarmupForSession(sessionId);
    // If an API call is already in-flight, mark it for cancellation
    if (firingSet.has(sessionId)) {
        cancelledWhileFiring.add(sessionId);
    }
}

// ── Internals ──────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    // Worker 定时器：iOS 后台会冻结主线程 setTimeout，逐条弹出的间隔若用它，
    // 多气泡回复的保存流程会卡在后台直到回前台
    return new Promise<void>(resolve => { bgSetTimeout(resolve, ms); });
}

async function dispatchBackgroundMessagesOneByOne(sessionId: string, messages: ChatMessage[], immediate = false) {
    for (let index = 0; index < messages.length; index += 1) {
        if (index > 0 && !immediate) await delay(BACKGROUND_MESSAGE_STAGGER_MS);
        window.dispatchEvent(new CustomEvent("followup-message-saved", {
            detail: { sessionId, message: messages[index] },
        }));
    }
}

type BackgroundCompletionRound = {
    text: string;
    responseBatchId?: string;
    rawResponseText?: string;
    reasoningText?: string;
};

async function generateBackgroundCompletionRounds(
    session: Parameters<typeof generateChatCompletion>[0],
    messages: Parameters<typeof generateChatCompletion>[1],
    options: Parameters<typeof generateChatCompletion>[2],
): Promise<BackgroundCompletionRound[]> {
    const rounds: BackgroundCompletionRound[] = [];
    // 每轮 LLM 调用的思维链：onReasoning 先于该轮 onTextPart 触发，挂到该轮文本上
    let pendingReasoning: string | undefined;
    const result = await generateChatCompletion(session, messages, options, {
        onReasoning: (t) => { pendingReasoning = t; },
        onTextPart: (text, _senderInfo, meta) => {
            if (!text.trim()) return;
            const reasoningText = pendingReasoning;
            pendingReasoning = undefined;
            rounds.push({
                text,
                responseBatchId: meta?.responseBatchId,
                rawResponseText: meta?.rawResponseText ?? text,
                reasoningText,
            });
        },
    });
    if (rounds.length === 0) {
        const fallback = flattenCompletionResult(result);
        if (fallback.trim()) rounds.push({ text: fallback, rawResponseText: fallback, reasoningText: pendingReasoning });
    }
    return rounds;
}

async function saveBackgroundCompletionRounds(
    rounds: BackgroundCompletionRound[],
    sessionId: string,
    currentCount: number,
    followUpIndex: number | undefined,
    contextMessages: ChatMessage[],
    options?: { senderCharacterId?: string; senderName?: string; silent?: boolean },
): Promise<{ hasVisible: boolean; newCount: number; stateValues: StateValue[] }> {
    let hasVisible = false;
    let newCount = currentCount;
    let stateValues: StateValue[] = [];
    for (const round of rounds) {
        const result = await parseAndSaveResponse(
            round.text,
            sessionId,
            currentCount,
            followUpIndex,
            contextMessages,
            {
                ...options,
                responseBatchId: round.responseBatchId,
                rawResponseText: round.rawResponseText,
                reasoningText: round.reasoningText,
            },
        );
        if (result.hasVisible) {
            hasVisible = true;
            newCount = result.newCount;
        } else if (!hasVisible) {
            newCount = result.newCount;
        }
        if (result.stateValues.length > 0) {
            stateValues = result.stateValues;
        }
    }
    return { hasVisible, newCount, stateValues };
}

function pollSchedules() {
    try {
        const schedules = loadAllFollowUpSchedules();
        const now = Date.now();
        for (const sched of schedules) {
            if (sched.fireAt > now) {
                const remainSec = Math.round((sched.fireAt - now) / 1000);
                if (remainSec % 10 === 0) console.log(`[FollowUp] Waiting: session=${sched.sessionId}, ${remainSec}s remaining`);
                continue;
            }
            if (firingSet.has(sched.sessionId)) continue; // already in-flight
            console.log(`[FollowUp] Firing now for session=${sched.sessionId}, count=${sched.count}`);
            fireFollowUp(sched); // intentionally not awaited — fire & forget
        }
        pollTimedWakeSchedules(now);
        pollMenstrualPeriodCare(now);
        pollMemoryCare(now);
        pollIdleReconnect(now);
        pollGroupWarmup(now);
    } catch (e) {
        console.error("[FollowUp] pollSchedules error:", e);
    }
}

function pollTimedWakeSchedules(now: number) {
    const schedules = loadTimedWakeSchedules();
    for (const sched of schedules) {
        if (sched.fireAt > now) continue;
        if (timedWakeFiringSet.has(sched.id)) continue;
        if (now < scheduledOutboxGraceUntil) continue;
        console.log(`[TimedWake] Firing now for session=${sched.sessionId}`);
        fireTimedWake(sched);
    }
}

function pollMenstrualPeriodCare(now: number) {
    if (now - lastPeriodCarePollAt < PERIOD_CARE_POLL_INTERVAL_MS) return;
    lastPeriodCarePollAt = now;

    const config = loadMenstrualConfig();
    if (!config.periodCareEnabled || config.periodCareCharacterIds.length === 0) return;

    const records = loadMenstrualRecords();
    const event = getMenstrualPeriodCareEvent(records, config);
    if (!event) return;

    const selectedIds = new Set(config.periodCareCharacterIds);
    const sessions = loadChatSessions()
        .filter(session => !session.isGroup && selectedIds.has(session.contactId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latestSessionByCharacter = new Map<string, (typeof sessions)[number]>();
    for (const session of sessions) {
        if (!latestSessionByCharacter.has(session.contactId)) {
            latestSessionByCharacter.set(session.contactId, session);
        }
    }

    for (const characterId of selectedIds) {
        if (hasMenstrualPeriodCareTriggered(characterId, event.cycleKey)) continue;
        const session = latestSessionByCharacter.get(characterId);
        if (!session) continue;
        const firingKey = `${characterId}:${event.cycleKey}`;
        if (periodCareFiringSet.has(firingKey)) continue;
        console.log(`[PeriodCare] Firing now for session=${session.id}, cycle=${event.cycleKey}`);
        fireMenstrualPeriodCare({
            sessionId: session.id,
            characterId,
            event,
        });
    }
}

async function fireFollowUp(sched: { sessionId: string; count: number; delaySec?: number }) {
    if (sched.count >= MAX_FOLLOW_UPS) {
        clearFollowUpSchedule(sched.sessionId);
        return;
    }

    firingSet.add(sched.sessionId);
    clearFollowUpSchedule(sched.sessionId); // clear before firing

    try {
        const sessions = loadChatSessions();
        const session = sessions.find(s => s.id === sched.sessionId);
        if (!session) return;

        const latestMessages = loadChatMessages(session.id);

        const count = sched.count + 1;

        // Find the last user message timestamp to calculate silence duration
        const lastUserMsg = [...latestMessages].reverse().find(m => m.role === "user");
        const lastUserTime = lastUserMsg ? new Date(lastUserMsg.createdAt).getTime() : Date.now();

        // Build message list with follow-up round markers so AI knows its history
        const annotatedMessages: ChatMessage[] = [];
        let currentRound = 0;
        for (const msg of latestMessages) {
            // When we encounter a new follow-up round, insert a marker
            if (msg.role === "assistant" && msg.followUpIndex && msg.followUpIndex > currentRound) {
                currentRound = msg.followUpIndex;
                const markerTime = new Date(msg.createdAt).getTime();
                const silenceSec = Math.round((markerTime - lastUserTime) / 1000);
                annotatedMessages.push({
                    id: `_marker_${currentRound}_${Date.now()}`,
                    sessionId: session.id,
                    role: "user",
                    content: `[对方没有回复你的消息，距上次回复已过约${silenceSec}秒]`,
                    status: "sent",
                    createdAt: msg.createdAt,
                });
            }
            annotatedMessages.push(msg);
        }

        const nowMs = Date.now();
        const finalSilenceSec = Math.round((nowMs - lastUserTime) / 1000);
        const messagesWithHint: ChatMessage[] = [
            ...annotatedMessages,
            {
                id: `_silence_${nowMs}`,
                sessionId: session.id,
                role: "system",
                content: `[对方没有回复你的消息，距上次回复已过约${finalSilenceSec}秒]`,
                status: "sent",
                createdAt: new Date().toISOString(),
            },
        ];

        // Notify UI that follow-up generation is starting (typing indicator)
        console.log("[FollowUp] Dispatching followup-started for session:", session.id);
        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        // 本地生成期间给本轮兜底预约续命：慢生成不会被服务端误判为"客户端已死"
        const stopBailoutHeartbeat = startBailoutHeartbeat(`followup:${session.id}:${count}`);
        let rounds: BackgroundCompletionRound[];
        try {
            rounds = await generateBackgroundCompletionRounds(
                session,
                messagesWithHint,
                { followUpCount: count, followUpDelay: sched.delaySec ?? 60, appTags: ["chat", "text", "followup"] },
            );
        } finally {
            stopBailoutHeartbeat();
        }

        // User sent a message while we were waiting for the API — discard result
        if (cancelledWhileFiring.has(sched.sessionId) || isBackgroundGenerationCancelled(sched.sessionId)) {
            console.log(`[FollowUp] Cancelled during API call, discarding result for session=${sched.sessionId}`);
            cancelledWhileFiring.delete(sched.sessionId);
            return;
        }

        const { hasVisible, newCount, stateValues } = await saveBackgroundCompletionRounds(rounds, session.id, sched.count, count, latestMessages);
        console.log(`[FollowUp] Result: hasVisible=${hasVisible}, newCount=${newCount}`);

        // 本地已完成这一轮，撤销服务端对应的兜底预约（只撤本轮的精确键，
        // 不用前缀删，避免误删 scheduleFollowUp 马上要挂的下一轮）
        cancelFollowUpBailout(session.id, count);

        if (hasVisible && newCount < MAX_FOLLOW_UPS) {
            scheduleFollowUp(session.id, newCount, stateValues);
        }

        // Notify any mounted UI
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));

    } catch (error: any) {
        console.error(`[FollowUp] Error:`, error);
        pushChatMessage({
            sessionId: sched.sessionId,
            role: "system",
            content: `⚠️ 追发失败: ${error?.message || String(error)}`,
        });
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: sched.sessionId } }));
    } finally {
        backgroundGeneratingSessions.delete(sched.sessionId);
        cancelledBackgroundSessions.delete(sched.sessionId);
        firingSet.delete(sched.sessionId);
        cancelledWhileFiring.delete(sched.sessionId);
    }
}

function getLastMemoryCareTs(characterId: string): number {
    try {
        return Number(localStorage.getItem(MEMORY_CARE_LAST_TS_PREFIX + characterId) || "0");
    } catch {
        return 0;
    }
}

function setLastMemoryCareTs(characterId: string, ts: number) {
    try {
        localStorage.setItem(MEMORY_CARE_LAST_TS_PREFIX + characterId, String(ts));
    } catch {
        // ignore storage errors
    }
}

/**
 * 记忆唤起主动关心：用户在某个 1:1 会话里较久没回复（≥6h）、
 * 该角色 24h 内没主动关心过、且角色有可提起的长期记忆时，
 * 触发主动私聊——角色"想起"共同经历，自然提起过去、表达关心。
 * 全程 best-effort：无记忆 / 生成失败都静默跳过，不打扰用户。
 */
function pollMemoryCare(now: number) {
    if (now - lastMemoryCarePollAt < MEMORY_CARE_POLL_INTERVAL_MS) return;
    lastMemoryCarePollAt = now;

    const sessions = loadChatSessions()
        .filter(session => !session.isGroup && !!session.contactId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    for (const session of sessions) {
        const characterId = session.contactId!;
        // 内部生活（梦境/日记）：受全局开关管控（1.7.43 起默认关闭），开启后才逐个角色检查
        if (isDreamEnabled()) maybeRunCharacterInternalLife(characterId);
        // 每角色独立开关：该角色关闭则跳过（缺省回退全局默认）
        if (!isMemoryCareEnabled(characterId)) continue;
        if (memoryCareFiringSet.has(characterId)) continue;
        if (now - getLastMemoryCareTs(characterId) < MEMORY_CARE_COOLDOWN_MS) continue;

        // 找最近一条用户消息的时间；没有用户消息则跳过
        const messages = loadChatMessages(session.id);
        const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
        if (!lastUserMsg) continue;
        const idleMs = now - new Date(lastUserMsg.createdAt).getTime();
        if (idleMs < MEMORY_CARE_MIN_IDLE_MS) continue;

        console.log(`[MemoryCare] Firing now for character=${characterId}, idle=${Math.round(idleMs / 3600000)}h`);
        memoryCareFiringSet.add(characterId);
        fireMemoryCare(characterId); // fire & forget
    }
}

async function fireMemoryCare(characterId: string) {
    try {
        const sessionId = await triggerMemoryCareDM(characterId, { appId: "chat" });
        if (sessionId) {
            setLastMemoryCareTs(characterId, Date.now());
            console.log(`[MemoryCare] Done for character=${characterId}, session=${sessionId}`);
        }
    } catch (error) {
        console.warn("[MemoryCare] Error:", error);
    } finally {
        memoryCareFiringSet.delete(characterId);
    }
}

// ── 冷场重连：用户长时间没消息 → 角色主动发一次（连发上限内可重复） ──

const idleReconnectFiringSet = new Set<string>();
let lastIdleReconnectPollAt = 0;
const IDLE_RECONNECT_POLL_INTERVAL_MS = 60_000;

function pollIdleReconnect(now: number) {
    if (now - lastIdleReconnectPollAt < IDLE_RECONNECT_POLL_INTERVAL_MS) return;
    lastIdleReconnectPollAt = now;

    for (const rule of loadIdleReconnectRules()) {
        if (idleReconnectFiringSet.has(rule.id)) continue;
        if (firingSet.has(rule.sessionId)) continue;
        // 追问链正在管这个会话时不叠加打扰
        if (loadAllFollowUpSchedules().some(sched => sched.sessionId === rule.sessionId)) continue;

        const messages = loadChatMessages(rule.sessionId);
        const lastUser = [...messages].reverse().find(m => m.role === "user");
        if (!lastUser) continue;
        const lastUserAt = new Date(lastUser.createdAt).getTime();

        const effectiveConsecutive = rule.lastFiredAt && rule.lastFiredAt > lastUserAt ? rule.consecutiveCount : 0;
        if (effectiveConsecutive >= IDLE_RECONNECT_MAX_CONSECUTIVE) continue;

        const intervalMs = Math.max(1, rule.intervalMinutes) * 60_000;
        const nextDueAt = Math.max(
            lastUserAt + intervalMs,
            rule.lastFiredAt ? rule.lastFiredAt + intervalMs : 0,
            rule.suppressedUntil ?? 0,
        );
        if (now < nextDueAt) continue;
        if (now < scheduledOutboxGraceUntil) continue;
        if (isWithinPushQuietHours(now)) continue; // 安静时段本地也不打扰，出时段后自然触发

        console.log(`[IdleReconnect] Firing for session=${rule.sessionId}, idle=${Math.round((now - lastUserAt) / 60000)}min`);
        void fireIdleReconnect(rule, lastUserAt);
    }
}

async function fireIdleReconnect(rule: IdleReconnectRule, lastUserAt: number) {
    idleReconnectFiringSet.add(rule.id);
    try {
        const session = loadChatSessions().find(s => s.id === rule.sessionId);
        if (!session || session.isGroup || session.contactId !== rule.characterId) return;

        // 本地接手当前这次生成，先撤销服务端同规则排队任务；生成成功后才记连发次数。
        void cancelBailoutPrefix(`idle:${rule.id}:`);

        const latestMessages = loadChatMessages(session.id);
        const elapsedMinutes = Math.max(1, Math.round((Date.now() - lastUserAt) / 60000));

        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        const rounds = await generateBackgroundCompletionRounds(
            session,
            latestMessages,
            {
                appTags: ["chat", "text", "idle_wake"],
                timedWakeElapsedMinutes: elapsedMinutes,
            },
        );

        if (isBackgroundGenerationCancelled(session.id)) {
            const intervalMs = Math.max(1, rule.intervalMinutes) * 60_000;
            const suppressed = suppressIdleReconnectUntil(rule.id, Date.now() + intervalMs);
            if (suppressed) void armIdleReconnectBailout(suppressed);
            window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
            return;
        }

        const { hasVisible, stateValues } = await saveBackgroundCompletionRounds(
            rounds,
            session.id,
            0,
            undefined,
            latestMessages,
        );
        markIdleReconnectFired(rule.id, Date.now());
        if (hasVisible) scheduleFollowUp(session.id, 0, stateValues);
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));

        // 下一发（连发上限内）重新挂到服务端
        const refreshed = loadIdleReconnectRules().find(item => item.id === rule.id);
        if (refreshed) void armIdleReconnectBailout(refreshed);
    } catch (error: unknown) {
        console.error("[IdleReconnect] Error:", error);
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: rule.sessionId } }));
    } finally {
        backgroundGeneratingSessions.delete(rule.sessionId);
        cancelledBackgroundSessions.delete(rule.sessionId);
        idleReconnectFiringSet.delete(rule.id);
    }
}

// ── 群冷场自动暖场：群太久没消息 → 允许暖场的角色主动接话（频率只管基线兜底） ──

const groupWarmupFiringSet = new Set<string>();
let lastGroupWarmupPollAt = 0;
const GROUP_WARMUP_POLL_INTERVAL_MS = 60_000;

/** 进 App / 回前台主动补一次冷场检查：绕过 60s 节流与 8s 发送宽限，让"已到设定时间"的群
 * 立即暖场，不必等下一次后台心跳轮到。仍尊重安静时段（不吵）。 */
export function kickGroupWarmupCheck(): void {
    if (!loadGroupWarmupEnabled()) return;
    pollGroupWarmup(Date.now(), true);
}

function pollGroupWarmup(now: number, force = false) {
    if (!force && now - lastGroupWarmupPollAt < GROUP_WARMUP_POLL_INTERVAL_MS) return;
    lastGroupWarmupPollAt = now;

    // 边界约束：暖场只写「真实群消息流」，绝不触碰「群聊线下模式」的离线轮次
    // （ai_phone_chat_offline_turns）。离线模式原有的自主推进剧情能力必须始终独立保留，
    // 暖场只是真实群的一个叠加层，二者互不替代、互不抑制。
    // 铁律：总开关关、或无白名单，一律不动作
    if (!loadGroupWarmupEnabled()) return;

    for (const rule of loadGroupWarmupRules()) {
        if (!rule.enabled) continue;
        // 铁律：每群白名单默认空，无勾选成员一律不动作
        if (!rule.whitelist || rule.whitelist.length === 0) continue;
        if (groupWarmupFiringSet.has(rule.groupSessionId)) continue;
        if (firingSet.has(rule.groupSessionId)) continue;

        const session = loadChatSessions().find((s) => s.id === rule.groupSessionId);
        if (!session || !session.isGroup) continue;

        const messages = loadChatMessages(session.id);
        const lastMsg = [...messages].reverse()[0];
        if (!lastMsg) continue;
        const lastMsgAt = new Date(lastMsg.createdAt).getTime();

        // 群里有新互动（任意角色）就重置连发计数：有互动不强制触发
        const effectiveConsecutive = rule.lastFiredAt && rule.lastFiredAt > lastMsgAt ? rule.consecutiveCount : 0;
        if (effectiveConsecutive >= GROUP_WARMUP_MAX_CONSECUTIVE) continue;

        const intervalMs = Math.max(1, rule.intervalMinutes) * 60_000;
        const nextDueAt = Math.max(
            lastMsgAt + intervalMs,
            rule.lastFiredAt ? rule.lastFiredAt + intervalMs : 0,
            rule.suppressedUntil ?? 0,
        );
        if (now < nextDueAt) continue;
        if (!force && now < scheduledOutboxGraceUntil) continue;
        if (isWithinPushQuietHours(now)) continue; // 安静时段本地也不打扰，出时段后自然触发

        console.log(`[GroupWarmup] Firing for group=${session.id}, idle=${Math.round((now - lastMsgAt) / 60000)}min`);
        void fireGroupWarmup(rule, session, lastMsg);
    }
}

async function fireGroupWarmup(
    rule: import("./group-warmup-storage").GroupWarmupRule,
    session: import("./chat-storage").ChatSession,
    lastMsg: import("./chat-storage").ChatMessage,
) {
    groupWarmupFiringSet.add(session.id);
    try {
        const chars = loadCharacters();
        const participants = (session.participantIds || [])
            .map((id) => chars.find((c) => c.id === id))
            .filter((c): c is NonNullable<typeof c> => Boolean(c));
        const lastSpeakerId = lastMsg.role === "assistant" ? (lastMsg.senderCharacterId ?? null) : null;
        // 白名单按群隔离：仅该群被勾选的成员可暖场（whitelist 已是群成员子集）
        const whitelist = new Set(rule.whitelist || []);

        // 候选发言者：群成员 ∩ 白名单；auto 模式排除刚发言者，指定模式锁定该角色
        let candidates = participants.filter((c) => whitelist.has(c.id));
        if (rule.speakerMode !== "auto") {
            const fixed = participants.find((c) => c.id === rule.speakerMode);
            candidates = fixed && whitelist.has(fixed.id) ? [fixed] : candidates;
        } else {
            const nonLast = candidates.filter((c) => c.id !== lastSpeakerId);
            if (nonLast.length > 0) candidates = nonLast;
        }
        if (candidates.length === 0) return;

        const latestMessages = loadChatMessages(session.id);

        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        // 不塞独立的 system 提示：与已验证的 idle-reconnect 范式一致，暖场引导交由
        // 群历史 + chat_group_warmup 预设（命中因 appTags 含 "warmup"）+ timedWakeElapsedMinutes 通道承担。
        // 真实时间差：让模型感知"群已冷场多久"，避免跨天暖场时接着上次的旧话题说（跳戏）。
        const lastMsgAt = new Date(lastMsg.createdAt).getTime();
        const elapsedMinutes = Math.max(1, Math.round((Date.now() - lastMsgAt) / 60000));
        const rounds = await generateBackgroundCompletionRounds(session, latestMessages, {
            appTags: ["group_chat", "warmup", "text"],
            timedWakeElapsedMinutes: elapsedMinutes,
            timedWakeIntent: "群冷场暖场",
        });

        if (isBackgroundGenerationCancelled(session.id)) {
            const intervalMs = Math.max(1, rule.intervalMinutes) * 60_000;
            suppressGroupWarmupUntil(session.id, Date.now() + intervalMs);
            window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
            return;
        }

        // 逐段解析「角色名：内容」，只落成白名单内且是候选的角色
        const texts = rounds.map((r) => r.text).join("\n");
        const lines = texts.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        // 有来有回（默认）：一次暖场最多落 3 条（起头+接话+偶尔第三位）；关了只落 1 条，防刷屏
        const maxLines = rule.exchange === false ? 1 : GROUP_WARMUP_EXCHANGE_MAX_LINES;
        let pushed = 0;
        for (const line of lines) {
            const m = line.match(/^([^：:]+)[：:]\s*([\s\S]*)$/);
            if (!m) continue;
            const name = m[1].trim();
            const content = m[2].trim();
            if (!content) continue;
            const char = candidates.find(
                (c) => c.name === name || name.includes(c.name) || c.name.includes(name),
            );
            if (!char) continue; // 非白名单/非候选角色，跳过
            pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content,
                senderCharacterId: char.id,
                senderName: char.name,
            });
            pushed += 1;
            if (pushed >= maxLines) break;
        }
        // 兜底：模型没按「角色名：内容」输出（整段就是一句话）→ 用候选首位落成
        if (pushed === 0 && texts.trim()) {
            const char = candidates[0];
            pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: texts.trim(),
                senderCharacterId: char.id,
                senderName: char.name,
            });
            pushed += 1;
        }

        if (pushed > 0) {
            markGroupWarmupFired(session.id, Date.now());
            window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
            window.dispatchEvent(new CustomEvent("weixin-messages-updated", { detail: { sessionId: session.id } }));
        }
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    } catch (error: unknown) {
        console.error("[GroupWarmup] Error:", error);
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    } finally {
        backgroundGeneratingSessions.delete(session.id);
        cancelledBackgroundSessions.delete(session.id);
        groupWarmupFiringSet.delete(session.id);
    }
}

async function fireTimedWake(sched: TimedWakeSchedule) {
    timedWakeFiringSet.add(sched.id);
    removeTimedWakeSchedule(sched.id);
    // 本地接手触发：撤销服务端兜底预约（生成中被杀由发送保险单接管）
    cancelBailoutKey(`timedwake:${sched.id}`);

    try {
        const sessions = loadChatSessions();
        const session = sessions.find(s => s.id === sched.sessionId);
        if (!session || session.contactId !== sched.characterId) return;

        const latestMessages = loadChatMessages(session.id);
        const elapsedMinutes = resolveTimedWakeElapsedMinutes(sched, latestMessages, Date.now());

        console.log("[TimedWake] Dispatching followup-started for session:", session.id);
        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        // 用户创建的定时只提供沉默时长语境；角色工具约的保留"你当时想着"视角。
        const wakeTag = sched.source === "user" ? "user_timed_wake" : "timed_wake";
        const rounds = await generateBackgroundCompletionRounds(
            session,
            latestMessages,
            {
                appTags: ["chat", "text", wakeTag],
                timedWakeElapsedMinutes: elapsedMinutes,
                timedWakeIntent: sched.intent,
            },
        );

        if (isBackgroundGenerationCancelled(session.id)) {
            window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
            return;
        }

        const { hasVisible, stateValues } = await saveBackgroundCompletionRounds(
            rounds,
            session.id,
            0,
            undefined,
            latestMessages,
        );
        console.log(`[TimedWake] Result: hasVisible=${hasVisible}`);

        // 记一笔自主唤醒：对方一直没回就累计，回过则清零（配合工具侧护栏，阻断角色无限自我续期）
        if (sched.source !== "user") {
            const lastUserMsg = [...latestMessages].reverse().find(m => m.role === "user");
            markTimedWakeFired(session.id, lastUserMsg ? new Date(lastUserMsg.createdAt).getTime() : 0);
        }

        if (hasVisible) {
            scheduleFollowUp(session.id, 0, stateValues);
        }

        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    } catch (error: any) {
        console.error("[TimedWake] Error:", error);
        const failureLabel = sched.source === "user" ? "定时主动消息" : "稍后主动联系";
        pushChatMessage({
            sessionId: sched.sessionId,
            role: "system",
            content: `⚠️ ${failureLabel}失败: ${error?.message || String(error)}`,
        });
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: sched.sessionId } }));
    } finally {
        backgroundGeneratingSessions.delete(sched.sessionId);
        cancelledBackgroundSessions.delete(sched.sessionId);
        timedWakeFiringSet.delete(sched.id);
    }
}

async function fireMenstrualPeriodCare(input: {
    sessionId: string;
    characterId: string;
    event: MenstrualPeriodCareEvent;
}) {
    const firingKey = `${input.characterId}:${input.event.cycleKey}`;
    periodCareFiringSet.add(firingKey);

    try {
        const sessions = loadChatSessions();
        const session = sessions.find(s => s.id === input.sessionId);
        if (!session || session.isGroup || session.contactId !== input.characterId) return;
        if (hasMenstrualPeriodCareTriggered(input.characterId, input.event.cycleKey)) return;

        const latestMessages = loadChatMessages(session.id);

        console.log("[PeriodCare] Dispatching followup-started for session:", session.id);
        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        const rounds = await generateBackgroundCompletionRounds(
            session,
            latestMessages,
            {
                appTags: ["chat", "text", "period_care"],
                periodCareContext: input.event.context,
            },
        );

        if (isBackgroundGenerationCancelled(session.id)) {
            window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
            return;
        }

        const { hasVisible, stateValues } = await saveBackgroundCompletionRounds(
            rounds,
            session.id,
            0,
            undefined,
            latestMessages,
        );
        saveMenstrualPeriodCareTrigger({
            characterId: input.characterId,
            sessionId: session.id,
            cycleKey: input.event.cycleKey,
        });
        cancelBailoutKey(`periodcare:${input.characterId}:${input.event.cycleKey}`);
        console.log(`[PeriodCare] Result: hasVisible=${hasVisible}`);

        if (hasVisible) {
            scheduleFollowUp(session.id, 0, stateValues);
        }

        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    } catch (error: any) {
        console.error("[PeriodCare] Error:", error);
        pushChatMessage({
            sessionId: input.sessionId,
            role: "system",
            content: `⚠️ 经期关心失败: ${error?.message || String(error)}`,
        });
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: input.sessionId } }));
    } finally {
        backgroundGeneratingSessions.delete(input.sessionId);
        cancelledBackgroundSessions.delete(input.sessionId);
        periodCareFiringSet.delete(firingKey);
    }
}

// ── AI media action handler for follow-up context ──
// （现实桥的后台生成也复用它：收红包/收转账/收代付在后台同样真执行）

export function handleFollowUpMediaAction(
    actionType: string,
    sessionId: string,
    contextMessages: ChatMessage[],
) {
    const targetMediaType = actionType.includes("payment_request")
        ? "payment_request"
        : actionType.includes("red_packet") ? "red_packet" : "transfer";
    const targetMsg = [...contextMessages].reverse().find(
        m => m.role === "user" && m.mediaType === targetMediaType && m.mediaData?.status === "pending"
    );
    if (!targetMsg) return;

    const charName = resolveFollowUpSenderName(sessionId);
    const userName = "你";
    const responseBatchId = createResponseBatchId();

    let newStatus: "opened" | "received" | "declined" | "paid";
    let sysText: string;
    let rawResponseText: string;
    if (actionType === "accept_red_packet") {
        newStatus = "opened";
        sysText = `${charName}领取了${userName}的红包`;
        rawResponseText = `[${charName}领取了${userName}的红包]`;
    } else if (actionType === "decline_red_packet") {
        newStatus = "declined";
        sysText = `${charName}退回了${userName}的红包`;
        rawResponseText = `[${charName}退回了${userName}的红包]`;
    } else if (actionType === "accept_transfer") {
        newStatus = "received";
        sysText = `${charName}已收款`;
        rawResponseText = `[${charName}领取了${userName}的转账]`;
    } else if (actionType === "accept_payment_request") {
        newStatus = "paid";
        sysText = `${charName}接受了${userName}的代付请求`;
        rawResponseText = `[${charName}接受了${userName}的代付]`;
        settleShoppingPaymentRequest({
            orderId: targetMsg.mediaData?.shoppingOrderId,
            requestId: targetMsg.mediaData?.paymentRequestId,
            accepted: true,
            payerCharacterName: charName,
        });
    } else if (actionType === "decline_payment_request") {
        newStatus = "declined";
        sysText = `${charName}拒绝了${userName}的代付请求`;
        rawResponseText = `[${charName}拒绝了${userName}的代付]`;
        settleShoppingPaymentRequest({
            orderId: targetMsg.mediaData?.shoppingOrderId,
            requestId: targetMsg.mediaData?.paymentRequestId,
            accepted: false,
            payerCharacterName: charName,
        });
    } else {
        newStatus = "declined";
        sysText = `${charName}退回了${userName}的转账`;
        rawResponseText = `[${charName}退回了${userName}的转账]`;
    }

    if (targetMediaType === "payment_request") {
        updateMessageMediaData(targetMsg.id, {
            ...targetMsg.mediaData,
            status: newStatus,
            paymentResolvedAt: new Date().toISOString(),
            paymentPayerName: charName,
        });
    } else {
        updateMessageMediaStatus(targetMsg.id, newStatus as "opened" | "received" | "declined");
    }
    pushChatMessage({
        sessionId,
        role: "system",
        content: sysText,
        responseBatchId,
        rawResponseText,
    });
}

// ── Response parser (uses shared parseAIResponse) ──

function buildGeneratedFollowUpImageMessage(
    part: ParsedMessagePart,
): Pick<ChatMessage, "content" | "mediaType" | "mediaUrl" | "mediaData"> {
    const base = {
        content: part.content,
        mediaType: part.mediaType,
        mediaData: part.mediaData,
    };
    if (part.mediaType !== "image") return base;

    const description = part.mediaData?.label?.trim();
    if (!description) return base;

    return {
        ...base,
        mediaData: createPendingChatGeneratedImageData(part.mediaData, description),
    };
}

function canCarryFollowUpPanel(part: ParsedMessagePart): boolean {
    return part.mediaType !== "poke" && part.mediaType !== "group_admin_notice";
}

// 后台保存 AI 回复的统一实现：分条、状态栏/独白、拍一拍、来电、收红包类动作、
// 生图占位、横幅+系统弹窗、逐条弹出。追问/定时唤醒/经期关心/自定义APP/现实桥/
// 朋友圈动作标签都走这里；聊天室前台有自己的原生实现。
// options.senderCharacterId/senderName：群聊消息的发言角色（单聊不传）。
// options.silent：静默落账（离线推送回端合并用）——立即写入全部消息、立即派发事件，
// 不弹横幅/系统通知（推送在设备上已经弹过一遍了）。
export async function parseAndSaveResponse(
    rawText: string,
    sessionId: string,
    currentCount: number,
    followUpIndex: number | undefined,
    contextMessages: ChatMessage[],
    options?: {
        senderCharacterId?: string;
        senderName?: string;
        silent?: boolean;
        responseBatchId?: string;
        rawResponseText?: string;
        reasoningText?: string;
    },
): Promise<{ hasVisible: boolean; newCount: number; stateValues: StateValue[] }> {
    const responseBatchId = options?.responseBatchId || createResponseBatchId();
    const rawResponseText = options?.rawResponseText ?? rawText;
    const reasoningText = options?.reasoningText;
    void contextMessages;
    const sessions = loadChatSessions();
    const sess = sessions.find(s => s.id === sessionId);
    const previousState = sess && !sess.isGroup ? getLatestCharacterStateValues(sess.contactId) : [];

    const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(rawText, previousState);

    // Detect call triggers and AI media actions, filter them out (not stored as messages)
    let triggerCall: "voice" | "video" | undefined;
    const charName = resolveFollowUpSenderName(sessionId);

    const filteredParts: ParsedMessagePart[] = [];
    for (const p of parts) {
        if (p.mediaType === "voice_call") { triggerCall = "voice"; continue; }
        if (p.mediaType === "video_call") { triggerCall = "video"; continue; }
        // 「丢弃角色输出的无效表情包」开关（主动消息路径）
        if (p.mediaType === "sticker" && sess?.discardInvalidStickers === true) {
            const senderIds = sess.isGroup ? (sess.participantIds ?? []) : [sess.contactId];
            if (!isKnownStickerLabel(p.mediaData?.label || "", senderIds)) continue;
        }
        if (p.mediaType === "accept_red_packet" || p.mediaType === "decline_red_packet"
            || p.mediaType === "accept_transfer" || p.mediaType === "decline_transfer"
            || p.mediaType === "accept_payment_request" || p.mediaType === "decline_payment_request") {
            handleFollowUpMediaAction(p.mediaType, sessionId, contextMessages);
            continue;
        }
        if (p.mediaType === "poke") {
            const pokeSender = (p.mediaData?.pokeSender === "我" ? charName : p.mediaData?.pokeSender) || charName;
            const pokeTarget = p.mediaData?.pokeTarget || "你";
            filteredParts.push({
                content: `${pokeSender} 拍了拍 ${pokeTarget}`,
                mediaType: "poke",
                mediaData: { pokeSender, pokeTarget },
            });
            continue;
        }
        filteredParts.push(p);
    }

    // Save call trigger as system message (persists even when user is not in chat room)
    if (triggerCall) {
        const callLabel = triggerCall === "voice" ? "语音通话" : "视频通话";
        pushChatMessage({
            sessionId,
            role: "system",
            content: `[我发起了${callLabel}]`,
            responseBatchId: createResponseBatchId(),
            rawResponseText: `[我发起了${callLabel}]`,
        });
    }

    if (filteredParts.length === 0) {
        if (statusPanel || innerMonologue || reasoningText) {
            pushChatMessage({
                sessionId,
                role: "assistant",
                content: "",
                responseBatchId,
                rawResponseText,
                statusPanel,
                innerMonologue,
                reasoningText,
                stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
                ...(followUpIndex ? { followUpIndex } : {}),
            });
        }
        // Emit call trigger event for chat-room to pick up
        if (triggerCall && typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("ai-call-trigger", { detail: { sessionId, type: triggerCall } }));
        }
        return { hasVisible: false, newCount: MAX_FOLLOW_UPS, stateValues };
    }

    const savedMessages: ChatMessage[] = [];
    const imageReplacementTasks: Promise<unknown>[] = [];
    let metaIdx = filteredParts.findIndex(canCarryFollowUpPanel);
    if (metaIdx === -1 && (statusPanel || innerMonologue || reasoningText || stateValues.length > 0)) {
        filteredParts.push({ content: "" });
        metaIdx = filteredParts.length - 1;
    }
    for (let i = 0; i < filteredParts.length; i++) {
        const generatedPart = buildGeneratedFollowUpImageMessage(filteredParts[i]);
        const saved = pushChatMessage({
            sessionId,
            role: "assistant",
            content: generatedPart.content,
            mediaType: generatedPart.mediaType,
            mediaUrl: generatedPart.mediaUrl,
            mediaData: generatedPart.mediaData,
            responseBatchId,
            rawResponseText,
            statusPanel: i === metaIdx && statusPanel ? statusPanel : undefined,
            innerMonologue: i === metaIdx && innerMonologue ? innerMonologue : undefined,
            reasoningText: i === metaIdx ? reasoningText : undefined,
            stateValues: i === metaIdx && stateValues.length > 0 ? stateValues : undefined,
            freshStateValues: i === metaIdx ? freshStateValues : undefined,
            senderCharacterId: options?.senderCharacterId,
            senderName: options?.senderName,
            ...(followUpIndex ? { followUpIndex } : {}),
        });
        if (isPendingChatGeneratedImageMessage(saved)) {
            imageReplacementTasks.push(
                generateAndApplyChatGeneratedImage(saved, sess?.contactId)
                    .catch(error => {
                        console.warn("[FollowUp] Image generation failed:", error);
                        return null;
                    }),
            );
        }
        savedMessages.push(saved);
    }

    await dispatchBackgroundMessagesOneByOne(sessionId, savedMessages, options?.silent === true);
    if (imageReplacementTasks.length > 0) {
        await Promise.allSettled(imageReplacementTasks);
    }

    // 与聊天室前台切后台时同节奏的双通道提醒：横幅 + 系统弹窗成对、
    // 按 800ms 逐条发（与气泡逐条弹出同拍；Worker 定时器保证后台锁屏也按节奏到达）
    // 静默模式（回端合并）不再重复提醒——系统推送已经弹过了
    if (filteredParts.length > 0 && options?.silent !== true) {
        const isGroup = sess?.isGroup === true;
        const avatar = isGroup
            ? (options?.senderCharacterId
                ? loadCharacters().find(c => c.id === options.senderCharacterId)?.avatar || null
                : null)
            : (sess ? loadCharacters().find(c => c.id === sess.contactId)?.avatar || null : null);
        const bodyPrefix = isGroup && options?.senderName ? `${options.senderName}: ` : "";
        const partBody = (part: ParsedMessagePart) => bodyPrefix + ((part.content || "").trim()
            || (part.mediaType === "image" && part.mediaData?.label ? `发了一张照片: ${part.mediaData.label}` : "发来一条消息"));
        const { sendBrowserNotification } = await import("./browser-notification");
        filteredParts.forEach((part, index) => {
            bgSetTimeout(() => {
                dispatchChatMessageNotice({
                    sessionId,
                    senderName: charName,
                    body: partBody(part).slice(0, 80),
                    avatar,
                    ...(isGroup ? { isGroup: true } : {}),
                });
                sendBrowserNotification(charName, { body: partBody(part).slice(0, 60), icon: avatar || undefined });
            }, index * BACKGROUND_MESSAGE_STAGGER_MS);
        });
    }

    // Emit call trigger event for chat-room to pick up
    if (triggerCall && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ai-call-trigger", { detail: { sessionId, type: triggerCall } }));
    }

    return { hasVisible: true, newCount: currentCount + 1, stateValues };
}
