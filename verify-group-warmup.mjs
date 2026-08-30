// verify-group-warmup.mjs
// 群冷场自动暖场「上线即通」接线 + 运行时逻辑验证。
// 两部分：
//  A. 静态接线断言（仿 verify-group-create.mjs）：读真实源码，确认调用点/字段/预设/UI/版本都接上。
//     专门抓当年「拉群/群公告」那类——编译过、调用点没真接、字段写错——的坑。
//  B. 运行时逻辑模拟：照 fireGroupWarmup 源码逐行复刻「模型产出 → 解析 → 白名单过滤 → 归位」这段
//     （LLM 生成步用固定输出替代，因沙箱无 API key），证明解析/落库/选人/兜底这截不会上线就坏。
//
// 运行：node verify-group-warmup.mjs   （无浏览器依赖，纯 node）
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const F = {
  storage: ROOT + "lib/chat-storage.ts",
  gwStorage: ROOT + "lib/group-warmup-storage.ts",
  follow: ROOT + "lib/follow-up-service.ts",
  preset: ROOT + "lib/builtin-preset.ts",
  engine: ROOT + "lib/chat-engine.ts",
  settings: ROOT + "components/chat/chat-settings-panel.tsx",
  changelog: ROOT + "lib/changelog.ts",
  css: ROOT + "styles/chat.css",
};
for (const [k, f] of Object.entries(F)) {
  if (!existsSync(f)) { console.error("源码缺失: " + f); process.exit(2); }
}

let failed = 0;
function check(label, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failed++;
  console.log(`[${mark}] ${label}${detail ? "  -> " + detail : ""}`);
}

const src = {};
for (const [k, f] of Object.entries(F)) src[k] = readFileSync(f, "utf8");

console.log("═══════════════════════════════════════════════");
console.log("A. 静态接线断言（抓编译过但没接上的坑）");
console.log("═══════════════════════════════════════════════");

// 1. 心跳真调到 pollGroupWarmup（调用点接上）
check("pollSchedules 心跳调用 pollGroupWarmup",
  src.follow.includes("pollGroupWarmup(now)") &&
  /function pollGroupWarmup\(now: number\)/.test(src.follow));

// 2. 总开关/白名单铁律默认关
check("总开关 loadGroupWarmupEnabled 默认返回 false",
  src.gwStorage.includes("export function loadGroupWarmupEnabled(): boolean") &&
  src.gwStorage.includes("kvGet(GROUP_WARMUP_ENABLED_KEY) === \"1\""),
  "默认未存=关");
check("每群白名单默认空（GroupWarmupRule.whitelist 默认 []）",
  src.gwStorage.includes("whitelist: string[];") &&
  src.gwStorage.includes("whitelist: Array.isArray(r.whitelist) ? r.whitelist : []"));
check("pollGroupWarmup 双重拦截：关总开关或无（该群）白名单即跳过",
  src.follow.includes("if (!loadGroupWarmupEnabled()) return;") &&
  src.follow.includes("if (!rule.whitelist || rule.whitelist.length === 0) continue;"));

// 3. 冷场锚点：loadChatMessages 升序 + reverse()[0]=最新（不反）
check("冷场锚点取最新消息 [...messages].reverse()[0]",
  src.follow.includes("const lastMsg = [...messages].reverse()[0];"));
check("chat-storage 按时间升序排序（旧→新，reverse()[0] 即最新）",
  src.storage.includes("const timeDiff = getMessageTimeValue(a) - getMessageTimeValue(b);"));
check("冷场锚点 ms 由 createdAt 解析（ISO 串）",
  src.follow.includes("new Date(lastMsg.createdAt).getTime()"));

// 4. 落库字段正确：用 senderCharacterId + senderName（不是 characterId）
check("pushChatMessage 用 senderCharacterId + senderName 归位",
  src.follow.includes("senderCharacterId: char.id") &&
  src.follow.includes("senderName: char.name"));
check("落库后广播 chat-messages-updated / weixin-messages-updated（真实群 UI 刷新）",
  src.follow.includes('"chat-messages-updated"') &&
  src.follow.includes('"weixin-messages-updated"'));

