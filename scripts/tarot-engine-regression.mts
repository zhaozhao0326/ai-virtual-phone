// 塔罗引擎回归测试：直接 import 真实 engine.ts（类型剥离运行）
import {
    DECK, SPREADS, createSession, selectCard, drawRandomCard, revealCards, placedCards,
    normalizeSession, shuffleDeck, tarotRandomInt, loadTarotSessions, saveTarotSession, deleteTarotSession,
} from "../lib/tarot/engine.ts";

// localStorage 桩
const store: Record<string, string> = {};
(globalThis as any).window = {
    localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
    },
};
// Node 22 自带 crypto（getRandomValues/randomUUID），无需桩

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
    console.log((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : ""));
    if (!ok) fail++;
};

// 1. 牌库完整性
check("牌库 78 张且无重复", DECK.length === 78 && new Set(DECK.map(c => c.id)).size === 78);
check("牌阵库至少 4 个", SPREADS.length >= 4, SPREADS.map(s => s.id).join(","));

// 2. 洗牌确定性（固定随机源）
const seq: number[] = [];
const fixedRandom = (max: number) => { seq.push(max); return (seq.length * 7919) % max; };
const deckA = shuffleDeck(true, fixedRandom);
check("洗牌 78 张且不重复", deckA.length === 78 && new Set(deckA.map(d => d.cardId)).size === 78);
check("洗牌含正逆位", deckA.some(d => d.reversed) && deckA.some(d => !d.reversed));

// 3. 均匀随机拒绝采样
check("randomInt 边界", tarotRandomInt(1) === 0 && [0, 1].includes(tarotRandomInt(2)));

// 4. 会话生命周期
const s0 = createSession("charA", "我和他的关系会怎么走？", "three", true);
check("建会话：牌阵/问题/未翻开", s0.spreadId === "three" && s0.question.includes("关系") && !s0.revealed && s0.deck.length === 78);
const s1 = selectCard(s0, 10);
const s2 = selectCard(s1, 20);
check("选牌累积", s1.selected.length === 1 && s2.selected.length === 2);
let threw = false;
try { selectCard(s2, 10); } catch { threw = true; }
check("重复选牌被拒", threw);
const s3 = selectCard(s2, 30);
const s4 = revealCards(s3);
check("翻开后 revealed 且可取牌面", s4.revealed && placedCards(s4).length === 3 && placedCards(s4)[0].slot.label === "过去");

// 5. 随机抽牌不重复
let d = s0;
for (let i = 0; i < 3; i++) d = drawRandomCard(d);
check("随机抽满 3 张", d.selected.length === 3 && new Set(d.selected).size === 3);

// 6. normalize 往返
const norm = normalizeSession(JSON.parse(JSON.stringify(s4)));
check("normalize 往返一致", norm.id === s4.id && norm.deck.length === 78 && norm.revealed === true);
threw = false;
try { normalizeSession({ ...JSON.parse(JSON.stringify(s4)), deck: s4.deck.slice(0, 50) }); } catch { threw = true; }
check("残缺牌库被拒", threw);
threw = false;
try { normalizeSession({ ...JSON.parse(JSON.stringify(s4)), revealed: true, selected: s4.selected.slice(0, 1) }); } catch { threw = true; }
check("未抽齐却揭示被拒", threw);

// 7. 存取与删除
saveTarotSession("charA", s4);
saveTarotSession("charA", createSession("charA", "第二个问题", "single"));
const loaded = loadTarotSessions("charA");
check("按角色存取 2 条且按时间倒序", loaded.length === 2 && loaded[0].createdAt >= loaded[1].createdAt);
deleteTarotSession("charA", loaded[0].id);
check("删除后剩 1 条", loadTarotSessions("charA").length === 1);
check("角色隔离", loadTarotSessions("charB").length === 0);

process.exit(fail ? 1 : 0);
