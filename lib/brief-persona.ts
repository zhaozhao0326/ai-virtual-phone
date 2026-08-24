// lib/brief-persona.ts
// 简量版人设生成：把角色完整设定压缩成 100~200 字简介，
// 注入到同世界有关系角色的「角色关系」marker 中（见 character-world-storage）。
//
// 与生成配角同理，刻意不走预设系统组装（simpleLLMCall + 代码手动组提示词）：
// 这是结构化压缩任务，用户聊天预设的角色扮演指令/正则会污染输出。
// API 配置沿用角色的聊天绑定（只取 config，不取预设/正则）。
//
// 注意：本模块只负责「生成文本」，不直接写角色存储——角色编辑器把简介当作
// 普通表单字段随 SAVE 持久化，避免与编辑器内存状态互相覆写。

import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import type { Character } from "./character-types";

/** 按传入的角色资料（可以是编辑器里未保存的表单态）生成简量人设文本。失败抛错（含用户可读信息）。 */
export async function generateBriefPersonaText(character: Character): Promise<string> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设再生成简介。");
    }

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, character.id, "chat");
    if (!slot.apiConfigId) throw new Error("尚未绑定 API 配置，请先在绑定设置中配置。");
    const apiConfig = loadApiConfigs().find(c => c.id === slot.apiConfigId);
    if (!apiConfig) throw new Error("绑定的 API 配置不存在。");

    const name = character.name?.trim() || "该角色";
    const systemPrompt = [
        `你是角色档案助手。以下是角色「${name}」的完整设定，请为TA写一段「简量版人设」。`,
        "它会被注入到同一世界观中与TA有关系的其他角色的上下文里，帮助他们在提及、转述或与TA互动时保持TA的人设一致。",
        "",
        `【角色设定】\n${character.persona?.trim() || "（暂无）"}`,
        ...(character.personality?.trim() ? ["", `【性格】\n${character.personality.trim()}`] : []),
        "",
        "要求：",
        "- 第三人称，100~200 字",
        "- 概括：身份背景、性格核心、说话方式与外在气质、与人相处时的显著特征",
        "- 只写别人可感知的信息；不要泄露只有TA自己知道的秘密设定、内心隐情或剧情伏笔",
        "- 只输出简介正文，不要标题、引号或任何额外说明",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: `请为「${name}」生成简量版人设。` },
        ],
        // 思考模型（gemini-pro/deepseek-reasoner 等）会先烧隐藏思考 token 再写正文，
        // 上限给小了会 finishReason=length 且正文为空——给足余量
        { temperature: 0.6, max_tokens: 8192 },
    );

    if (result.error || !result.content) {
        throw new Error(result.error || "模型返回了空内容，请重试。");
    }
    const brief = result.content.trim();
    if (!brief) throw new Error("模型返回了空内容，请重试。");
    return brief;
}

/** 简介是否可能过期（角色设定在生成简介之后又被编辑过）。 */
export function isBriefPersonaStale(character: Character): boolean {
    if (!character.briefPersona || !character.briefPersonaUpdatedAt) return false;
    if (!character.updatedAt) return false;
    return Date.parse(character.updatedAt) > Date.parse(character.briefPersonaUpdatedAt);
}

/**
 * 根据角色设定推导「生图形象描述（appearance）」——AI 生图时用于描述该角色长什么样。
 * 与 generateBriefPersonaText 同理，刻意不走预设系统组装（simpleLLMCall + 代码手动组提示词），
 * 避免角色扮演指令/正则污染输出。本函数只生成文本，不直接写角色存储（由调用方当表单字段持久化）。
 */
export async function generateAppearanceText(character: Character): Promise<string> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设再生成生图形象。");
    }

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, character.id, "chat");
    if (!slot.apiConfigId) throw new Error("尚未绑定 API 配置，请先在绑定设置中配置。");
    const apiConfig = loadApiConfigs().find(c => c.id === slot.apiConfigId);
    if (!apiConfig) throw new Error("绑定的 API 配置不存在。");

    const name = character.name?.trim() || "该角色";
    const systemPrompt = [
        `你是角色形象设计助手。以下是角色「${name}」的完整设定，请为TA写一段「生图形象描述（appearance）」，用于 AI 生图时描述TA长什么样（性别/发型/身材/穿搭/画风气质）。`,
        "",
        `【角色设定】\n${character.persona?.trim() || "（暂无）"}`,
        ...(character.personality?.trim() ? ["", `【性格】\n${character.personality.trim()}`] : []),
        "",
        "要求：",
        "- 用中文，第三人称，2~4 句话（约 40~120 字）",
        "- 只写可视觉感知的外貌/穿搭/画风气质：性别与年龄感、发型发色、身材体态、常穿的服装风格与配色、整体氛围（如温柔 / 冷峻 / 俏皮）",
        "- 从设定中合理推断，不要写设定里没有的硬伤；不要写剧情、内心、能力、对话等非外观内容",
        "- 只输出描述正文，不要标题、引号或任何额外说明",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: `请为「${name}」生成生图形象描述。` },
        ],
        { temperature: 0.7, max_tokens: 2048 },
    );

    if (result.error || !result.content) {
        throw new Error(result.error || "模型返回了空内容，请重试。");
    }
    const text = result.content.trim();
    if (!text) throw new Error("模型返回了空内容，请重试。");
    return text;
}

