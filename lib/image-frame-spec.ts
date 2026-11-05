// 线上发图（角色主动发图 / 朋友圈）共用的「画质 + 遮挡/解剖」规格。
//
// 与线下定格 OFFLINE_FRAME_SPEC_COMMON 的区别：不含「NOBODY looks at the camera」与相机模式段，
// 因为线上多为角色自拍 / 正脸构图，强制不看镜头反而会破坏这类画面；但画质层与遮挡/解剖安全约束
// 与线下保持一致，让线上出图的质感接近线下，且被被子/衣物包裹时不再透出变形躯干。
//
// 这一段是纯英文，经 route.ts 分段翻译时「只翻含中文的片段、英文原样保留」，不会被机翻改坏。
export const ONLINE_FRAME_QUALITY_SPEC = [
    ", cinematic film still, photographic moment, realistic skin with subtle specular highlights, hair edges catching the light, natural fabric folds, believable bedding, textiles and props; ",
    // 遮挡 + 解剖铁律（与线下同源）：被被子/衣物包裹时织物必须像织物，被遮身体不得透出变形躯干，
    // 不得露肩线/胸廓/腰线；四肢须连接合理，不得多手/漂浮/重复肢体。
    "anatomy and occlusion must stay physically correct: every limb clearly attached and plausibly placed, no extra limbs, no merged, floating or duplicated hands, no twisted joints, real human proportions; ",
    // v1.7.138：手部单独一层硬约束（与线下同源）。对应实测失败：拇指不对立（五指当梳子）、
    // 手指根部粘连拉长、手腕悬空接不上前臂、手比脸大。
    "hands must be anatomically exact: exactly five digits on each hand, the thumb clearly opposed and visible on the opposite side of whatever the hand holds, grips or cups; fingers must not merge, elongate, duplicate or bend backwards; a hand must never be larger than the face it touches, and every wrist must connect visibly to a forearm — no disembodied, floating or extra hand; keep hands relaxed and slightly curled instead of splayed with all fingers spread wide; if a hand is mostly hidden by clothing, bedding or another body, draw only the visible part rather than inventing a whole hand; ",
    "when a body is wrapped in a quilt, blanket, duvet or loose clothing, the fabric must read as fabric — soft thick folds and a believable bundle shape — the covered body must NOT show through as a bulging or distorted torso, no shoulder line, chest shape or waist silhouette poking out of the wrapping; only the head and the skin the scene actually exposes are visible, and the visible parts must join up into one anatomically plausible body; ",
    "35mm cinema lens, shallow depth of field with soft bokeh, fine film grain, professional color grading, ultra detailed, 8k",
].join("");

// ── 确定性手姿兜底（v1.7.140）──────────────────────────────────────────────
// 说明：导演/角色模型即使被要求「不要细写手势」，仍可能照抄剧情里的多关节手姿
// （「手指探入她散乱墨发」「捏住下颌」「张开的五指」），而这类手势正是图像模型最容易画坏的
// （五指当梳子、指根粘连、手腕断开）。这一层是**确定性**的：在描述送进生图接口前，用精确锚定的
// 短语把高风险手姿改写成安全手姿。
//
// 为什么用精确锚定而不是通配：避免误伤正常描写——例如「攥紧拳头」「手指探入口袋」
// 「扶着脸颊」都不在匹配范围内，不会被改。只有明确指向「多关节抓握脸部/头发/腰腕」的说法才会被替换。
const HAND_GESTURE_REWRITES: Array<[RegExp, string]> = [
    // 手指探/伸/插进头发（含「探入她散乱墨发」这类中间有修饰的说法）
    [/手指[伸探插][入进](?:她|他)?(?:的)?[^，。；！？]{0,6}(?:发间|发丝|发髻|头发|墨发|鬓角|发尾)/g, "手掌贴着她的头侧"],
    // 捏/扣/掐住下颌或下巴
    [/[捏扣掐]住(?:她|他)?(?:的)?(?:下颌|下巴)/g, "手掌轻贴她的脸颊"],
    // 张开的五指（拆成三种宾语不同的写法，替换后句子仍通顺）
    [/张开的五指|五指张开|五指大张|十指大张/g, "放松微屈的手"],
    [/五指按在/g, "手轻放在"],
    [/五指紧扣/g, "手轻搭在"],
    // 手指扣/攥住腰、手腕、手臂
    [/手指[扣攥][住]?(?:她|他)?(?:的)?(?:腰|手腕|手臂|胳膊)/g, "手轻轻揽住"],
    // 指尖描摹/划过/轻描
    [/指尖(?:描摹|划过|轻描|描过|轻抚)/g, "手掌轻抚"],
];

