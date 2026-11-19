// 推特模块回归：真实源码（lib/x-store.ts + lib/x-prompts.ts）
// 运行：node --experimental-strip-types scripts/x-regression.mts
import { addXPost, loadXPosts, addXComments, toggleXLike, deleteXPost, loadXFollowing, toggleXFollowing } from "../lib/x-store.ts";
import { parseTweetsJSON, parseCommentJSON } from "../lib/x-prompts.ts";

// localStorage 桩
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
    localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    },
};
(globalThis as Record<string, unknown>).localStorage = (globalThis as Record<string, unknown>).window.localStorage;

let fail = 0;
function check(name: string, ok: boolean, detail = "") {
    console.log((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : ""));
    if (!ok) fail++;
}

// —— store ——
check("发帖入库", addXPost({ isUser: true, text: "第一条" }).isUser === true);
const chPost = addXPost({ characterId: "c1", text: "  角色推文  " });
check("角色发帖裁边", chPost.text === "角色推文");
check("读取时间线", loadXPosts().length === 2);
check("超长截断 500", addXPost({ isUser: true, text: "x".repeat(600) }).text.length === 500);

const withCm = addXComments(chPost.id, [{ characterId: "c2", text: "哈哈" }, { text: "   " }, { characterId: "c3", text: "好耶" }]);
check("评论过滤空文本且入两条", withCm?.comments.length === 2);
check("找不到帖子返回 null", addXComments("nope", [{ text: "x" }]) === null);

const liked = toggleXLike(chPost.id);
check("点赞+1", liked?.likes === 1 && liked?.liked === true);
const unliked = toggleXLike(chPost.id);
check("再点回 0", unliked?.likes === 0 && unliked?.liked === false);

deleteXPost(loadXPosts()[2].id);
check("删帖生效", loadXPosts().length === 2);

check("关注默认空", loadXFollowing().length === 0);
check("关注添加", toggleXFollowing("c1").includes("c1"));
check("关注去重", toggleXFollowing("c1").length === 0);
check("重复关注恢复", toggleXFollowing("c1").length === 1);

// —— parsers ——
const t1 = parseTweetsJSON('```json\n["推文甲","推文乙"]\n```');
check("围栏数组解析", t1.length === 2 && t1[0] === "推文甲");
const t2 = parseTweetsJSON('好的，我来写！["只有一条"]');
check("带寒暄数组", t2.length === 1 && t2[0] === "只有一条");
const t3 = parseTweetsJSON('今天天气不错，出门散步了。');
check("纯文本兜底单条", t3.length === 1 && t3[0].includes("天气"));
const t4 = parseTweetsJSON('["a","b","c","d"]');
check("最多取 3 条", t4.length === 3);
check("空输出兜底空数组", parseTweetsJSON("   ").length === 0);

const c1 = parseCommentJSON('{"text":"评论内容"}');
check("对象解析", c1 === "评论内容");
const c2 = parseCommentJSON('```json\n{"text":"围栏评论"}\n```');
check("围栏对象", c2 === "围栏评论");
const c3 = parseCommentJSON('就一句话');
check("纯文本兜底", c3 === "就一句话");
check("坏 JSON 兜底", parseCommentJSON('{broken').length > 0);

process.exit(fail ? 1 : 0);
