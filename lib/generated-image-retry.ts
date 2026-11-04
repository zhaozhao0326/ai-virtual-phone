import { saveChatImageToIndexedDB } from "./chat-asset-storage";
import { syncChatGeneratedImagePromptText, updateChatMessage, type ChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { generatedImageFilename, generateImageFromConfiguredApi, normalizeReferenceImageForEdit } from "./image-generation-service";
import { loadImageGenerationSettings, resolveUserIdentity } from "./settings-storage";
import { updateMomentPost } from "./moments-storage";
import type { MomentPost } from "./moments-types";
import { ONLINE_FRAME_QUALITY_SPEC } from "./image-frame-spec";

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// 上游因「参考图 + prompt 组合」返回的安全/不适合生成类错误（OpenAI invalid_request_error 等）。
// 这类错误去掉参考图（锁脸图/参与者头像）后通常能正常生成，故触发一次自动降级重试。
// 仅当本次确实传入了参考图时才降级；缺参数、并发锁、网络等其他错误不在降级范围。
function isReferenceImageRejection(message: string): boolean {
    return /invalid_request_error|安全政策|不适合.*?图像|safety system|content[ _-]?policy|moderat|rejected as a result|暴.*内容/i.test(message);
}

type ImageGenResult = NonNullable<Awaited<ReturnType<typeof generateImageFromConfiguredApi>>>;

// 明确排除人物/空场景：「空无一人」「无人」「没有人物」等。
// 这类 prompt 即使含「人」字，语义也是不要人，必须优先排除，防止误判。
// 导出给朋友圈生图等调用方：把"不要人"从正提示词剥离、改投负面提示词。
export const EXPLICIT_NO_PERSON_RE = /无人|空无一人|没有人|没[有]?人|无人物|不含人|不要[出现画有]?人|别[画有]?人|空无一物|空镜|空景|空场|无人的/i;

export function hasExplicitNoPerson(description: string): boolean {
    return EXPLICIT_NO_PERSON_RE.test((description || "").toLowerCase());
}

/** 把 prompt 里的「无人物/无人/空景」等中文否定片段剥离，避免被生图模型当正标签触发画人。 */
export function stripExplicitNoPerson(description: string): string {
    if (!description) return description;
    return description.replace(EXPLICIT_NO_PERSON_RE, " ").replace(/\s{2,}/g, " ").trim();
}

// 判断朋友圈/聊天配图的 prompt 是否意图让角色/人物入镜。
// 仅当 prompt 明确点名该角色，或出现人称/人物相关词时，才视为人物场景；
// 否则按「纯物品/风景/场景」处理，避免把作者角色硬塞进马力机、菜品等配图里。
export function momentDescriptionImpliesCharacter(description: string, authorName?: string): boolean {
    if (!description?.trim()) return false;
    const d = description.toLowerCase();

    // 明确点名作者角色 → 人物场景
    if (authorName && d.includes(authorName.toLowerCase())) return true;

    // 明确排除人物/空场景：优先排除，防止误判（详见 hasExplicitNoPerson）
    if (hasExplicitNoPerson(description)) return false;

    // 人称代词、明确的人物名词或人物关系动作 → 人物场景
    const personMarker = /我|你|他|她|我们|你们|他们|她们|人物|角色|头像|自拍|合影|合照|一起|搂着|抱着|牵着|对视|男生|女生|男孩|女孩|男子|女子|男人|女人|男性|女性|少男|少女|帅哥|美女|主角|人们|众人|人群/i;
    return personMarker.test(d);
}

// 生图 + 参考图降级兜底：带参考图请求被上游安全策略拒绝时，自动重试一次不带参考图。
// 这样「食物/风景」类 prompt 在 participants 头像被误判为冲突时也能正常出图，而非直接 400。
async function generateImageWithReferenceFallback(
    args: Parameters<typeof generateImageFromConfiguredApi>[0],
): Promise<ImageGenResult> {
    try {
        const g = await generateImageFromConfiguredApi(args);
        if (!g) throw new Error("生图配置未启用或不完整");
        return g;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const hadRefs = (args.referenceImages?.length ?? 0) > 0 || args.useReferenceImage === true;
        if (hadRefs && isReferenceImageRejection(msg)) {
            console.warn("[IMG-GEN] 带参考图被上游安全策略拒绝，自动降级为无参考图重试", {
                provider: args.settings?.provider,
                message: msg.slice(0, 140),
            });
            args.onStage?.("参考图被安全政策拦截，自动改用无参考图方式重试…");
            const g2 = await generateImageFromConfiguredApi({ ...args, referenceImages: undefined, useReferenceImage: false });
            if (!g2) throw new Error("生图配置未启用或不完整");
            return g2;
        }
        throw error;
    }
}

// 从角色人设弱提取性别（仅当未填写「生图形象」时的回退，命中即加入描述）
export function guessGenderFromPersona(persona: string): string | null {
    if (/女|她|姐|妹|妻|母|公主|女王|lady|girl|woman|female/i.test(persona)) return "女生";
    if (/男|他|哥|弟|夫|父|王子|少爷|lord|boy|man|male/i.test(persona)) return "男生";
    return null;
}

// 参与者规格：人物名 + 锚点形容(外貌/性别) + 头像参考图 data URL
export type ParticipantSpec = {
    name: string;
    anchor?: string;
    avatar?: string | null;
    /** 用户锁脸对称裁脸选区（仅「你」有）；生图前裁出脸部区域，对齐角色参考图裁脸 */
    faceCrop?: { x: number; y: number; size: number };
};

// 收集参与合影的「你」和各个角色的外观 + 头像，返回结构化规格与兼容用的中文描述串。
// characterIds: 参与合影的角色 id 列表（群聊=participantIds，单聊=[contactId]）
// includeUser: 是否把「你」（当前用户身份）也作为参与者注入。纯净模式下可在描述未点名「我/你」时排除。
export function buildParticipantSpecs(characterIds: string[], includeUser = true): { specs: ParticipantSpec[]; appearanceText: string } {
    const specs: ParticipantSpec[] = [];
    const parts: string[] = [];

    // 1) 「你」（当前用户身份）
    const identity = resolveUserIdentity();
    if (includeUser) {
        const userBits: string[] = [];
        if (identity?.gender && identity.gender !== "保密") {
            userBits.push(identity.gender === "女" ? "女生" : identity.gender === "男" ? "男生" : identity.gender);
        }
        if (identity?.appearance?.trim()) userBits.push(identity.appearance.trim());
        specs.push({ name: identity?.name?.trim() || "你", anchor: userBits.join("，") || undefined, avatar: (identity?.faceLockUrl || identity?.avatarUrl) || null, faceCrop: identity?.faceCrop });
        if (userBits.length) parts.push(`你（${userBits.join("，")}）`);
    }

    // 2) 各角色
    const chars = loadCharacters();
    for (const cid of characterIds) {
        const c = chars.find((x) => x.id === cid);
        if (!c) continue;
        const bits: string[] = [];
        if (c.appearance?.trim()) {
            bits.push(c.appearance.trim());
        } else {
            const g = guessGenderFromPersona(c.persona || "");
            if (g) bits.push(g);
        }
        specs.push({ name: c.name, anchor: bits.join("，") || undefined, avatar: c.avatar || null });
        parts.push(bits.length ? `${c.name}（${bits.join("，")}）` : `${c.name}`);
    }

    const appearanceText = parts.length
        ? `画面中的人物设定：${parts.join("；")}。请按各自外貌与性别绘制，清晰区分不同人物的特征。`
        : "";
    return { specs, appearanceText };
}

// 兼容旧调用（朋友圈等）：仅返回中文外观描述串
export function buildParticipantAppearancePrompt(characterIds: string[]): string {
    return buildParticipantSpecs(characterIds).appearanceText;
}

// ── v1.7.121 聊天生图：按「描述本身」判定画面里该有谁 ──
// 为什么必须有这一层：调用方（首次生图 / 重新生成图片 / 后续服务）各自传参不一致，
// 「重新生成图片」甚至完全不传，默认值就变成「你 + 当前角色」两个人。用户看到的就是
// 「提示词明明只是场景，图里却冒出两个人」。把判定收到这里，任何调用方都绕不过去。
// 判据（优先级从高到低）：
//   ① 明确「无人 / 空景 / 空无一人」       → 0 人，且连参考图一起断（否则 edits 会把人带进来）
//   ② 描述点名了某几个角色                 → 只画这几个
//   ③ 群聊且语义是「大家 / 所有人 / 一群人」→ 群成员全画
//   ④ 只出现「我 / 自己」（角色视角）       → 只画该角色，不塞「你」
//   ⑤ 出现「你 / 我们 / 一起 / 合影 / 两人」→ 角色 + 你（或仅你）
//   ⑥ 全篇没有任何人称代词 / 人物名词       → 纯场景，不注入任何人
// 注意 ④⑤ 的拆分是关键：旧代码只凭 `/我|自己|你/` 就把「你」塞进去，于是
// 「我端着那碗馄饨」（角色视角，本该只有 1 人）被画成 2 人。
export function resolveChatImagePeopleIntent(args: {
    description: string;
    candidateIds: string[];
    characterId?: string;
    excludeUser?: boolean;
}): { characterIds: string[]; includeUser: boolean; noPeople: boolean } {
    const description = (args.description || "").trim();
    const candidateIds = (args.candidateIds || []).filter(Boolean);
    const allIds = { characterIds: candidateIds, includeUser: !args.excludeUser, noPeople: false };
    if (!description) return allIds;

    // ① 明确「不要人」最高优先
    if (hasExplicitNoPerson(description)) {
        return { characterIds: [], includeUser: false, noPeople: true };
    }

    const chars = loadCharacters();
    const namedIds = candidateIds.filter((id) => {
        const c = chars.find((x) => x.id === id);
        return c ? description.includes(c.name) : false;
    });

    // 「你」：点名用户名字，或出现明确同框/双人语义。
    // 单凭「我」不算——角色视角的「我」是角色本人，不是用户。
    const identityName = resolveUserIdentity()?.name?.trim() || "";
    const mentionsUser =
        (identityName.length > 0 && description.includes(identityName)) ||
        /你|我们|咱们|我俩|一起|同框|合影|合照|两人|俩人|双人|陪你|带你/.test(description);
    const mentionsSelf = /我|自己|本人/.test(description);
    const groupWords = /大家|众人|所有人|全都|全员|一群人|一群|都在|每个人/.test(description);
    // 第三人称也一定意味着画面里有人（「他靠在窗边」不能当纯场景处理）
    const genericPerson = /他|她|人物|男生|女生|男人|女人|男子|女子|少年|少女|孩子|小孩|人群|旁人|路人|身影|人们/.test(description);

    const includeUser = !args.excludeUser && mentionsUser;

    // ②③④ 多候选（群聊 / 多人聊天）
    if (candidateIds.length > 1) {
        if (namedIds.length > 0) return { characterIds: namedIds, includeUser, noPeople: false };
        if (groupWords) return { characterIds: candidateIds, includeUser: true, noPeople: false };
        // 「我 / 他 / 一个人」这类没点名的主语，默认是发这张图的角色本人
        const speakerFallback = args.characterId && candidateIds.includes(args.characterId) ? [args.characterId] : [];
        if (mentionsSelf || genericPerson) return { characterIds: speakerFallback, includeUser, noPeople: false };
        // 没点名任何群成员、也没有人的痕迹 → 纯场景（用户遇到的正是这个 case）
        return { characterIds: [], includeUser, noPeople: false };
    }

    // ⑤⑥ 单候选（单聊）
    if (candidateIds.length === 1) {
        if (namedIds.length > 0 || mentionsSelf || genericPerson) {
            return { characterIds: candidateIds, includeUser, noPeople: false };
        }
        if (includeUser) return { characterIds: [], includeUser: true, noPeople: false };
        return { characterIds: [], includeUser: false, noPeople: false };
    }

    // 没有任何候选角色：只可能「你」入镜
    return { characterIds: [], includeUser, noPeople: false };
}

// 浏览器内把头像压缩到最长边 maxSize，减小传给 NAI 的 base64 体积（NAI 参考图无需原图大小）
export function resizeImageDataUrl(dataUrl: string, maxSize = 512): Promise<string | null> {
    return new Promise((resolve) => {
        if (typeof window === "undefined" || typeof document === "undefined") { resolve(dataUrl); return; }
        try {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxSize / Math.max(img.width || maxSize, img.height || maxSize));
                const w = Math.max(1, Math.round((img.width || maxSize) * scale));
                const h = Math.max(1, Math.round((img.height || maxSize) * scale));
                const canvas = document.createElement("canvas");
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext("2d");
                if (!ctx) { resolve(dataUrl); return; }
                ctx.drawImage(img, 0, 0, w, h);
                try { resolve(canvas.toDataURL("image/png")); } catch { resolve(dataUrl); }
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        } catch {
            resolve(dataUrl);
        }
    });
}