/** 把描述里高风险的复杂手姿确定性替换为安全手姿；不改变其余内容。 */
export function sanitizeHandGestures(text: string): string {
    if (!text) return text;
    let out = text;
    for (const [re, to] of HAND_GESTURE_REWRITES) out = out.replace(re, to);
    return out;
}

// ── 朋友圈（线上发图之一）导演层（v1.7.142）──────────────────────────────
// 朋友圈生图过去直接拿 LLM 写的扁平 photoDescription 出图，没有线下定格那套
// 电影感构图 / 机位 / 光影，所以显得「扁平、单一、不如线下」。
// 这里给朋友圈也加一层轻量导演：把扁平描述改写成电影感画面，并随机注入一个
// 生活化机位倾向以增加多样性。与线下导演区别：朋友圈是角色本人视角
// （includeUser=false），多为单人自拍 / 生活碎片，所以【不禁止看镜头】
// （自拍本就看镜头），但也不强制——由画面自然决定；同时人设锁脸由下方
// 参考图 / 外观参数独立处理，导演只重排文本描述，不碰禁看镜头等硬约束。

const MOMENT_SHOT_VARIANTS: string[] = [
    "镜头从侧窗逆光切入，人物轮廓镀上一层暖色边光，室内偏暗，氛围安静",
    "黄金时刻的斜射阳光，人物半边脸浸在暖光里，背景轻度虚化",
    "贴近人物肩部的过肩中景，背景是生活场景的横向延展，像随手拍下的生活碎片",
    "利用镜面或玻璃反射，画面里出现一重淡淡的双重影像，增加层次",
    "人物倚在窗边或栏杆上，窗外的天色 / 城市 / 夜景成为天然背景板",
    "低角度仰拍，天光从上方洒下，人物显得舒展放松",
    "特写手中的杯 / 书 / 花，人物落在焦外柔化，重在氛围而非正脸",
    "逆光剪影，人物轮廓融入环境光，细节让位于情绪",
    "从门口框景，前景虚化，人物落进中景纵深",
    "桌面俯拍，咖啡 / 食物 / 小物铺开，人物手入镜，生活气十足",
    "人物对镜头自然微笑的自拍感中景，背景是身后的房间一角",
    "暖灯下的夜景，人物被一圈暖光包围，背景沉入暗部",
];

/** 每次随机抽 1–2 个生活化机位倾向，打破「永远同一构图」的单调性。 */
export function pickMomentShotVariant(): string {
    const a = MOMENT_SHOT_VARIANTS[Math.floor(Math.random() * MOMENT_SHOT_VARIANTS.length)];
    let b = "";
    if (Math.random() < 0.3) {
        const rest = MOMENT_SHOT_VARIANTS.filter((x) => x !== a);
        b = rest[Math.floor(Math.random() * rest.length)];
    }
    return [a, b].filter(Boolean).join("；");
}

