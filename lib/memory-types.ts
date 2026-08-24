// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

/** 关系实体类型：人物 / 地点 / 事物 / 事件 / 概念 */
export type MemoryRelationEntityType = "person" | "place" | "thing" | "event" | "concept";

/**
 * 关系事实：一条记忆涉及的「关系维度」。
 * 用于关系图谱召回——把与同一实体（人物/地点…）相关的记忆关联起来，
 * 即使语义向量相似度不高，也能在对话提到该实体时被一并召回。
 * confidence 用于过滤玩笑、比喻、一次性情绪等不可信关系。
 */
export type MemoryRelation = {
    entity: string;                    // 实体名，如 "小明" / "公司楼下咖啡馆"
    entityType: MemoryRelationEntityType;
    relation: string;                  // 与角色/上下文的关系，简短，如 "用户弟弟" / "常去地点"
    confidence: number;                // 0-1，对该关系真实、稳定的置信度
};

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    /** 关系图谱维度：该记忆涉及的人物/地点/事物等关系事实（长期记忆抽取，可选） */
    relations?: MemoryRelation[];
    /** 情感坐标（可选，0-1）：valence=情绪效价(0消极~1积极)，arousal=唤醒度(0平静~1强烈)。
     *  高唤醒记忆在召回时权重更高；缺省按中性处理，老记忆无需迁移。 */
    valence?: number;
    arousal?: number;
    /** 是否已解决。未解决的记忆衰减更慢、更容易被想起（如未化解的约定/矛盾）。缺省 false */
    resolved?: boolean;
    /** 被召回激活次数与最近激活时间：软饱和（激活越多权重趋稳）+ 反疲劳（2h 内高频激活降权）。可选 */
    activationCount?: number;
    lastActivated?: string;
    metadata?: Record<string, unknown>;
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    relationRecallEnabled: boolean;         // whether relationship-graph recall is used (boost memories sharing entities with the context)
    relationMinConfidence: number;          // min confidence threshold (0-1) for extracted relations; filters jokes/metaphors
    maxLongTermEntries: number;
    maxCoreEntries: number;                 // cap on core memories; oldest are merged when exceeded
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 用第三人称描述{{char}}和用户之间的互动
- 保留关键事实：提到的名字、做出的承诺、情感变化、关系里程碑
- 保留用户分享的具体信息（生日、偏好、习惯）
- 保留朋友圈等非聊天事件中的关键信息
- 100-200字
- 不要包含格式标记

总结：`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 保留角色标志性的口头禅、语气词、说话节奏与风格特征（人设"活"的关键，不可省略）
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    relationRecallEnabled: true,
    relationMinConfidence: 0.6,
    maxLongTermEntries: 500,
    maxCoreEntries: 50,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
    },
};