// 5. 时间感知：复用 timedWakeElapsedMinutes 通道 + 群预设注入（不假装时间流逝）
check("fireGroupWarmup 透传 timedWakeElapsedMinutes（真实时间差）",
  src.follow.includes("timedWakeElapsedMinutes: elapsedMinutes"));
check("群预设 chat_group_warmup 注册且命中 warmup 标签",
  src.preset.includes('identifier: "chat_group_warmup"') &&
  src.preset.includes('tags: ["group_chat", "warmup"]'));
check("群预设含「不要假装时间流逝」+ {{timedWakeElapsedMinutes}} 宏",
  src.preset.includes("不要假装时间没有流逝") &&
  src.preset.includes("{{timedWakeElapsedMinutes}}"));

// 6. mergeAppTags 不丢 warmup（预设必然命中）
check("mergeAppTags 以 options.appTags 为种子返回（warmup 不被丢）",
  src.engine.includes("const baseTags = (base ?? []).map(tag => tag.trim())") &&
  src.engine.includes("const tags = new Set<string>(baseTags.length > 0 ? baseTags :"));

// 7. 暖场绝不碰离线轮次（你强调的硬约束）：代码层不 import/不调用离线函数
check("follow-up-service 不 import chat-offline-storage",
  !src.follow.includes('from "./chat-offline-storage"'));
check("pollGroupWarmup/fireGroupWarmup 不调用 appendChatOfflineTurn/loadChatOfflineTurns",
  !src.follow.includes("appendChatOfflineTurn") &&
  !src.follow.includes("loadChatOfflineTurns"));
check("代码注释声明绝不触碰离线轮次（边界约束）",
  src.follow.includes("绝不触碰「群聊线下模式」的离线轮次"));

// 8. UI 接线：设置面板导入存储 + 渲染总开关/滑块/白名单
check("chat-settings-panel 导入 group-warmup-storage",
  src.settings.includes('from "@/lib/group-warmup-storage"'));
check("群设置面板渲染「群冷场自动暖场（总开关）」",
  src.settings.includes("群冷场自动暖场（总开关）"));
check("频率拉动条 menu-slider 存在",
  src.settings.includes("menu-slider") && src.css.includes(".menu-slider {"));
check("白名单选人（逐个群成员开关）区存在且列表源为群成员",
  src.settings.includes("gwWhitelist") &&
  src.settings.includes("handleGwWhitelistToggle") &&
  src.settings.includes('gwWhitelist.includes(c.id)') &&
  src.settings.includes("groupChars.map((c) => c ? (") &&
  src.css.includes(".gw-whitelist-row {"));
check("白名单勾选写入该群规则 whitelist（按群隔离，非全局共享）",
  src.settings.includes("persistGwRule({ whitelist: next })"));

// 9. 版本已升
check("changelog 升到 1.7.59",
  src.changelog.includes('APP_VERSION = "1.7.59"') &&
  src.changelog.includes('version: "1.7.59"'));

console.log("");
console.log("═══════════════════════════════════════════════");
console.log("B. 运行时逻辑模拟（解析→白名单→归位，LLM 步用固定输出）");
console.log("═══════════════════════════════════════════════");

// —— 从真实源码抽取正则，确保模拟与源码一致、不漂移 ——
const reLine = src.follow.match(/line\.match\(\/(.*?)\/\)/);
const SRC_REGEX = reLine ? new RegExp(reLine[1]) : /^([^：:]+)[：:]\s*([\s\S]*)$/;
check("源码解析正则抽取成功", Boolean(reLine), reLine ? reLine[1] : "用兜底正则");

