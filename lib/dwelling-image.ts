import type { DwellingRoom } from "./dwelling-storage";
import { loadDwellingImageEnabled } from "./dwelling-storage";
import { loadImageGenerationSettings } from "./settings-storage";
import type { ImageGenerationSettings } from "./settings-types";
import { generateImageFromConfiguredApi } from "./image-generation-service";
import { loadCharacters } from "./character-storage";

// ── Availability ──────────────────────────────

export type DwellingImageAvailability = {
    /** 生图提供方配置齐全（API Key / Base URL / 模型名齐全） */
    configured: boolean;
    /** 栖所独立生图开关 */
    dwellingEnabled: boolean;
    /** 二者同时满足才真正生图 */
    available: boolean;
    /** 未可用时的具体原因（人类可读），避免笼统报「没配置」让人误以为配置丢失 */
    reason: string;
};

/**
 * 判断当前 Provider 的配置是否齐全（与 generateImageFromConfiguredApi 的分发校验保持一致）：
 * - openai：顶层 apiKey / baseUrl / model 都要
 * - novelai：只需 novelai.apiKey（url 留空走内置官方地址）
 * - pollinations：免费免 Key，只要总开关开启即可
 * - google-imagen：需 googleImagen.apiKey
 * v1.7.34：字段全部空安全——存储里缺 apiKey/baseUrl/model 时不再因 .trim() 抛异常，
 * 而是当作「未配置」返回 false，避免异常上抛导致 UI 误报「没有生图配置」。
 */
function isProviderConfigured(s: ImageGenerationSettings): boolean {
    if (s.provider === "novelai") return Boolean(s.novelai?.apiKey?.trim());
    if (s.provider === "pollinations") return true;
    if (s.provider === "google-imagen") return Boolean(s.googleImagen?.apiKey?.trim());
    return Boolean((s.apiKey || "").trim() && (s.baseUrl || "").trim() && (s.model || "").trim());
}

export function getDwellingImageAvailability(): DwellingImageAvailability {
    const s = loadImageGenerationSettings();
    const providerConfigured = isProviderConfigured(s);
    const configured = providerConfigured;
    const dwellingEnabled = loadDwellingImageEnabled();
    let reason = "";
    if (!providerConfigured) reason = "当前生图提供方配置不完整：需填写 API Key、Base URL、模型名";
    else if (!dwellingEnabled) reason = "栖所生图开关未开启";
    return { configured, dwellingEnabled, available: configured && dwellingEnabled, reason };
}

// ── Room image generation ─────────────────────

/**
 * 房间图提示词版本。
 * v2：把「空无一人」提到最前并加硬否决；同时剥掉角色名/人物主语，
 *     修掉旧版房间图里凭空出现「住在房间里的主人」（还不是绑定角色）的问题。
 * 与当前版本不一致的房间图会在打开房间时自动重画。
 */
export const ROOM_IMAGE_PROMPT_VERSION = 2;

/** 硬性禁用项：放在提示词最前，权重最高，避免模型按 imagePrompt 里的人物描述画人 */
const NO_PEOPLE_RULE =
    "【硬性要求｜最高优先级】这是一张空无一人的室内空间照片：画面中绝对不能出现任何人物——"
    + "不出现人脸、人像、全身或半身的人、背影、剪影、镜中人影、手、腿、脚，也不要出现动物、"
    + "玩偶装的人形和任何可读文字。房间因为没人而显得安静，物品保持被使用过但此刻无人的状态。";

/** 人物类主语：这些词出现在分句里，说明该分句在描述「谁在画面里」，整句丢弃 */
const PERSON_CLAUSE_RX =
    /(他|她|男人|女人|男性|女性|少年|少女|青年|主人|住客|身影|背影|人像|人物|一个人|某人|上半身|半身)/;

/**
 * 把 imagePrompt 里描述人物的分句剥掉。
 * LLM 生成的构图描述常写成「他靠在沙发上」，模型会照着画出一个人；
 * 只按分句（，。；、）剔除含人物主语的片段，保留家具方位描述。
 */
function stripPersonClauses(text: string, characterName?: string): string {
    if (!text) return "";
    const name = (characterName || "").trim();
    const clauses = text.split(/(?<=[，,。；;])/);
    const kept = clauses.filter(clause => {
        if (name && clause.includes(name)) return false;
        // 「单人沙发」「双人床」这类家具名不算人物描述
        const probe = clause.replace(/单人|双人|三人|人形摆件|人偶/g, "");
        return !PERSON_CLAUSE_RX.test(probe);
    });
    return kept.join("").trim();
}

/** 统一风格后缀：保证各房间图色调一致、匹配栖所暗色 UI */
const DWELLING_IMAGE_STYLE_SUFFIX =
    "电影感室内空间摄影，广角镜头拍摄整个房间，低照度暗调，光影层次丰富，氛围沉静高级，构图简洁干净，真实材质细节";