export type DeepDivePersonaProfile = {
    core: string;           // 核心特质（2~4 句弹性描述）
    voice: string;          // 语气与说话风格（弹性描述）
    values: string;         // 价值观与底线
    catchphrases: string[]; // 口头禅
    relationships: string;  // 关系网特征
    growth: string;         // 成长弧光
    taboos: string;         // 禁忌与边界
    acting: string;         // 扮演要点（活人感）
};

/**
 * 主动深挖人设：把角色设定深度分析成一份「结构化人设档案」（JSON 字符串）。
 *
 * 与 generateBriefPersonaText 的区别：
 *   - 简量人设（brief）是给「同世界其他角色」看的对外压缩版；
 *   - 深挖档案（profile）是给「角色自己扮演」用的内部底盘，维度更细（语气/口头禅/关系网/成长弧光/禁忌/扮演要点）。
 *
 * 实现原则（用户 2026-08-22 强烈重申的「抓人设≠锁死」）：
 *   档案是「锚定稳定底盘的弹性特质描述」，帮助演绎更准确、更活，
 *   绝不是把角色写成死板规则/固定台词。提示词显式禁止「你必须说 X」式指令。
 *
 * 返回：合法的 JSON 字符串（无 markdown 包裹），调用方可直接 JSON.parse 后持久化到
 * Character.personaProfile，并在构建该角色 system prompt 时注入。
 */
export async function generateDeepDivePersona(character: Character): Promise<string> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设再深挖。");
    }

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, character.id, "chat");
    if (!slot.apiConfigId) throw new Error("尚未绑定 API 配置，请先在绑定设置中配置。");
    const apiConfig = loadApiConfigs().find(c => c.id === slot.apiConfigId);
    if (!apiConfig) throw new Error("绑定的 API 配置不存在。");

    const name = character.name?.trim() || "该角色";
    const systemPrompt = [
        `你是角色演绎专家。以下是角色「${name}」的设定，请深度分析并产出一份「结构化人设档案」，供扮演者稳定且鲜活地演绎 TA。`,
        "",
        `【角色设定】\n${character.persona?.trim() || "（暂无）"}`,
        ...(character.personality?.trim() ? ["", `【性格】\n${character.personality.trim()}`] : []),
        ...(character.briefPersona?.trim() ? ["", `【简量人设】\n${character.briefPersona.trim()}`] : []),
        ...(character.appearance?.trim() ? ["", `【外貌气质】\n${character.appearance.trim()}`] : []),
        "",
        "要求：",
        "- 只输出一个严格的 JSON 对象，不要 markdown 代码块包裹、不要任何额外说明，字段固定为：",
        '  {"core":"核心特质（2~4 句弹性描述，概括身份与内在）","voice":"语气与说话风格（句式、用词习惯、情绪表达方式，弹性描述）","values":"价值观与底线","catchphrases":["口头禅1","口头禅2"],"relationships":"关系网特征（TA 如何对待不同关系的人）","growth":"成长弧光（对话中可能自然发展的方向）","taboos":"禁忌与边界（绝对不碰的雷区）","acting":"扮演要点（如何保持活人感：自然、能即兴、有成长，不刻板不背台词）"}',
        "- 关键原则：档案是「锚定稳定底盘的弹性特质」，用来帮助演绎得更准确、更活，绝不是把角色锁死成固定规则或固定台词；",
        "  禁止写「你必须说/你必须做」式死板指令，要写「TA 通常会如何」的倾向性描述，允许角色对新颖情境自然反应、有自己的成长。",
        "- 中文输出，简洁有力，避免空话套话；catchphrases 最多 4 个。",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: `请为「${name}」生成结构化人设档案（严格 JSON）。` },
        ],
        { temperature: 0.7, max_tokens: 8192 },
    );

    if (result.error || !result.content) {
        throw new Error(result.error || "模型返回了空内容，请重试。");
    }
    const raw = result.content.trim();
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
        JSON.parse(jsonStr);
    } catch {
        throw new Error("模型输出不是合法 JSON，请重试。");
    }
    return jsonStr;
}

/**
 * 把人设深挖档案（JSON 字符串）格式化成可注入 system prompt 的可读文本。
 * 解析失败或内容为空时返回 null（调用方应回退到不注入，避免污染上下文）。
 * 只取有内容的维度，格式为「- 维度：内容」列表。
 */
export function formatDeepDiveProfile(jsonStr: string): string | null {
    if (!jsonStr?.trim()) return null;
    let p: DeepDivePersonaProfile;
    try {
        p = JSON.parse(jsonStr) as DeepDivePersonaProfile;
    } catch {
        return null;
    }
    const rows: { label: string; value?: string }[] = [
        { label: "核心特质", value: p?.core },
        { label: "语气与说话风格", value: p?.voice },
        { label: "价值观与底线", value: p?.values },
        { label: "口头禅", value: (p?.catchphrases || []).join("、") },
        { label: "关系网特征", value: p?.relationships },
        { label: "成长弧光", value: p?.growth },
        { label: "禁忌与边界", value: p?.taboos },
        { label: "扮演要点", value: p?.acting },
    ];
    const filled = rows.filter((r) => r.value && r.value.trim());
    if (!filled.length) return null;
    return filled.map((r) => `- ${r.label}：${r.value}`).join("\n");
}
