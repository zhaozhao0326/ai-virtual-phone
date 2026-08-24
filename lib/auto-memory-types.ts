// lib/auto-memory-types.ts
// Auto Memory —— 每个角色独立维护的「认知档案」：角色对用户/世界的长期认知（工作、个人、心头事、
// 历史、背景、指令）。与长期记忆（共同经历）不同，这里记录的是"角色怎么看你/这个世界"，
// 由 AI 在对话中自主判断写入（经用户审批，走既有 memory_write 链路），也可手动编辑。
//
// 借鉴 IB-Mobile 的 Auto Memory（六分类 + 三级优先）：
// - always：核心事实，全档最多 3 条，每轮对话必定注入
// - normal：默认，话题相关时浮现
// - low：仅强相关时浮现

export type AutoMemoryCategory =
    | "work"          // 工作
    | "personal"      // 个人
    | "top_of_mind"   // 心头事
    | "history"       // 历史
    | "background"    // 背景
    | "instructions"; // 指令

export type AutoMemoryPriority = "always" | "normal" | "low";

export type AutoMemoryEntry = {
    id: string;
    characterId: string;
    category: AutoMemoryCategory;
    priority: AutoMemoryPriority;
    content: string;
    createdAt: string;
    updatedAt: string;
    source?: string; // 来源：chat / 手动
};

export const AUTO_MEMORY_CATEGORIES: AutoMemoryCategory[] = [
    "work", "personal", "top_of_mind", "history", "background", "instructions",
];

export const AUTO_MEMORY_CATEGORY_LABELS: Record<AutoMemoryCategory, string> = {
    work: "工作",
    personal: "个人",
    top_of_mind: "心头事",
    history: "历史",
    background: "背景",
    instructions: "指令",
};

export const AUTO_MEMORY_PRIORITY_LABELS: Record<AutoMemoryPriority, string> = {
    always: "核心",
    normal: "常态",
    low: "低优先",
};

/** always 条目全档上限（超出后只注入最新 N 条）。 */
export const AUTO_MEMORY_ALWAYS_MAX = 3;
/** 注入预算（字符数），超预算按优先级 + 相关度裁剪。 */
export const AUTO_MEMORY_DEFAULT_BUDGET = 1200;
