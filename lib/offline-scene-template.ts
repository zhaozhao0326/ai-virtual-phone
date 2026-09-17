// lib/offline-scene-template.ts
// 线下场景手记：线下模式「状态栏」的内置默认模板。
//
// 定位：线下模式每回合已经会产出一份「摘要」（一段话，同时写进短期记忆）。
// 这里补的是同一回合的**结构化场景卡片**——天气/位置/对用户的印象/正在做什么/
// 情绪/心声/下一步/关系阶段/关系变化。它跟同一轮的「摘要」收在同一个浮层里，
// 聊天记录上只留一个小标签，点了才浮出来看，不占版面。
//
// 复用线上那套「自定义状态栏」机制：契约（提示词里要模型输出什么）
// + 渲染（沙盒 iframe 里跑的 HTML，读 window.STATUS_RAW）。用户在设置里改了契约或渲染，
// 就用自己的；没改就用这份内置的。
//
// 注意：契约会被当作**已组装好的 system 消息**追加，不经过宏引擎，
// 所以这里写用户一律用明文「用户」，不要写 {{user}}（不会被替换成真名）。
//
// 为什么没有「本轮剧情」字段：摘要本身就是这一轮的概括，而且它才是进短期记忆的那份。
// 再让模型写一遍「本轮」＝同一件事两个说法，既费 token 又会对不上。

/** 内置契约：模型在 [状态栏]...[/状态栏] 里输出的字段与格式。 */
export const OFFLINE_SCENE_STARTER_CONTRACT = [
    "【逻辑】你在记录这一轮线下相处的「场景手记」，用来让后续剧情连贯。每行一个字段，用=分隔，除下列字段外不要输出任何其他内容。",
    "内容必须贴住本轮真的发生了什么，不要复述正文，不要写解释，不要写标题。整块用 [状态栏]...[/状态栏] 包裹。",
    "【格式】",
    "[状态栏]",
    "天气=<=一句天气与氛围，例如 秋夜微雨初歇，走廊湿冷，屋内饭菜余温融融>",
    "位置=<=当前所在位置，具体到能想象出画面，例如 市局三号楼三楼单身宿舍>",
    "印象=<=你此刻对用户的外在印象，一句，写衣着神态>",
    "正在做=<=你此刻正在做的事，一句>",
    "情绪=<=2 到 4 个词，用、分隔>",
    "心声=<=你此刻没说出口的念头，一到两句>",
    "下一步=<=你接下来想做的一件事，一句>",
    "阶段=<=你和用户当前的关系阶段>",
    "变化=<=本轮关系发生的变化，一句；没有明显变化就写 无>",
    "[/状态栏]",
].join("\n");

