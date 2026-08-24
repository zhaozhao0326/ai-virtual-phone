// lib/relationship-growth.ts
// 关系成长档案：角色与用户「一起成长」的显性度量。
// 复用现有数据（角色创建时间 + 记忆条数），纯增量、无新存储、无写路径。
// 阶段判定双维度：相识天数（创建至今）+ 共同经历条数（core + long_term 记忆）。

import { loadCharacters } from "./character-storage";
import { getMemoryCountByType } from "./memory-storage";
import type { Character, RelationshipStage } from "./character-types";

export type { RelationshipStage };

export type RelationshipGrowth = {
  daysKnown: number; // 相识天数（角色创建至今）
  memoryCount: number; // 共同经历条数（core + long_term）
  stage: RelationshipStage;
  stageIndex: number; // 0-3
  progress: number; // 0-1，向下一阶段的推进度（卡在最慢的那个维度上）
  nextStage: RelationshipStage | null;
};

const STAGE_ORDER: RelationshipStage[] = ["初识", "熟悉", "亲近", "羁绊"];

// 各阶段的门槛（天数 / 记忆条数，需同时满足）
const STAGE_THRESHOLDS: Array<{ days: number; memories: number }> = [
  { days: 2, memories: 3 }, // →熟悉
  { days: 7, memories: 8 }, // →亲近
  { days: 30, memories: 20 }, // →羁绊
];

function stageFor(days: number, memories: number): number {
  let idx = 0;
  for (const t of STAGE_THRESHOLDS) {
    if (days >= t.days && memories >= t.memories) idx += 1;
    else break;
  }
  return idx;
}

export async function computeRelationshipGrowth(
  character: Character | string,
): Promise<RelationshipGrowth | null> {
  const char = typeof character === "string"
    ? loadCharacters().find(c => c.id === character) ?? null
    : character;
  if (!char) return null;

  // 用户级开关：该角色关闭关系成长 → 不计算、不展示、不注入（人设优先，随机应变）
  if (char.relationshipGrowthEnabled === false) return null;

  const createdAt = char.createdAt ? new Date(char.createdAt).getTime() : Date.now();
  const daysKnown = Math.max(0, Math.floor((Date.now() - createdAt) / 86_400_000));
  const [coreCount, longTermCount] = await Promise.all([
    getMemoryCountByType(char.id, "core"),
    getMemoryCountByType(char.id, "long_term"),
  ]);
  const memoryCount = coreCount + longTermCount;

  // 初始关系阶段：人设设定具体阶段则直接以该阶段起步（不强制从「初识」涨起）
  const initialIdx = char.initialRelationshipStage ? STAGE_ORDER.indexOf(char.initialRelationshipStage) : -1;
  const autoIdx = stageFor(daysKnown, memoryCount);
  const stageIndex = Math.max(initialIdx, autoIdx);
  const stage = STAGE_ORDER[Math.min(stageIndex, STAGE_ORDER.length - 1)];
  const nextStage = stageIndex < 3 ? STAGE_ORDER[stageIndex + 1] : null;

  let progress = 1;
  if (nextStage) {
    const t = STAGE_THRESHOLDS[Math.min(stageIndex, STAGE_THRESHOLDS.length - 1)];
    const dayRatio = Math.min(1, daysKnown / t.days);
    const memRatio = Math.min(1, memoryCount / t.memories);
    progress = Math.min(dayRatio, memRatio); // 卡在最慢的维度上
  }

  return { daysKnown, memoryCount, stage, stageIndex, progress, nextStage };
}

/** 轻量关系阶段背景（注入 prompt 用）：不给死板指令，只给背景，保持角色演绎弹性 */
export function relationshipStagePromptLine(growth: RelationshipGrowth): string {
  const base = `你和{{user}}的关系：${growth.stage}（相识约 ${growth.daysKnown} 天，共同经历约 ${growth.memoryCount} 件事）`;
  return base;
}