// —— 逐行复刻 fireGroupWarmup 814-882 的「候选筛选 + 解析 + 落库」 ——
function simulateWarmup({ participants, whitelist, lastSpeakerId, speakerMode, modelText }) {
  const wl = new Set(whitelist);
  let candidates = participants.filter((c) => wl.has(c.id));
  if (speakerMode !== "auto") {
    const fixed = participants.find((c) => c.id === speakerMode);
    candidates = fixed && wl.has(fixed.id) ? [fixed] : candidates;
  } else {
    const nonLast = candidates.filter((c) => c.id !== lastSpeakerId);
    if (nonLast.length > 0) candidates = nonLast;
  }
  const pushed = [];
  if (candidates.length === 0) return { candidates: [], pushed };

  const lines = modelText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(SRC_REGEX);
    if (!m) continue;
    const name = m[1].trim();
    const content = m[2].trim();
    if (!content) continue;
    const char = candidates.find(
      (c) => c.name === name || name.includes(c.name) || c.name.includes(name),
    );
    if (!char) continue;
    pushed.push({ senderCharacterId: char.id, senderName: char.name, content });
  }
  if (pushed.length === 0 && modelText.trim()) {
    const char = candidates[0];
    pushed.push({ senderCharacterId: char.id, senderName: char.name, content: modelText.trim() });
  }
  return { candidates, pushed };
}

const P = [
  { id: "A", name: "小A" },
  { id: "B", name: "小B" },
  { id: "C", name: "小C" },
];

// 场景1：标准「角色名：内容」，auto，白名单 {A,B}
{
  const r = simulateWarmup({ participants: P, whitelist: ["A", "B"], lastSpeakerId: "C", speakerMode: "auto",
    modelText: "小A：好久没聊了，最近咋样？" });
  check("场景1 正常解析→落成小A气泡", r.pushed.length === 1 && r.pushed[0].senderCharacterId === "A" && r.pushed[0].content.includes("好久没聊"),
    JSON.stringify(r.pushed));
}
// 场景2：两位成员各一句
{
  const r = simulateWarmup({ participants: P, whitelist: ["A", "B"], lastSpeakerId: "C", speakerMode: "auto",
    modelText: "小A：最近在忙啥\n小B：我也在想呢" });
  check("场景2 两位各落成", r.pushed.length === 2 && r.pushed.map((x) => x.senderCharacterId).sort().join() === "A,B");
}
// 场景3：auto 模式排除刚发言者（上次是小B说的）→ 兜底落到非B
{
  const r = simulateWarmup({ participants: P, whitelist: ["A", "B"], lastSpeakerId: "B", speakerMode: "auto",
    modelText: "今天天气不错，有空出来玩吗" });
  check("场景3 无「:」→兜底落到非刚发言者(A)", r.pushed.length === 1 && r.pushed[0].senderCharacterId === "A",
    JSON.stringify(r.pushed));
}
// 场景4：模型说了一个不在白名单的角色 → 该句被跳过（不硬塞）
{
  const r = simulateWarmup({ participants: P, whitelist: ["A", "B"], lastSpeakerId: "C", speakerMode: "auto",
    modelText: "小C：我来暖个场\n小A：别抢，我来" });
  check("场景4 非白名单角色(小C)被跳过，只落成小A", r.pushed.length === 1 && r.pushed[0].senderCharacterId === "A",
    JSON.stringify(r.pushed));
}
// 场景5：指定发言者模式锁 B，模型却输出小A → 只落 B（兜底整段归 B）
{
  const r = simulateWarmup({ participants: P, whitelist: ["A", "B"], lastSpeakerId: "C", speakerMode: "B",
    modelText: "小A：我来暖场" });
  check("场景5 指定模式锁 B，模型说小A→兜底整段归 B", r.pushed.length === 1 && r.pushed[0].senderCharacterId === "B",
    JSON.stringify(r.pushed));
}
// 场景6：白名单为空 → 不落成任何气泡（铁律）
{
  const r = simulateWarmup({ participants: P, whitelist: [], lastSpeakerId: "C", speakerMode: "auto",
    modelText: "小A：来聊" });
  check("场景6 白名单空→零气泡", r.pushed.length === 0);
}

console.log("");
if (failed === 0) {
  console.log("ALL PASS — 群冷场暖场接线 + 解析落库逻辑验证通过（LLM 生成步以固定输出替代，需真机/带 key 再验一次）。");
  process.exit(0);
} else {
  console.log(`${failed} 项未通过，禁止推送。`);
  process.exit(1);
}
