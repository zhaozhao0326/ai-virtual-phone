// lib/changelog.ts
// 小手机（虚拟手机）UI 功能版本与更新日志。
//
// 注意：APP_VERSION 是「功能版本」，独立于 package.json 里的框架版本号。
// 每次对手机 UI / 内置 App 做较大更新时，请把 APP_VERSION 递增，并在 CHANGELOG
// 头部追加一条记录。设置页「系统更新」与小卷「查询系统更新」工具共用这份数据，
// 这样你无论从哪都能确认「我的小手机是不是更新了、更新了什么」。

export const APP_VERSION = "1.2.8";

export interface ChangelogEntry {
  version: string;       // 例如 "1.0.0"
  date: string;          // YYYY-MM-DD
  title: string;         // 本次更新的主题
  highlights: string[];  // 更新要点
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.2.8",
    date: "2026-08-07",
    title: "记忆联动可视化：剧情 / 漫卷 / 线上聊天 记忆连贯一目了然",
    highlights: [
      "记忆库「共享事件」页此前只显示朋友圈/群聊/访谈，现已把剧情(story)、漫卷(vn)、跑团(map)、线下聊天(chat_offline)、自定义APP(custom_app，如黑珍珠酒吧) 一并纳入，跨 App 记忆联动完整可见",
      "记忆详情页顶部新增「记忆联动」概览卡：按来源 App 统计各渠道贡献条数（聊天/群聊/朋友圈/剧情/漫卷/酒吧APP…），一眼确认这些线上线下的走剧情功能共享同一份角色记忆、互相连贯",
      "底层机制确认：剧情/漫卷/线上聊天 共用同一份以 characterId 为主键的记忆库，短期时间线由 loadNativeTimeline 统一聚合，记忆在 App 间原生连贯——此前缺少可见的「更新列表」导致难以确认，现已补齐",
    ],
  },
  {
    version: "1.2.7",
    date: "2026-08-07",
    title: "黑珍珠灵魂酒吧 v17：酒吧时间跟随真实世界实时流逝",
    highlights: [
      "新增实时时钟（startClock）：每秒对齐系统真实时间，酒吧状态栏的时间像真实世界一样持续走表，坐着不动也会流逝",
      "去掉此前人为累加的分钟数（聊天+4/点单+10/事件+15），避免与真实时间打架导致时钟跳动/漂移",
      "「夜深了」提示改为由实时时钟在跨过 23:00 时触发，更贴合现实",
      "打包 soul-bar-app-17.zip",
    ],
  },
  {
    version: "1.2.6",
    date: "2026-08-07",
    title: "黑珍珠灵魂酒吧 v16：修复选完老板/调酒师后「开始营业」按钮不可见（被挤出屏幕）",
    highlights: [
      "修复 staffSetup 弹窗角色列表过长时「开始营业 ▸」按钮被推出可视区域外、无法点击的阻断性 bug",
      "setup-grid 最大高度从 34vh 缩减至 22vh（两个列表不再撑满屏幕）；setup-card 增加 max-height + overflow-y:auto（整体可滚动）",
      "添加 -webkit-overflow-scrolling:touch 提升移动端滚动流畅度",
      "打包 soul-bar-app-16.zip",
    ],
  },
  {
    version: "1.2.5",
    date: "2026-08-07",
    title: "黑珍珠灵魂酒吧 v15：可挂载小手机里已写好的世界书",
    highlights: [
      "世界书面板新增「🔗 挂载小手机世界书」区块：自动列出手机「设置 → 世界书」里已建好的世界书（名称 / 描述 / 条目数），勾选即挂载",
      "挂载后酒吧内所有 AI 对话（卡座聊天、调酒、群像、偶遇、随机事件等 13 处调用）都会自动带上这些世界书，由宿主按各自关键词规则注入",
      "新增「忽略关键词，整本全量注入」开关，适合想让整本设定常驻的场景",
      "挂载选择持久化保存；宿主里被删除的世界书会自动从挂载列表清理",
      "APP 权限新增 world.read；manifest 1.5.0，打包 soul-bar-app-15.zip",
    ],
  },
  {
    version: "1.2.4",
    date: "2026-08-07",
    title: "黑珍珠灵魂酒吧 v14：修复进店入口 + 彻底移除相册拍照",
    highlights: [
      "修复 #app 容器缺少 position:relative 导致 mask 遮罩定位异常（进店选人/员工配置等弹层无法正确覆盖主界面）",
      "修复 staffSetup 角色选择列表过长时「开始营业」按钮被推出可视区域外的问题（setup-grid 加 overflow-y:auto）",
      "彻底移除相册/拍照功能（用户确认不保留）：删除 📸 相册 tab、相册房间、卡座/相册拍照按钮、takePhoto/sendMoment/renderMoments/downloadPolaroid 全部函数及拍立得 CSS",
      "打包 soul-bar-app-14.zip",
    ],
  },
  {
    version: "1.2.3",
    date: "2026-08-07",
    title: "黑珍珠灵魂酒吧 v13：相册/拍照恢复并修复（上一版误删）",
    highlights: [
      "恢复相册/拍照功能（📸 tab、卡座拍照按钮、拍立得渲染、保存图片）",
      "修正根因：上一版「始终无法使用」并非生图 API 未配置，而是 takePhoto 第①步强依赖真实角色 characterId——独自/只有 NPC 在场时必抛错、永远走不到生图",
      "重写 takePhoto：生图为核心，AI 写配文改为「尽力而为、失败不阻塞」，无角色也能直接拍照",
      "彻底移除「请去设置配置生图 API」误导提示；改走真实错误文案（聊天拍照同链路已验证宿主生图可用）",
      "打包 soul-bar-app-13.zip（manifest 1.3.0）",
    ],
  },
  {
    version: "1.2.2",
    date: "2026-08-07",
    title: "黑珍珠灵魂酒吧 v12：UI 修复 + 删相册 + 菜单可点击",
    highlights: [
      "调酒结果显示栏改为不透明实底（#1a1528），解决透明导致看不清字的问题",
      "「给你调一杯」标题后增加「剧本再生成请等待…」提示文案",
      "删除相册/拍照功能（当时误判为「生图 API 未配置」，实为 takePhoto 代码 bug，已于 v1.2.3 恢复并修复）：移除相册房间、tab按钮、拍照JS、相关CSS",
      "调酒台菜单（点单/自调/让TA调）增加 z-index + isolation:isolate，修复游戏层遮挡导致点击无响应",
    ],
  },
  {
    version: "1.2.1",
    date: "2026-08-07",
    title: "黑珍珠灵魂酒吧 v11：群像旁观模式",
    highlights: [
      "卡座新增「👥 群像」：选至少 2 位在场的人，让他们自己聊、你只看不说",
      "复用多角色生成（A.ai.generate characterIds），升级成常客/老友的酒吧熟人也能被选入群像",
      "与「建群弹窗 NPC 纯群」呼应：NPC 之间的社交圈无需先加好友即可围观",
    ],
  },
  {
    version: "1.2.0",
    date: "2026-08-07",
    title: "建群弹窗支持全部角色 + NPC 纯群",
    highlights: [
      "创建群聊候选列表从「仅联系人」扩展为「全部有独立人设的角色」",
      "未加好友的角色也可被选入，并标记「未添加好友」",
      "选人步骤即可切换「围观模式」；选满 2 人可一键「设为 NPC 纯群」（机主不在群里），方便围观 NPC 之间的社交",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-08-07",
    title: "黑珍珠灵魂酒吧 v10：调酒台融合 + 点单菜单恢复",
    highlights: [
      "调酒台游戏由 iframe 改为直接同文档内联合并，修复手机端黑屏问题",
      "恢复吧台点单菜单（今日特调 / 自调 / 让 TA 调）",
      "修复 ai.generate 缺少 characterId 导致随机事件等 6 处报错",
      "酒吧相册支持 AI 生图合照",
    ],
  },
  {
    version: "1.0.1",
    date: "2026-08-07",
    title: "工坊能力增强",
    highlights: [
      "工坊「单轮工具调用上限」可在配置里调节",
      "仓库源码单次读取上限提升至 9000 字符，单页读取字符数可配置",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-08-07",
    title: "系统更新查询上线",
    highlights: [
      "设置新增「系统更新」入口，可查看当前版本号与历次更新内容",
      "小卷（手机助手）支持直接询问「最近更新了什么 / 版本更新了吗」",
      "内置 App 持续迭代（黑珍珠灵魂酒吧：世界书挂载、角色头像预设等）",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-08-05",
    title: "黑珍珠灵魂酒吧上线",
    highlights: [
      "新增内置 App「黑珍珠灵魂酒吧」：时间流逝、醉酒度、账单、拍照发朋友圈",
      "多房间（卡座 / 吧台 / 露台）与固定员工（老板娘珍珠、调酒师老K）",
      "世界书挂载、随机突发事件、熟人 / 商业伙伴关系互动",
    ],
  },
];

/** 把更新日志拼成适合小卷回复 / 文本展示的字符串 */
export function formatChangelog(): string {
  const lines: string[] = [];
  lines.push(`小手机当前版本：v${APP_VERSION}`);
  lines.push("");
  for (const e of CHANGELOG) {
    lines.push(`【v${e.version} · ${e.date}】${e.title}`);
    for (const h of e.highlights) lines.push(`  · ${h}`);
    lines.push("");
  }
  lines.push("（以上为本机已安装的更新记录；远程有新版本时会在「系统更新」里提示。）");
  return lines.join("\n");
}