function dispatchChatMessagesUpdated(sessionId: string, message: ChatMessage): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("chat-messages-updated", {
        detail: { sessionId, message },
    }));
}

function dispatchMomentsUpdated(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("moments-updated"));
}

export function createPendingChatGeneratedImageData(
    mediaData: ChatMessage["mediaData"] | undefined,
    description?: string,
): ChatMessage["mediaData"] {
    const label = (description || mediaData?.label || "").trim();
    return {
        ...mediaData,
        label,
        imageGenerationStatus: "pending",
        imageGenerationError: undefined,
    };
}

export function isPendingChatGeneratedImageMessage(message: Pick<ChatMessage, "mediaType" | "mediaData">): boolean {
    return message.mediaType === "image" && message.mediaData?.imageGenerationStatus === "pending";
}

export async function generateAndApplyChatGeneratedImage(
    message: ChatMessage,
    characterId?: string,
    options?: { signal?: AbortSignal; description?: string; participantIds?: string[]; excludeUser?: boolean },
): Promise<ChatMessage> {
    const previousDescription = message.mediaData?.label?.trim() || "";
    const description = (options?.description ?? previousDescription).trim();
    if (!description) throw new Error("缺少图片描述，无法重新生成");
    if (previousDescription && previousDescription !== description) {
        syncChatGeneratedImagePromptText(message.id, previousDescription, description);
    }

    // 重试路径：先落库为 pending 并广播，气泡立刻切到"生成中"态（首次生图本来就是 pending，无需重写）。
    // 之后无论成功/失败都会再写一次状态，不会卡在 pending。
    if (message.mediaData?.imageGenerationStatus !== "pending") {
        const marked = updateChatMessage(message.id, {
            mediaData: {
                ...message.mediaData,
                label: description,
                imageGenerationStatus: "pending",
                imageGenerationError: undefined,
            },
        });
        if (marked) dispatchChatMessagesUpdated(marked.sessionId, marked);
    }

    // 参与者候选池：群聊传 participantIds，单聊传 [contactId]
    const candidateIds = options?.participantIds && options.participantIds.length
        ? options.participantIds
        : (characterId ? [characterId] : []);

    // ── v1.7.121 图文相符：按「描述本身」判定画面里该不该有人、该有谁 ──
    // 旧逻辑无条件注入「你 + 当前角色」；而「重新生成图片」走 retryChatGeneratedImage 时
    // 连 participantIds / excludeUser 都不传，直接吃默认值 → 纯场景、静物、菜品的描述
    // 也被硬塞进一两个人（用户反馈的「只有场景却冒出两个人」正是这条）。
    // 现在改为按描述解析，首次生图与重绘两条路统一走这里。
    const peopleIntent = resolveChatImagePeopleIntent({
        description,
        candidateIds,
        characterId,
        excludeUser: options?.excludeUser === true,
    });
    const { specs, appearanceText } = buildParticipantSpecs(peopleIntent.characterIds, peopleIntent.includeUser);
    const participantAppearance = appearanceText || undefined;
    // 描述自带「无人/空景」时，把中文否定片段剥掉并改写成英文负面指令：
    // 生图模型会把「无人」当正标签、反而画人（与朋友圈重试保持同一处理）。
    // 判定为「无人」但描述没显式写「无人物」时，同样补一句英文负面——
    // 静物/菜品/风景描述最容易被模型自作主张加一个"陪衬的人"，这是跨 provider 都有效的硬信号。
    const noOneInFrame = peopleIntent.characterIds.length === 0 && !peopleIntent.includeUser;
    const frameBase = noOneInFrame
        ? `No people, no person, empty scene, solo. ${peopleIntent.noPeople ? stripExplicitNoPerson(description) : description}`
        : description;
    // 线上发图叠加与线下同源的画质 + 遮挡/解剖约束（不含「不许看镜头」，保留自拍/正脸构图）。
    const finalDescription = `${frameBase}${ONLINE_FRAME_QUALITY_SPEC}`;
    // 收集头像参考图（浏览器内压缩），用于 NAI character_reference 锁脸
    // 用户(「你」)若设了锁脸裁脸选区，先裁出脸部再压缩，与角色参考图裁脸对称。
    // v1.7.123 群聊锁错脸修复：参考图与 participants 必须由「同一份压缩结果」派生，
    // 否则某人头像压缩失败 / 某人没设头像 → 二者长度/索引错位 → 把 B 的脸贴给 A。
    // 做法：先算 refResults（每个 spec 是否成功压出参考图），再据此同时产出
    // referenceImages（成功者）与 participants.hasReference（同样标记成功者），
    // 从构造上保证「第 k 张参考图 ↔ 第 k 个 hasReference 参与者」严格同序。
    const refResults = await Promise.all(
        specs.map((s) => {
            if (!s.avatar) return Promise.resolve(null);
            const cropped = s.faceCrop
                ? normalizeReferenceImageForEdit(s.avatar, s.faceCrop)
                : Promise.resolve(s.avatar);
            return cropped.then((c) => resizeImageDataUrl(c, 512));
        }),
    );
    const referenceImages = refResults.filter(Boolean) as string[];
    const participants = specs.map((s, i) => ({
        name: s.name,
        anchor: s.anchor,
        // 仅当该角色头像成功压出参考图时才标记有参考图；服务端据此紧凑编号，
        // 不会把无头像/压缩失败的人误绑到别人脸上（群聊多人、有人设头像有人没设时尤其关键）。
        hasReference: Boolean(refResults[i]),
    }));

    // 实时阶段回调：把生图进行中的状态写回消息 mediaData，让气泡显示「正在生成 / 并发锁等待中」
    // 而不是一片空白让用户以为卡死了。
    let liveMediaData: ChatMessage["mediaData"] = { ...message.mediaData };
    const onStage = (text: string) => {
        liveMediaData = { ...liveMediaData, imageGenerationStage: text };
        const updated = updateChatMessage(message.id, { mediaData: liveMediaData });
        if (updated) dispatchChatMessagesUpdated(updated.sessionId, updated);
    };

    try {
        // 聊天流程中触发的生图：强制 enabled=true（与测试生图按钮行为一致）。
        // 用户已通过 [照片:] 指令明确要求生图，不应因前端开关未打开而静默失败。
        const settings = { ...loadImageGenerationSettings(), enabled: true };
        console.log("[IMG-CHAT] 开始生图 v18", {
            description: description.slice(0, 80),
            provider: settings.provider,
            hasNaiKey: Boolean(settings.novelai?.apiKey?.trim()),
            naiModel: settings.novelai?.model,
            naiKeyLen: settings.novelai?.apiKey?.length || 0,
            hasParticipantAppearance: Boolean(participantAppearance),
            participantCount: specs.length,
            referenceImageCount: referenceImages.length,
        });
        console.log("[IMG-CHAT] 发送生图输入", {
            description: finalDescription.slice(0, 160),
            peopleIntent,
            participantAppearance: (participantAppearance || "").slice(0, 160),
            sceneBackground: (settings.sceneBackground || "").slice(0, 160),
            sceneLighting: (settings.sceneLighting || "").slice(0, 160),
            referenceImageCount: referenceImages.length,
            useReferenceImage: peopleIntent.characterIds.length > 0 && message.mediaData?.useReferenceImage === true,
            provider: settings.provider,
        });
        const generated = await generateImageWithReferenceFallback({
            description: finalDescription,
            characterId,
            participantAppearance,
            participants,
            referenceImages: referenceImages.length ? referenceImages : undefined,
            sceneBackground: settings.sceneBackground?.trim() || undefined,
            sceneLighting: settings.sceneLighting?.trim() || undefined,
            // 画面里判定为无人时强制关掉锁脸参考图：否则 /images/edits 会把参考图的
            // 那张脸"带进"本该纯场景的画面，人数约束也压不住（这正是出两个人的最后一环）。
            useReferenceImage: peopleIntent.characterIds.length > 0 && message.mediaData?.useReferenceImage === true,
            signal: options?.signal,
            settings,
            onStage,
        });
        if (!generated) {
            console.error("[IMG-CHAT] generateImageFromConfiguredApi 返回 null — 配置不完整?", {
                provider: settings.provider,
                hasNaiKey: Boolean(settings.novelai?.apiKey?.trim()),
                hasOaiKey: Boolean(settings.apiKey?.trim()),
                enabled: settings.enabled,
            });
            throw new Error("生图配置未启用或不完整");
        }

        const fileName = generatedImageFilename(description, generated.mimeType);
        console.log("[IMG-CHAT] 生图成功", { fileName, mimeType: generated.mimeType, b64Len: generated.dataUrl.length });
        const previousData = message.mediaData ?? {};
        const nextData: ChatMessage["mediaData"] = {
            ...previousData,
            label: description,
            fileType: "image",
            fileName,
            imageGenerationMediaRef: generated.mediaRef,
            imageGenerationPrompt: generated.prompt,
            imageGenerationUsedReference: generated.usedReferenceImage,
            imageGenerationStatus: "generated",
            imageGenerationError: undefined,
            imageGenerationStage: undefined,
        };
        const updated = updateChatMessage(message.id, {
            content: fileName,
            mediaType: "media_file",
            mediaUrl: generated.dataUrl,
            mediaData: nextData,
        });
        if (!updated) throw new Error("原消息不存在，无法替换图片");
        dispatchChatMessagesUpdated(updated.sessionId, updated);
        return updated;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[IMG-CHAT] 生图失败", { error: errMsg, messageId: message.id, description: description.slice(0, 80) });
        const failed = updateChatMessage(message.id, {
            mediaData: {
                ...message.mediaData,
                label: description,
                imageGenerationStatus: "failed",
                imageGenerationError: errorToMessage(error),
                imageGenerationStage: undefined,
            },
        });
        if (failed) dispatchChatMessagesUpdated(failed.sessionId, failed);
        throw error;
    }
}

