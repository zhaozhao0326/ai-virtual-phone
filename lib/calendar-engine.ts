import type { Character } from "./character-types";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import type { AssemblerInput, LLMMessage } from "./llm-prompt-assembler";
import type { CalendarOwnerType, CalendarScheduleItem } from "./calendar-types";
import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadWorldBooks,
  loadRegexes,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { getCustomStickerExample, getCustomStickerNames } from "./custom-sticker-storage";
import { previewMessagesForApi, sendLLMRequest, type ChatEngineError } from "./chat-engine";
import { buildCalendarScheduleMarker, clearGeneratedWeekItems, cloneWeekPlanWithManualEdits, normalizeGeneratedScheduleItems, restoreCalendarWeekItems } from "./calendar-storage";
import {
  getWeekDates,
  getWeekStartIso,
  getWeekdayLabel,
  isCalendarTimeRangeAllowed,
  normalizeTime,
  parseIsoDate,
  sanitizeScheduleEmoji,
} from "./calendar-utils";

type CalendarAssemblerResolved = {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  llmMessages: LLMMessage[];
  ownerName: string;
};

function buildSyntheticUserCharacter(identity: UserIdentity | null): Character {
  const now = new Date().toISOString();
  const personaLines = [
    identity?.bio?.trim(),
    identity?.occupation ? `职业：${identity.occupation}` : "",
    identity?.age ? `年龄：${identity.age}` : "",
    identity?.gender && identity.gender !== "保密" ? `性别：${identity.gender}` : "",
    identity?.customSettings?.trim(),
  ].filter(Boolean);

  return {
    id: "__calendar_user__",
    name: identity?.name?.trim() || "用户",
    avatar: identity?.avatarUrl || null,
    persona: personaLines.join("\n") || "这是用户本人。",
    wechatID: "",
    createdAt: now,
    updatedAt: now,
  };
}