function buildRoomImagePrompt(room: DwellingRoom, characterName?: string): string {
    const labels = (room.furniture || []).map(f => f.label).filter(Boolean);
    const rawBase = room.imagePrompt?.trim()
        || `${room.name}的室内场景，${labels.join("、")}自然分布在画面中`;
    const base = stripPersonClauses(rawBase, characterName) || `${room.name}的室内场景`;
    const mustLine = labels.length
        ? `画面中必须同时出现以下家具，缺一不可：${labels.join("、")}；采用能看到整个房间的广角视角，禁止只拍某件家具的局部特写。`
        : "";
    const details = (room.furniture || [])
        .map(f => {
            const names = (f.items || []).map(i => i.name).filter(Boolean).slice(0, 3);
            return names.length ? `${f.label}上有${names.join("、")}` : "";
        })
        .filter(Boolean)
        .join("；");
    const detailLine = details
        ? `画面细节参考（从中挑选有画面感的自然呈现，小物件只需模糊暗示）：${details}。`
        : "";
    return `${NO_PEOPLE_RULE}${base}。${mustLine}${detailLine}${DWELLING_IMAGE_STYLE_SUFFIX}`;
}

/** 供自检/调试查看最终提示词（不含任何网络请求） */
export function buildDwellingRoomImagePrompt(room: DwellingRoom, characterName?: string): string {
    return buildRoomImagePrompt(room, characterName);
}

export type DwellingRoomImageResult = { assetId: string | null; error?: string };

const inflightByRoom = new Map<string, Promise<DwellingRoomImageResult>>();

function roomKey(characterId: string, roomId: string) { return `${characterId}_${roomId}`; }

export function isDwellingRoomImageGenerating(characterId: string, roomId: string): boolean {
    return inflightByRoom.has(roomKey(characterId, roomId));
}

/** 生图请求硬超时兜底：网络切换/切后台可能让请求永远挂起（用户随时可手动停止） */
const ROOM_IMAGE_TIMEOUT_MS = 600_000;

/** 用户主动停止时的错误标记（UI 据此显示"已停止"而非"失败"） */
export const DWELLING_IMAGE_CANCELED_ERROR = "已停止生成";

const inflightControllers = new Map<string, { controller: AbortController; userCanceled: boolean }>();

/** 手动停止某个房间的生图请求 */
export function cancelDwellingRoomImage(characterId: string, roomId: string): void {
    const entry = inflightControllers.get(roomKey(characterId, roomId));
    if (entry) {
        entry.userCanceled = true;
        entry.controller.abort();
    }
}

/**
 * 为房间生成主视觉图。图像 blob 由 generateImageFromConfiguredApi 存入媒体库，
 * 返回 mediaRef（assetId）；把它写回布局并保存由调用方负责。
 * 同一房间的并发调用会合并到同一次请求。
 */
export async function generateDwellingRoomImage(
    characterId: string,
    room: DwellingRoom,
): Promise<DwellingRoomImageResult> {
    const key = roomKey(characterId, room.id);
    const existing = inflightByRoom.get(key);
    if (existing) return existing;

    const run = (async (): Promise<DwellingRoomImageResult> => {
        const controller = new AbortController();
        const entry = { controller, userCanceled: false };
        inflightControllers.set(key, entry);
        const timer = setTimeout(() => controller.abort(), ROOM_IMAGE_TIMEOUT_MS);
        try {
            const availability = getDwellingImageAvailability();
            if (!availability.available) return { assetId: null, error: availability.reason || "生图未开启" };
            // 角色名传进提示词构造：room.imagePrompt 里若写了「他靠在沙发上」要剥掉，
            // 否则模型会照着画一个陌生人，且与绑定角色完全不像。
            const characterName = loadCharacters().find(c => c.id === characterId)?.name;
            const result = await generateImageFromConfiguredApi({
                description: buildRoomImagePrompt(room, characterName),
                signal: controller.signal,
                // 栖所生图显式钉死：不套 OpenAI 风格预设、尺寸用方图（房间横宽更合适）。
                // 否则 settings 兜底会带默认 auto，误把聊天侧的电影感/氛围增强渗进栖所图。
                settings: { ...loadImageGenerationSettings(), openaiStylePreset: "none", size: "1024x1024" },
            });
            if (!result) return { assetId: null, error: "生图未配置或已关闭" };
            return { assetId: result.mediaRef };
        } catch (e) {
            if (controller.signal.aborted) {
                return { assetId: null, error: entry.userCanceled ? DWELLING_IMAGE_CANCELED_ERROR : "生成超时，请重试" };
            }
            const msg = e instanceof Error ? e.message : "生成失败";
            return { assetId: null, error: msg };
        } finally {
            clearTimeout(timer);
            inflightByRoom.delete(key);
            inflightControllers.delete(key);
        }
    })();

    inflightByRoom.set(key, run);
    return run;
}
