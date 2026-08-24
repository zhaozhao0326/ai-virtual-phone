// lib/auto-memory-service.ts
// Auto Memory 检索与格式化：每个角色独立的「认知档案」注入。
//
// 注入策略（借鉴 IB-Mobile，保持简单可感）：
// 1. always 条目常驻（上限 AUTO_MEMORY_ALWAYS_MAX，超出取最新 N 条）
// 2. 其余条目按「当前上下文关键词命中」相关度排序，在预算内填充
// 3. 无任何条目 → 返回 null，完全不注入（不打扰）
// 4. 命中并注入后，正常/低优先条目的 updatedAt 刷新（用于 always 淘汰的最近原则）

import type { AutoMemoryEntry, AutoMemoryCategory, AutoMemoryPriority } from "./auto-memory-types";
import { AUTO_MEMORY_CATEGORIES, AUTO_MEMORY_CATEGORY_LABELS, AUTO_MEMORY_PRIORITY_LABELS, AUTO_MEMORY_ALWAYS_MAX, AUTO_MEMORY_DEFAULT_BUDGET } from "./auto-memory-types";
import { loadAutoMemoryEntries, saveAutoMemoryEntry } from "./memory-storage";
import { loadCharacters } from "./character-storage";

/** 从上下文里提取关键词（2 字以上中文词 / 3 字符以上英文词）。 */
function extractKeywords(context: string): string[] {
    const kws = new Set<string>();
    const cn = context.match(/[\u4e00-\u9fff]{2,8}/g);
    if (cn) {
        for (const seg of cn) {
            // 2 字词直接收，3+ 字按双字滑动窗口收，避免长句整段命中
            if (seg.length === 2) {
                kws.add(seg);
            } else {
                for (let i = 0; i + 2 <= seg.length && kws.size < 40; i++) {
                    kws.add(seg.slice(i, i + 2));
                }
            }
            if (kws.size >= 40) break;
        }
    }
    const en = context.match(/[a-zA-Z]{3,}/g);
    if (en) {
        for (const w of en.slice(0, 20)) kws.add(w.toLowerCase());
    }
    return Array.from(kws);
}

function relevanceScore(entry: AutoMemoryEntry, keywords: string[]): number {
    if (keywords.length === 0) return 0;
    const hay = entry.content.toLowerCase();
    let hits = 0;
    for (const kw of keywords) {
        if (hay.includes(kw)) hits++;
    }
    return hits / keywords.length;
}

const PRIORITY_ORDER: Record<AutoMemoryPriority, number> = { always: 0, normal: 1, low: 2 };

/**
 * 检索该角色的认知档案（best-effort）。
 * @returns 注入用的格式化文本；无条目或全部裁剪时返回 null（不注入）。
 */
export async function retrieveAutoMemoryForPrompt(
    characterId: string,
    currentContext: string,
): Promise<string | null> {
    const entries = await loadAutoMemoryEntries(characterId);
    if (entries.length === 0) return null;

    const keywords = extractKeywords(currentContext || "");
    const now = Date.now();

    // always 常驻（上限 3，按更新时间取最新）
    const always = entries
        .filter(e => e.priority === "always")
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, AUTO_MEMORY_ALWAYS_MAX);

    const selected = new Set(always.map(e => e.id));
    const picked: AutoMemoryEntry[] = [...always];
    let usedChars = picked.reduce((sum, e) => sum + e.content.length, 0);
    const budget = AUTO_MEMORY_DEFAULT_BUDGET;

    // 其余按 优先级 > 关键词相关度 排序，预算内填充
    const rest = entries
        .filter(e => !selected.has(e.id))
        .map(e => ({ e, rel: relevanceScore(e, keywords) }))
        .sort((a, b) => {
            const pa = PRIORITY_ORDER[a.e.priority];
            const pb = PRIORITY_ORDER[b.e.priority];
            if (pa !== pb) return pa - pb;
            if (b.rel !== a.rel) return b.rel - a.rel;
            return new Date(b.e.updatedAt).getTime() - new Date(a.e.updatedAt).getTime();
        });

    for (const item of rest) {
        const { e, rel } = item;
        if (usedChars + e.content.length > budget) continue;
        // low 优先级且无相关度 → 不注入
        if (e.priority === "low" && rel < 0.02) continue;
        picked.push(e);
        usedChars += e.content.length;
        selected.add(e.id);
    }

    if (picked.length === 0) return null;

    // 命中刷新（仅 normal/low，避免高频写库）：用于 always 淘汰的最近原则
    const touched = picked.filter(e => e.priority !== "always");
    if (touched.length > 0) {
        const ts = new Date(now).toISOString();
        for (const e of touched) {
            const updated: AutoMemoryEntry = { ...e, updatedAt: ts };
            saveAutoMemoryEntry(updated).catch(() => { /* best-effort */ });
        }
    }

    return formatAutoMemoryPrompt(picked);
}

/** 把条目拼成注入段落（按分类分组，带标签）。 */
export function formatAutoMemoryPrompt(entries: AutoMemoryEntry[]): string {
    const lines: string[] = [];
    for (const cat of AUTO_MEMORY_CATEGORIES) {
        const items = entries.filter(e => e.category === cat);
        if (items.length === 0) continue;
        lines.push(`【${AUTO_MEMORY_CATEGORY_LABELS[cat]}】`);
        for (const e of items) {
            const tag = e.priority === "always" ? `[核心]` : e.priority === "low" ? `[低优先]` : "";
            lines.push(`- ${tag}${e.content.trim()}`);
        }
    }
    return lines.join("\n");
}

/** 编辑档案条目（UI 用）。 */
export async function upsertAutoMemoryEntry(input: {
    id?: string;
    characterId: string;
    category: AutoMemoryCategory;
    priority: AutoMemoryPriority;
    content: string;
    source?: string;
}): Promise<AutoMemoryEntry> {
    const now = new Date().toISOString();
    const entry: AutoMemoryEntry = {
        id: input.id || `am_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId: input.characterId,
        category: input.category,
        priority: input.priority,
        content: input.content.trim(),
        createdAt: input.id ? "" : now,
        updatedAt: now,
        source: input.source || "manual",
    };
    // 编辑已有条目时保留 createdAt
    if (!input.id) {
        entry.createdAt = now;
    } else {
        const existing = (await loadAutoMemoryEntries(input.characterId)).find(e => e.id === input.id);
        entry.createdAt = existing?.createdAt || now;
    }
    await saveAutoMemoryEntry(entry);
    return entry;
}

/** 角色名辅助（供 UI 显示）。 */
export function resolveCharacterName(characterId: string): string {
    try {
        return loadCharacters().find(c => c.id === characterId)?.name?.trim() || characterId;
    } catch {
        return characterId;
    }
}

export { AUTO_MEMORY_CATEGORY_LABELS, AUTO_MEMORY_PRIORITY_LABELS };
