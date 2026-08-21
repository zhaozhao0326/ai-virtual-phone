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
  chatRoom.includes('const applied = applyAIGroupAdminAction(r.characterId, part.mediaData)'));
check("applyAIGroupAdminAction 对 dissolve 有分支",
  chatRoom.includes('action === "dissolve"'));

// ── function calling 备用路径（已保留）──
check("能力 ID 已导出", cap.includes('export const GROUP_CREATE_CAPABILITY_ID = "group_create"'));
check("tool-executor 引入 applyAIProactiveGroupCreate",
  exec.includes('import { applyAIProactiveGroupCreate } from "./group-admin"'));
check("executeInternalTool 有 创建群聊 分发分支",
  exec.includes('if (call.name === "创建群聊") return executeCreateGroupTool(call, context)'));

console.log("");
if (failed === 0) {
  console.log("ALL PASS — 建群/解散关键接线确认完成。");
  process.exit(0);
} else {
  console.log(`${failed} 项未通过。`);
  process.exit(1);
}
