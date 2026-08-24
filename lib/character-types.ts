/** 关系成长阶段：角色与用户关系的自然进阶（人设优先，随机应变） */
export type RelationshipStage = "初识" | "熟悉" | "亲近" | "羁绊";

export type Character = {
  id: string;
  name: string;
  avatar: string | null; // data URL 或外部 URL
  persona: string;       // 人设
  appearance?: string;   // 生图形象：用于 AI 生图时描述该角色长什么样（性别/发型/衣着等），让"谁是谁"更可控
  briefPersona?: string; // 简量版人设：注入到同世界有关系角色的「角色关系」marker，供对方了解 TA（防 OOC）
  briefPersonaUpdatedAt?: string; // 简介生成时间；早于 updatedAt 时编辑器提示「设定已更新，建议重新生成」
  personaProfile?: string; // 主动深挖的结构化人设档案（JSON 字符串，见 brief-persona.ts generateDeepDivePersona）；注入到该角色自己的扮演上下文，锚定底盘但保持弹性
  wechatID?: string;     // 手机号格式的微信号
  birthday?: string;     // 生日 MM-DD（如 "03-15"）；日历在生日当天显示提示
  personality?: string;    // 角色性格
  timeZone?: string;       // IANA 时区，例如 America/New_York；空值表示跟随系统时间
  tags?: string[];
  createdAt: string;
  updatedAt: string;

  // 画布坐标与渲染属性
  canvasX?: number;
  canvasY?: number;
  canvasRot?: number;
  canvasZIndex?: number;
  polaroidStyle?: number; // 用户选择的拍立得样式索引

  // 关系成长档案（角色与用户一起成长）
  // 缺省 = 开启；false = 该角色不显示/不注入关系成长（人设优先，随机应变）
  relationshipGrowthEnabled?: boolean;
  // 初始关系阶段：缺省 = 自动（按相识天数+共同经历累计成长）；
  // 设定具体阶段则直接以该阶段起步（如人设里就是情侣 → 设「羁绊」）
  initialRelationshipStage?: RelationshipStage;
};

export type CanvasBgItem = {
  id: string;
  type: 'a4' | 'yellow-note' | 'blue-note' | 'torn' | 'grid' | 'scrap';
  x: number;
  y: number;
  rot: number;
  zIndex: number;
  worldId?: string; // 所属世界画布；缺省 = 默认世界（存量数据零迁移）
};