export async function retryChatGeneratedImage(
    message: ChatMessage,
    characterId?: string,
    nextDescription?: string,
): Promise<ChatMessage> {
    return generateAndApplyChatGeneratedImage(message, characterId, { description: nextDescription });
}

export async function retryMomentGeneratedPhoto(post: MomentPost, nextDescription?: string): Promise<MomentPost> {
    const description = (nextDescription ?? post.photoDescription)?.trim();
    if (!description) throw new Error("缺少图片描述，无法重新生成");

    // 同聊天：重试先置 pending 并广播，卡片立刻显示"图片生成中…"；成功/失败都会再写状态。
    updateMomentPost(post.id, {
        photoDescription: description,
        photoGenerationStatus: "pending",
        photoGenerationError: undefined,
    });
    dispatchMomentsUpdated();

    // 与初始生成（generateMomentPhotoUrl）完全对齐：
    // 1) 明确"无人物/空景"的 prompt → 剥离中文否定片段 + 加英文负面指令，不注入角色；
    // 2) 角色人物场景 → 强制使用锁脸参考图（characterId + useReferenceImage），头像 avatar 作为锁脸参考，性别/长相被锁定；
    // 3) 角色档案 appearance 兜底，无则弱提取性别，至少把男女写进提示词。
    let finalDescription = description;
    const noPerson = hasExplicitNoPerson(description);
    if (noPerson) {
        finalDescription = `No people, no person, empty scene, solo. ${stripExplicitNoPerson(description)}`;
    }
    const author = post.authorType === "character" && post.authorId
        ? loadCharacters().find((c) => c.id === post.authorId)
        : undefined;
    const includeCharacters = !noPerson && momentDescriptionImpliesCharacter(description, author?.name);
    const momentParticipantIds = includeCharacters && post.authorId ? [post.authorId] : [];
    // includeUser=false：朋友圈是角色本人视角的帖子，不把「你」硬塞进图片（与初始生成一致）
    const { specs: momentSpecs, appearanceText: momentAppearance } = buildParticipantSpecs(momentParticipantIds, false);
    const momentRefImages = (await Promise.all(
        momentSpecs.map((s) => (s.avatar ? resizeImageDataUrl(s.avatar, 512) : Promise.resolve(null))),
    )).filter(Boolean) as string[];

    try {
        const settings = { ...loadImageGenerationSettings(), enabled: true };
        console.log("[Moments] 重新生图角色注入判断", {
            description: description.slice(0, 80),
            includeCharacters,
            authorName: author?.name,
        });
        const generated = await generateImageWithReferenceFallback({
            description: `${finalDescription}${ONLINE_FRAME_QUALITY_SPEC}`,
            characterId: includeCharacters && post.authorType === "character" ? post.authorId : undefined,
            participantAppearance: includeCharacters ? momentAppearance || undefined : undefined,
            participants: includeCharacters ? momentSpecs.map((s) => ({ name: s.name, anchor: s.anchor })) : undefined,
            referenceImages: includeCharacters && momentRefImages.length ? momentRefImages : undefined,
            sceneBackground: settings.sceneBackground?.trim() || undefined,
            sceneLighting: settings.sceneLighting?.trim() || undefined,
            useReferenceImage: includeCharacters ? true : false,
            settings,
        });
        if (!generated) throw new Error("生图配置未启用或不完整");

        const assetId = await saveChatImageToIndexedDB(generated.blob);
        const updated = updateMomentPost(post.id, {
            photoUrl: `asset://${assetId}`,
            photoDescription: description,
            photoGenerationStatus: "generated",
            photoGenerationPrompt: generated.prompt,
            photoGenerationError: undefined,
        });
        if (!updated) throw new Error("原朋友圈不存在，无法替换图片");
        dispatchMomentsUpdated();
        return updated;
    } catch (error) {
        updateMomentPost(post.id, {
            photoDescription: description,
            photoGenerationStatus: "failed",
            photoGenerationError: errorToMessage(error),
        });
        dispatchMomentsUpdated();
        throw error;
    }
}
