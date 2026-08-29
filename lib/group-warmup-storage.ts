// lib/group-warmup-storage.ts
// 群冷场自动暖场：用户给每个群设一个「冷场频率」（如 6h / 24h），群太久没消息就由群里
// 允许暖场的角色主动说句话暖场；角色有强烈分享欲等特殊触发不受此频率限制，随时可发。
//
// 设计铁律（来自用户需求）：
//  - 总开关默认关（GROUP_WARMUP_ENABLED_KEY=false）；白名单默认空（GROUP_WARMUP_WHITELIST_KEY=[]）。
//    即"选人白名单"模式：只有用户勾选允许暖场的角色才会动，绝不默认全员。
//  - 频率只管「冷太久就兜底暖场」的基线节奏；有互动（任意角色刚发过消息）就不强制触发。
//  - 安静：沿用 idle-reconnect 的轮询范式（心跳节流，非裸定时器狂刷），过安静时段不烧 token。
//
// 照搬 idle-reconnect-storage 的范式，只是把"用户最后消息"换成"群最后一条消息 = 冷场"，
// 且从 1:1 改成群维度（每条规则绑定一个群会话，speakerMode 决定谁来说）。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const GROUP_WARMUP_RULES_KEY = "ai_phone_group_warmup_rules_v1";
export const GROUP_WARMUP_ENABLED_KEY = "ai_phone_group_warmup_enabled_v1";
export const GROUP_WARMUP_WHITELIST_KEY = "ai_phone_group_warmup_whitelist_v1";
registerKvMigration(GROUP_WARMUP_RULES_KEY);
registerKvMigration(GROUP_WARMUP_ENABLED_KEY);
registerKvMigration(GROUP_WARMUP_WHITELIST_KEY);

/** 连发上限：群冷场后角色连续暖场次数（没人接话时）上限，回复后清零 */
export const GROUP_WARMUP_MAX_CONSECUTIVE = 3;

export type GroupWarmupRule = {
    id: string;
    groupSessionId: string;
    /** 本群是否启用冷场暖场（默认 false，符合铁律） */
    enabled: boolean;
    /** 冷场阈值（分钟）：群内多久没消息就算冷场。1 分钟 ~ 72 小时 */
    intervalMinutes: number;
    /** 发言模式："auto"=系统从白名单里挑一位群成员；或指定某角色 characterId */
    speakerMode: "auto" | string;
    /** 用户附加意图（可空） */
    intent?: string;
    /** 自上次群消息以来已连发次数（用于连发上限） */
    consecutiveCount: number;
    /** 上次触发时刻（毫秒） */
    lastFiredAt?: number;
    /** 当前这次被用户停止后，短时间内不再重试 */
    suppressedUntil?: number;
    createdAt: number;
};

// ── 全局总开关 ──
export function loadGroupWarmupEnabled(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return kvGet(GROUP_WARMUP_ENABLED_KEY) === "1";
    } catch {
        return false;
    }
}
export function saveGroupWarmupEnabled(enabled: boolean): void {
    if (typeof window === "undefined") return;
    kvSet(GROUP_WARMUP_ENABLED_KEY, enabled ? "1" : "0");
}

// ── 全局白名单：允许在群里冷场时暖场的角色 characterId ──
export function loadGroupWarmupWhitelist(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(GROUP_WARMUP_WHITELIST_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch {
        return [];
    }
}
export function saveGroupWarmupWhitelist(ids: string[]): void {
    if (typeof window === "undefined") return;
    const uniq = Array.from(new Set(ids.filter((x) => typeof x === "string")));
    kvSet(GROUP_WARMUP_WHITELIST_KEY, JSON.stringify(uniq));
}

function isRule(value: unknown): value is GroupWarmupRule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<GroupWarmupRule>;
    return typeof item.id === "string"
        && typeof item.groupSessionId === "string"
        && typeof item.enabled === "boolean"
        && typeof item.intervalMinutes === "number"
        && typeof item.speakerMode === "string"
        && typeof item.consecutiveCount === "number"
        && typeof item.createdAt === "number";
}

export function loadGroupWarmupRules(): GroupWarmupRule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(GROUP_WARMUP_RULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(isRule) : [];
    } catch {
        return [];
    }
}

function saveRules(rules: GroupWarmupRule[]): void {
    if (typeof window === "undefined") return;
    kvSet(GROUP_WARMUP_RULES_KEY, JSON.stringify(rules.slice(0, 200)));
}

/** 每个群一条规则：同群再建即替换。 */
export function upsertGroupWarmupRule(rule: GroupWarmupRule): void {
    const rest = loadGroupWarmupRules().filter((item) => item.groupSessionId !== rule.groupSessionId);
    saveRules([...rest, rule]);
}

export function removeGroupWarmupRule(groupSessionId: string): void {
    saveRules(loadGroupWarmupRules().filter((item) => item.groupSessionId !== groupSessionId));
}

/** 取某群的规则（无则 undefined） */
export function getGroupWarmupRule(groupSessionId: string): GroupWarmupRule | undefined {
    return loadGroupWarmupRules().find((item) => item.groupSessionId === groupSessionId);
}

/** 记一次触发（本地触发时调用）。 */
export function markGroupWarmupFired(groupSessionId: string, firedAtMs: number): void {
    const rules = loadGroupWarmupRules();
    const rule = rules.find((item) => item.groupSessionId === groupSessionId);
    if (!rule) return;
    if (!rule.lastFiredAt || firedAtMs > rule.lastFiredAt) {
        rule.lastFiredAt = firedAtMs;
        rule.consecutiveCount = Math.min(GROUP_WARMUP_MAX_CONSECUTIVE, rule.consecutiveCount + 1);
        saveRules(rules);
    }
}

/** 用户停止了当前这次冷场生成：不计入连发，只推迟下一次尝试。 */
export function suppressGroupWarmupUntil(groupSessionId: string, untilMs: number): void {
    const rules = loadGroupWarmupRules();
    const rule = rules.find((item) => item.groupSessionId === groupSessionId);
    if (!rule) return;
    rule.suppressedUntil = Math.max(rule.suppressedUntil ?? 0, untilMs);
    saveRules(rules);
}

/** 群里有新消息（任意角色）：连发计数清零，周期重新开始。 */
export function resetGroupWarmupForSession(groupSessionId: string): void {
    const rules = loadGroupWarmupRules();
    const rule = rules.find((item) => item.groupSessionId === groupSessionId);
    if (!rule) return;
    rule.consecutiveCount = 0;
    rule.suppressedUntil = undefined;
    saveRules(rules);
}