/** 朋友圈导演的 system 指令：把扁平描述改写成电影感画面（单人生活时刻）。 */
export function buildMomentDirectorSystem(authorName: string): string {
    return [
        "你是电影分镜导演，同时负责摄影指导。下面是一段「朋友圈」帖子里描述的画面（一个角色要发出去的生图）。",
        "请就这段描述，写一段用于 AI 生图的电影感画面描述（中文）。",
        "",
        `【主角】${authorName}（画面中主要是这一个人）。`,
        "",
        "必须逐项写清楚（这是这段描述能被画对的关键）：",
        "1. 机位与景别：镜头从哪个角度、什么景别，主角在画面什么位置。",
        "2. 身体姿态与动作：他/她正在做的具体动作、身体朝向、与手中物件或环境的关系。手部只写「哪只手大致放在哪个位置」（例如「一只手端着杯子」），不要细分手指的动作与角度。",
        "3. 视线：可以看向镜头（如自拍），也可以看向手中物或场景某处，按画面自然而定，不要死板。",
        "4. 光线：主光来自哪个方向、什么颜色温度、明暗对比怎样，边缘光落在哪一侧。",
        "5. 场景与细节：环境里具体的物件、材质、布料褶皱、空气中的光斑或浮尘。",
        `6. 服装与配饰：${authorName} 穿什么、什么颜色与材质，衣料随着动作怎么起褶皱（家居服、睡衣、外套、新买的小裙子都按描述写实）。`,
        "7. 氛围：这一刻的情绪，用构图、距离和光影表达。",
        "",
        "写作要求：",
        "- 绝对不要描写人物五官、脸型等具体长相——脸由参考图锁定，生图时会自动贴合本人。但发型与发色要按【描述里实际写到的】来画：如果描述提到换了发型或发色（剪短、染了、烫卷、弄了头发），就照描述里的模样写，没提就别编造。",
        `- 用真实姓名「${authorName}」代指，不要编造新名字。`,
        "- 当角色被被子、毯子或宽松衣物包裹时，只描写织物的柔软褶皱与包裹出的蓬松轮廓，绝不要描写被遮住的身体轮廓（不要写肩线、胸廓、腰线或躯干形状），被遮住的部位让它在布料里自然隐没；",
        "- 手部接触写得越复杂，画面越容易把手画错（多指、断指、手接不上手臂都是这么来的）：如果这段描述里出现了「手指探入发间 / 捏住下颌 / 张开的五指 / 手指扣住腰 / 指尖描摹」这类多关节复杂手势，你写画面时一律改写成安全手势——改为「手掌轻轻贴着脸颊、拇指自然落在下颌一侧、其余手指放松微屈」，或「一只手揽着腰 / 扶着肩」，绝不要照抄原句的复杂手姿；也不要让手挡住大半张脸。",
        "- 写成一个连贯的电影画面，不是分点清单，也不要出现编号。",
        "- 描写尺度放宽、自然就好：可以写亲吻（轻吻、吻额头/脸颊、双唇相贴这类亲密但非暴露的动作）、拥抱、依偎、肌肤自然相贴、居家松弛的穿着；只要不是直白的性行为、暴露的性器官描绘或血腥暴力，都可以如实写进画面。用光影、距离与构图承载情绪，而非直白刻画私处。",
        "- 只输出提示词正文，不要标题、引号或任何额外说明。控制在 160 字以内。",
    ].join("\n");
}

/** 朋友圈导演的 user 指令：原描述 + 机位倾向 + 改写要求。 */
export function buildMomentDirectorUserContent(rawDesc: string, authorName: string, variant: string): string {
    return [
        "【这条朋友圈要画的画面描述】",
        rawDesc,
        "",
        "【构图倾向建议（仅供参考，可采纳也可不采纳；目标是让画面更有电影感、更有变化，不牺牲「手部自然」）】",
        variant,
        "",
        `请把上面的描述改写成一段电影感生图提示词：先把机位和 ${authorName} 此刻的身体动作写明白，再写光影、场景与氛围。`,
        "不要丢失原描述里已经写到的「谁、在做什么、穿什么、在哪」这些关键信息；如果原描述本身就平淡，就靠构图与光影把这一刻拍得有质感。",
    ].join("\n");
}