/** 内置渲染：把 [状态栏] 里的字段摊成一张四栏卡片（场景 / 状态 / 心绪 / 关系）。 */
export const OFFLINE_SCENE_STARTER_RENDER = `<style>
  :root{--bg:#fff;--text:#2b2b2f;--sub:#8b9096;--line:#eceef1;--soft:#f7f8fa;--accent:#8a6cff}
  @media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--text:#e9e9ec;--sub:#8e8e93;--line:#2f2f33;--soft:#242427;--accent:#a48bff}}
  body{margin:0;font:12.5px/1.65 -apple-system,system-ui,"PingFang SC",sans-serif;color:var(--text);background:transparent}
  .card{background:var(--bg);border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.07)}
  .hd{display:flex;align-items:center;gap:9px;padding:12px 13px 10px;border-bottom:1px solid var(--line)}
  .badge{width:27px;height:27px;border-radius:8px;flex:none;font-size:13px;
         display:flex;align-items:center;justify-content:center;
         background:color-mix(in srgb,var(--accent) 16%,transparent)}
  .htitle{font-size:13.5px;font-weight:700;letter-spacing:.4px}
  .hen{font-size:8.5px;letter-spacing:1.4px;color:var(--sub);text-transform:uppercase}
  .sec{padding:10px 13px 12px}
  .sec+.sec{border-top:1px solid var(--line)}
  .shead{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}
  .stitle{font-size:11.5px;font-weight:600;display:flex;align-items:center;gap:5px}
  .stag{font-size:8px;letter-spacing:1.2px;color:var(--sub);text-transform:uppercase}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .cell{background:var(--soft);border-radius:9px;padding:7px 9px}
  .cell.full{grid-column:1 / -1}
  .k{font-size:9.5px;color:var(--sub);margin-bottom:2px}
  .v{font-size:11.5px;white-space:pre-wrap;word-break:break-word}
  .foot{padding:9px 13px 11px;border-top:1px solid var(--line);
        font-size:8.5px;letter-spacing:1.3px;color:var(--sub);text-transform:uppercase}
</style>
<div class="card">
  <div class="hd">
    <div class="badge">📌</div>
    <div>
      <div class="htitle">相遇手记</div>
      <div class="hen">Offline Scene Journal</div>
    </div>
  </div>
  <div id="sceneBody"></div>
  <div class="foot">Scene Archive · 手记存档</div>
</div>
<script>
(function () {
  var raw = String(window.STATUS_RAW || "");
  var map = {};
  raw.split(/\\r?\\n/).forEach(function (line) {
    var i = line.indexOf("=");
    if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  var SECTIONS = [
    { title: "场景记录", tag: "Scene", icon: "🕒", rows: [["天气 · 氛围", "天气"], ["所在位置", "位置"]] },
    { title: "当下状态", tag: "Presence", icon: "🙋", rows: [["角色印象", "印象"], ["正在做什么", "正在做"]] },
    { title: "心绪与意图", tag: "Inner", icon: "💭", rows: [["情绪", "情绪"], ["此刻心声", "心声"], ["接下来想做", "下一步"]] },
    { title: "关系轨迹", tag: "Bond", icon: "🔗", rows: [["关系阶段", "阶段"], ["关系变化", "变化"]] }
  ];
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  var html = "";
  SECTIONS.forEach(function (sec) {
    var cells = "";
    sec.rows.forEach(function (row) {
      var value = map[row[1]];
      if (!value) return;
      var wide = value.length > 16 ? " full" : "";
      cells += '<div class="cell' + wide + '"><div class="k">' + esc(row[0]) + '</div><div class="v">' + esc(value) + '</div></div>';
    });
    if (!cells) return;
    html += '<div class="sec"><div class="shead"><div class="stitle"><span>' + sec.icon + '</span>' + esc(sec.title) + '</div><div class="stag">' + esc(sec.tag) + '</div></div><div class="grid">' + cells + '</div></div>';
  });
  document.getElementById("sceneBody").innerHTML = html
    || '<div class="sec"><div class="v" style="opacity:.5">（本轮没有可显示的手记字段）</div></div>';
})();
</script>`;

/** 内置预览示例数据：设置页实时预览用，字段与上面的契约一一对应。 */
export const OFFLINE_SCENE_STARTER_PREVIEW = [
    "天气=秋夜微雨初歇，走廊湿冷，屋内饭菜余温融融",
    "位置=市局三号楼三楼单身宿舍",
    "印象=深色勤务夹克脱下搭在椅背，内穿黑色T恤，脚踩拖鞋",
    "正在做=刚进门换鞋脱衣，坐在桌边吃剩下的五花肉，笑着对账",
    "情绪=放松、踏实、戏谑",
    "心声=算盘打得噼啪响，知道叫「老公」就没脾气了",
    "下一步=顺着哄一会儿，把剩下的肉和土豆扒完再去洗漱",
    "阶段=确立关系的恋人 / 步入亲密昵称的暧昧竹马",
    "变化=亲密专属称谓在实际中落地，被伴依恋与纵容感进一步加深",
].join("\n");
