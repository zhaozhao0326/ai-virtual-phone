// 静态接线断言：确认"建群 function calling"两端都接上了。
// 不依赖浏览器/IndexedDB，纯读源码做确定性校验。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const capFile = ROOT + "lib/internal-capability-storage.ts";
const execFile = ROOT + "lib/tool-executor.ts";

let failed = 0;
function check(label, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail ? "  -> " + detail : ""}`);
}

if (!existsSync(capFile) || !existsSync(execFile)) {
  console.error("源码文件缺失");
  process.exit(2);
}

const cap = readFileSync(capFile, "utf8");
const exec = readFileSync(execFile, "utf8");

// ── 端 1：能力注册（AI 会被提示词告知可建群）──
check("能力 ID 已导出", cap.includes('export const GROUP_CREATE_CAPABILITY_ID = "group_create"'));
check("BUILTIN 中注册且 enabled:true",
  /id:\s*GROUP_CREATE_CAPABILITY_ID[\s\S]*?enabled:\s*true/.test(cap) &&
  cap.includes('name: "创建群聊"'));
check("getInternalCapabilityToolDefinition 有 GROUP_CREATE 分支",
  cap.includes("if (capability.id === GROUP_CREATE_CAPABILITY_ID)"));
check("usageGuide 含建群动作示例 [执行动作:创建群聊(...)]",
  cap.includes("[执行动作:创建群聊("));
check("usageGuide 说明发起角色为群主/用户被拉入",
  cap.includes("发起角色自动成为群主") && cap.includes("把用户拉进去"));

// ── 端 2：派发链路（调用落到 applyAIProactiveGroupCreate）──
check("tool-executor 引入 applyAIProactiveGroupCreate",
  exec.includes('import { applyAIProactiveGroupCreate } from "./group-admin"'));
check("executeInternalTool 有 创建群聊 分发分支",
  exec.includes('if (call.name === "创建群聊") return executeCreateGroupTool(call, context)'));
check("定义了 executeCreateGroupTool 处理函数",
  exec.includes("async function executeCreateGroupTool"));
check("处理函数调用 applyAIProactiveGroupCreate",
  exec.includes("applyAIProactiveGroupCreate(actorCharacterId"));

console.log("");
if (failed === 0) {
  console.log("ALL PASS — 建群 function calling 两端接线确认完成。");
  process.exit(0);
} else {
  console.log(`${failed} 项未通过。`);
  process.exit(1);
}
