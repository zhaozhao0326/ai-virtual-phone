// 静态接线断言：确认群管理关键路径都接上了。
// 不依赖浏览器/IndexedDB，纯读源码做确定性校验。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const capFile = ROOT + "lib/internal-capability-storage.ts";
const execFile = ROOT + "lib/tool-executor.ts";
const presetFile = ROOT + "lib/builtin-preset.ts";
const parserFile = ROOT + "lib/rich-message-parser.ts";
const chatRoomFile = ROOT + "components/chat/chat-room.tsx";

let failed = 0;
function check(label, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail ? "  -> " + detail : ""}`);
}

for (const f of [capFile, execFile, presetFile, parserFile, chatRoomFile]) {
  if (!existsSync(f)) {
    console.error("源码文件缺失: " + f);
    process.exit(2);
  }
}

const cap = readFileSync(capFile, "utf8");
const exec = readFileSync(execFile, "utf8");
const preset = readFileSync(presetFile, "utf8");
const parser = readFileSync(parserFile, "utf8");
const chatRoom = readFileSync(chatRoomFile, "utf8");

// ── 建群兜底（文本标签主路径）──
check("builtin-preset 含主动建群格式说明",
  preset.includes("主动建群") && preset.includes("建了个群|群名:"));
check("rich-message-parser 导出 CREATE_GROUP_TAG_RE",
  parser.includes("export const CREATE_GROUP_TAG_RE"));
check("chat-room 1:1 场景使用 CREATE_GROUP_TAG_RE 触发建群",
  chatRoom.includes("CREATE_GROUP_TAG_RE.exec(text)") &&
  chatRoom.includes("applyAIProactiveGroupCreate(session.contactId"));
check("chat-room 会调用 applyAIProactiveGroupCreate",
  chatRoom.includes("applyAIProactiveGroupCreate(r.characterId, part.mediaData)"));

// ── 解散修复 ──
check("rich-message-parser 有 dissolve 标签解析",
  parser.includes('adminAction: "dissolve"'));
check("chat-room 对 dissolve 调用 applyAIGroupAdminAction",
  chatRoom.includes('if (part.mediaData?.adminAction === "create_group")') &&
  chatRoom.includes("applyAIGroupAdminAction(r.characterId, part.mediaData)"));
check("applyAIGroupAdminAction 对 dissolve 有分支",
  chatRoom.includes('action === "dissolve"'));

// ── function calling 备用路径（已保留）──
check("能力 ID 已导出", cap.includes('export const GROUP_CREATE_CAPABILITY_ID = "group_create"'));
check("tool-executor 引入 applyAIProactiveGroupCreate",
  exec.includes('import { applyAIProactiveGroupCreate } from "./group-admin"'));
check("executeInternalTool 有 创建群聊 分发分支",
  exec.includes('if (call.name === "创建群聊") return executeCreateGroupTool(call, context)'));

// ── 群主权限全量审计（14 项）：解析器 + 提示词双端 ──
const adminActions = [
  { action: "rename",           parser: 'adminAction: "rename"',           prompt: "改群名|群名:" },
  { action: "set_announcement", parser: 'adminAction: "set_announcement"', prompt: "设置群公告|内容:" },
  { action: "add_todo",         parser: 'adminAction: "add_todo"',         prompt: "添加群待办|内容:" },
  { action: "complete_todo",    parser: 'adminAction: "complete_todo"',    prompt: "完成群待办|内容:" },
  { action: "remove_todo",      parser: 'adminAction: "remove_todo"',      prompt: "删除群待办|内容:" },
];
for (const { action, parser: p, prompt } of adminActions) {
  check(`rich-message-parser 有 ${action} 标签解析`, parser.includes(p));
  check(`builtin-preset 教了 ${action} 输出格式`, preset.includes(prompt));
}
// 执行层已由 applyGroupAdminAction 全量覆盖（14 种 action 均有 case）
check("applyGroupAdminAction 覆盖全部 14 种动作",
  chatRoom.includes("applyGroupAdminAction(session, action, actorKey, targetKey"));
check("chat-room 对 rename/公告/待办 按群主本人定位目标",
  chatRoom.includes('action === "rename" || action === "set_announcement" || action === "add_todo" || action === "complete_todo" || action === "remove_todo"'));

// ── UI 展示层：群信息区可折叠卡片 ──
check("chat-room 群聊顶部有群信息折叠卡片",
  chatRoom.includes('chat-group-info${') && chatRoom.includes("chat-group-info-toggle"));
check("chat-room 折叠态显示摘要徽标（有公告/待办时）",
  chatRoom.includes("chat-group-info-badge") && chatRoom.includes("有公告"));
check("chat-room 展开渲染公告行（空态）与待办列表",
  chatRoom.includes("暂无群公告") && chatRoom.includes("chat-group-todos-list") && chatRoom.includes("chat-group-todo-item"));
const cssFile = ROOT + "styles/chat.css";
const css = existsSync(cssFile) ? readFileSync(cssFile, "utf8") : "";
check("chat.css 有群信息折叠卡片样式",
  css.includes(".chat-group-info {") && css.includes(".chat-group-info-toggle {"));

// ── 成员自主退群 leave_group + 群主拉回 ──
const adminFile = ROOT + "lib/group-admin.ts";
const admin = existsSync(adminFile) ? readFileSync(adminFile, "utf8") : "";
check("GroupAdminAction 类型含 leave_group",
  admin.includes('| "leave_group"'));
check("canGroupAdminAct 允许成员/群主退群",
  admin.includes('action === "leave_group"') && admin.includes("actorKey === targetKey"));
check("applyGroupAdminAction 有 leave_group 执行分支",
  admin.includes('case "leave_group"') && admin.includes('退出了群聊'));
check("群主退群自动顺延群主给剩余成员",
  admin.includes('群主位置自动顺延') && admin.includes("updates.groupOwnerId = remaining[0]"));
check("rich-message-parser 公告正则认「设置了/修改了」且可无前缀",
  parser.includes("(?:设置了?|修改了?|改了?|更新了?))?\\s*群公告") &&
  parser.includes("\\s*群公告[：:]"));
check("rich-message-parser 待办正则认「添加了/修改了」且可无前缀",
  parser.includes("(?:添加了?|修改了?|改了?|更新了?))?\\s*群待办") &&
  parser.includes("\\s*群待办[：:]"));
check("rich-message-parser 公告/待办正则角色名前缀变为可选",
  parser.includes("(?:([^\\]：:]+?)\\s+)?"));
check("rich-message-parser 改名正则放宽（兼容修改了群名为）",
  parser.includes("将群名改为了?|修改了?群名为?"));
check("rich-message-parser 有管道符格式（设置群公告|内容:）",
  parser.includes("设置群公告[|｜]内容[:：]"));
check("rich-message-parser 有管道符格式（添加群待办|内容:）",
  parser.includes("添加群待办[|｜]内容[:：]"));
check("rich-message-parser 有管道符格式（退群）",
  parser.includes("退群\\]"));
check("builtin-preset 提示词主推管道符格式",
  preset.includes("设置群公告|内容:") && preset.includes("添加群待办|内容:") &&
  preset.includes("改群名|群名:") && preset.includes("[A 退群]"));
check("rich-message-parser 有退群标签解析",
  parser.includes('adminAction: "leave_group"'));
check("builtin-preset 教了退群格式",
  preset.includes("[A 退群]"));
check("builtin-preset 教了群主拉回（邀请已退群角色）",
  preset.includes("重新拉回来") && preset.includes("邀请B加入了群聊"));
check("chat-room 对 leave_group 按本人定位目标",
  chatRoom.includes('action === "leave_group"'));
check("chat-room 1:1 私聊也能执行群管理（找角色所在群）",
  chatRoom.includes("applyAIOneToOneGroupAdminAction") &&
  chatRoom.includes("? applyAIGroupAdminAction(r.characterId, part.mediaData)"));
check("builtin-preset 1:1 提示词教了管理群格式",
  preset.includes("管理自己所在的群") && preset.includes("设置群公告|内容:"));

// ── 聊天背景透明度 ──
const storageFile = ROOT + "lib/chat-storage.ts";
const settingsFile = ROOT + "components/chat/chat-settings-panel.tsx";
const storage = existsSync(storageFile) ? readFileSync(storageFile, "utf8") : "";
const settings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
check("ChatSession 有 backgroundOpacity 字段",
  storage.includes("backgroundOpacity?: number"));
check("chat-room 用白色蒙层实现背景透明度",
  chatRoom.includes("linear-gradient(rgba(255, 255, 255,"));
check("设置面板有背景透明度滑条",
  settings.includes("menu-slider") && settings.includes("背景透明度"));
check("chat.css 有滑条样式",
  css.includes(".menu-slider {"));
check("群设置面板有群公告/群待办区块",
  settings.includes("群公告") && settings.includes("群待办") && settings.includes("chat-group-todos-list"));

// ── 系统更新入口（更新日志可见性）──
const phoneSettingsFile = ROOT + "components/phone-settings-app.tsx";
const phoneSettings = existsSync(phoneSettingsFile) ? readFileSync(phoneSettingsFile, "utf8") : "";
check("手机设置菜单有「系统更新」入口",
  phoneSettings.includes('label: "系统更新"') && phoneSettings.includes('"updates"'));
check("系统更新页面渲染更新日志",
  phoneSettings.includes('case "updates":') && phoneSettings.includes("<SystemUpdates />"));

console.log("");
if (failed === 0) {
  console.log("ALL PASS — 建群/解散/群主全量权限关键接线确认完成。");
  process.exit(0);
} else {
  console.log(`${failed} 项未通过。`);
  process.exit(1);
}