function buildCalendarTriggerInstruction(ownerName: string, dates: string[], birthday?: string): string {
    const birthdayLine = (() => {
        if (!birthday) return "";
        const b = birthday.trim();
        if (!/^\d{1,2}-\d{1,2}$/.test(b)) return "";
        const [m, d] = b.split("-").map(Number);
        const bIso = `${new Date().getFullYear()}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        return dates.includes(bIso)
            ? `注意：${bIso} 是 ${ownerName} 的生日，这一天请安排生日相关的事项（如庆祝、聚餐、收到祝福等）。`
            : "";
    })();
    if (dates.length === 1) {
        return [
            `请为${ownerName}生成 ${dates[0]} 这一天的日程安排。`,
            birthdayLine,
            "每行一条，格式：YYYY-MM-DD|周几|开始时间|结束时间|地点|emoji|事项。emoji 段填一个最贴合该事项的表情符号。",
            "作息时间不受限制（早起、夜跑、通宵都可以安排），但最多 5 条日程，宁缺毋滥。",
        ].filter(Boolean).join("\n");
    }
    return [
        `请为${ownerName}生成 ${dates[0]} 到 ${dates[dates.length - 1]} 这一周的日程安排。`,
        "请参考已有日程，生成这一周的完整日程安排。",
        birthdayLine,
        "每行一条，格式：YYYY-MM-DD|周几|开始时间|结束时间|地点|emoji|事项。emoji 段填一个最贴合该事项的表情符号。",
        "作息时间不受限制（早起、夜跑、通宵都可以安排），但每一天最多 5 条日程，宁缺毋滥。",
    ].filter(Boolean).join("\n");
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
}

function parseScheduleLines(rawText: string, weekStart: string, focusDates?: Set<string>): CalendarScheduleItem[] {
    const weekDates = new Set(getWeekDates(weekStart));
    const lines = stripCodeFences(rawText)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const parsed: Array<{
        date: string;
        startTime: string;
        endTime: string;
        location: string;
        title: string;
        emoji?: string;
    }> = [];

    for (const rawLine of lines) {
        const line = rawLine
            .replace(/^[-*]\s*/, "")
            .replace(/^\d+[.)、]\s*/, "")
            .trim();
        if (!line.includes("|")) continue;
        const parts = line.split("|").map(part => part.trim());
        if (parts.length < 6) continue;

        const date = parts[0];
        const startTime = normalizeTime(parts[2]);
        const endTime = normalizeTime(parts[3]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !weekDates.has(date)) continue;
        if (focusDates && !focusDates.has(date)) continue;
        if (!startTime || !endTime || !isCalendarTimeRangeAllowed(startTime, endTime)) continue;

        const location = parts[4] === "无" ? "" : parts[4];
        // 新格式第 6 段为 emoji（YYYY-MM-DD|周几|开始|结束|地点|emoji|事项）；
        // 兼容旧格式（第 6 段直接是事项）：仅当该段确实是 emoji 时才按新格式取。
        let emoji = "";
        let title: string;
        if (parts.length >= 7) {
            const candidate = sanitizeScheduleEmoji(parts[5]);
            if (candidate && Array.from(parts[5]).length <= 3) {
                emoji = candidate;
                title = parts.slice(6).join("|");
            } else {
                title = parts.slice(5).join("|");
            }
        } else {
            title = parts[5];
        }
        if (!title.trim()) continue;

        parsed.push({
            date,
            startTime,
            endTime,
            location,
            title,
            emoji,
        });
    }

    return normalizeGeneratedScheduleItems(parsed);
}

async function resolveCalendarAssemblerInput(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<CalendarAssemblerResolved> {
  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, ownerType === "character" ? ownerId : undefined, "calendar");

  if (!activeSlot.apiConfigId) {
    throw new Error("未绑定日历 API，请先在配置绑定中为日历设置 API。");
  }

  const apiConfigs = loadApiConfigs();
  const apiConfig = apiConfigs.find(entry => entry.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new Error("日历 API 配置不存在。");
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find(entry => entry.id === activeSlot.presetId) ?? null : null;
  if (!preset) preset = presets.find(entry => entry.builtIn) ?? null;

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map(id => allWorldBooks.find(entry => entry.id === id))
    .filter(Boolean) as WorldBookConfig[];

  const allRegexes = loadRegexes();
  const regexes = (activeSlot.regexIds || [])
    .map(id => allRegexes.find(entry => entry.id === id))
    .filter(Boolean) as RegexConfig[];

  const userIdentity = resolveUserIdentity(ownerType === "character" ? ownerId : undefined, "calendar");
  const character =
    ownerType === "character"
      ? loadCharacters().find(entry => entry.id === ownerId)
      : buildSyntheticUserCharacter(resolveUserIdentity(undefined, "calendar"));

  if (!character) {
    throw new Error("日历目标不存在。");
  }

  const memConfig = loadMemoryConfig();
  let coreMemories = "";
  let longTermMemories = "";
  let recentBlocks: import("./short-term-assembler").RecentBlock[] = [];
  let unifiedRecentItems: import("./short-term-assembler").UnifiedRecentItem[] = [];
  let wbActivationContext = "";

  if (ownerType === "character") {
    const prepared = prepareShortTermContext(ownerId, "calendar", { history: [] });
    recentBlocks = prepared.recentBlocks;
    unifiedRecentItems = prepared.unifiedRecentItems;
    wbActivationContext = prepared.wbActivationContext;
    const [coreResults, longResults] = await Promise.all([
      retrieveCoreMemoriesForPrompt(ownerId, memConfig).catch(() => []),
      retrieveMemoriesForPrompt(ownerId, wbActivationContext, memConfig).catch(() => []),
    ]);
    coreMemories = formatCoreMemories(coreResults);
    longTermMemories = formatLongTermMemories(longResults);
  }

  const scheduleSummary = buildCalendarScheduleMarker(ownerType, ownerId, weekStart);
  const llmMessages = assemblePromptPayload({
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "calendar",
    scheduleSummary,
    coreMemories,
    longTermMemories,
    worldBookActivationContext: wbActivationContext || undefined,
    recentBlocks,
    unifiedRecentItems,
    customStickerNames: ownerType === "character" ? getCustomStickerNames(ownerId) : "",
    customStickerExample: ownerType === "character" ? getCustomStickerExample(ownerId) : "",
  } as AssemblerInput);

  return {
    apiConfig,
    preset,
    regexes,
    llmMessages,
    ownerName: character.name,
  };
}

/**
 * 内部：按日期范围生成日程。days=7 为周日程，days=1 为单日日程。
 * focusDates：限定生成结果保留的日期集合（默认取 weekStart 起 days 天）。
 * 失败时自动回滚已移除的旧 AI 生成条目。
 */
async function generateScheduleForRange(
    ownerType: CalendarOwnerType,
    ownerId: string,
    weekStart: string,
    days: number,
    focusDates?: Set<string>,
): Promise<{ success: boolean; error?: string; items?: CalendarScheduleItem[] }> {
    if (ownerType !== "character") {
        return { success: false, error: "用户日程不支持 AI 生成，请手动填写。" };
    }
    // 先清掉本周旧的 AI 生成条目（保留手动条目），让随后的 marker 组装读不到旧结果——
    // 否则旧日程会进提示词被模型原样照抄，"重新生成"永远一字不差。失败时恢复。
    const removedGenerated = clearGeneratedWeekItems(ownerType, ownerId, weekStart);
    const restoreRemoved = () => restoreCalendarWeekItems(ownerType, ownerId, weekStart, removedGenerated);
    try {
        const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart);
        const allWeekDates = getWeekDates(weekStart);
        const targetDates = (focusDates && focusDates.size > 0)
            ? allWeekDates.filter(d => focusDates.has(d))
            : allWeekDates.slice(0, days);
        if (targetDates.length === 0) {
            restoreRemoved();
            return { success: false, error: "没有有效的目标日期。" };
        }
        const birthday = ownerType === "character"
            ? loadCharacters().find(c => c.id === ownerId)?.birthday
            : undefined;
        const triggerInstruction = buildCalendarTriggerInstruction(resolved.ownerName, targetDates, birthday);

        const messages: LLMMessage[] = [
            ...resolved.llmMessages,
            {
                role: "user",
                content: triggerInstruction,
                _debugMeta: { marker: "calendar_trigger" },
            },
        ];

        const rawText = await sendLLMRequest(
            resolved.apiConfig,
            resolved.preset,
            messages,
            resolved.regexes,
            { characterName: `日历:${resolved.ownerName}` },
            { appId: "calendar", appTags: ["calendar"] },
        );

        const items = parseScheduleLines(rawText, weekStart, new Set(targetDates));
        if (items.length === 0) {
            restoreRemoved();
            return { success: false, error: "日历生成结果为空，或格式无法解析。" };
        }

        cloneWeekPlanWithManualEdits(ownerType, ownerId, weekStart, items);
        return { success: true, items };
    } catch (error) {
        restoreRemoved();
        const err = error as ChatEngineError | Error;
        return { success: false, error: err?.message || "生成日历失败" };
    }
}

export async function generateWeeklyCalendarSchedule(
    ownerType: CalendarOwnerType,
    ownerId: string,
    weekStart: string,
): Promise<{ success: boolean; error?: string; items?: CalendarScheduleItem[] }> {
    return generateScheduleForRange(ownerType, ownerId, weekStart, 7);
}

/** 生成指定一天的角色日程（保持本周其他日期不变，仅覆盖该日） */
export async function generateDailyCalendarSchedule(
    ownerType: CalendarOwnerType,
    ownerId: string,
    date: string, // YYYY-MM-DD
): Promise<{ success: boolean; error?: string; items?: CalendarScheduleItem[] }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { success: false, error: "日期格式无效。" };
    }
    const weekStart = getWeekStartIso(parseIsoDate(date));
    return generateScheduleForRange(ownerType, ownerId, weekStart, 1, new Set([date]));
}

export async function previewCalendarPromptPayload(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  if (ownerType !== "character") {
    throw new Error("用户日程不支持 AI 生成预览。");
  }
  const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart);
  const weekDates = getWeekDates(weekStart);
  const triggerInstruction = buildCalendarTriggerInstruction(resolved.ownerName, weekDates);

  const messages: LLMMessage[] = [
    ...resolved.llmMessages,
    {
      role: "user",
      content: triggerInstruction,
      _debugMeta: { marker: "calendar_trigger" },
    },
  ];

  const apiMessages = previewMessagesForApi(resolved.apiConfig, resolved.preset, messages);
  return {
    messages: apiMessages,
    characterName: `日历:${resolved.ownerName}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "(无预设)",
  };
}

export function createDefaultScheduleDraft(date: string) {
  return {
    date,
    weekday: getWeekdayLabel(date),
    startTime: "09:00",
    endTime: "10:00",
    location: "",
    title: "",
    emoji: "",
    source: "manual" as const,
  };
}

export function getCurrentWeekStart(): string {
  return getWeekStartIso(new Date());
}
