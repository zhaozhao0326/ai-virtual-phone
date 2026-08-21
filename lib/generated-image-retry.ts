import { saveChatImageToIndexedDB } from "./chat-asset-storage";
import { syncChatGeneratedImagePromptText, updateChatMessage, type ChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { generatedImageFilename, generateImageFromConfiguredApi } from "./image-generation-service";
import { loadImageGenerationSettings, resolveUserIdentity } from "./settings-storage";
import { updateMomentPost } from "./moments-storage";
import type { MomentPost } from "./moments-types";

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

// 判断朋友圈/聊天配图的 prompt 是否意图让角色/人物入镜。
// 仅当 prompt 明确点名该角色，或出现人称/人物相关词时，才视为人物场景；
// 否则按「纯物品/风景/场景」处理，避免把作者角色硬塞进马力机、菜品等配图里。
export function momentDescriptionImpliesCharacter(description: string, authorName?: string): boolean {
    if (!description?.trim()) return false;
    const d = description.toLowerCase();

    // 明确点名作者角色 → 人物场景
    if (authorName && d.includes(authorName.toLowerCase())) return true;

    // 明确排除人物/空场景：「空无一人」「无人」「没有人物」等。
    // 这类 prompt 里即使有「人」字，语义也是不要人，必须优先排除，防止误判。
    const explicitNoPerson = /无人|空无一人|没有人|没[有]?人|无人物|不含人|不要[出现画有]?人|别[画有]?人|空无一物|空镜|空景|空场|无人的/i;
    if (explicitNoPerson.test(d)) return false;

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
function guessGenderFromPersona(persona: string): string | null {
    if (/女|她|姐|妹|妻|母|公主|女王|lady|girl|woman|female/i.test(persona)) return "女生";
    if (/男|他|哥|弟|夫|父|王子|少爷|lord|boy|man|male/i.test(persona)) return "男生";
    return null;
}

// 参与者规格：人物名 + 锚点形容(外貌/性别) + 头像参考图 data URL
export type ParticipantSpec = {
    name: string;
    anchor?: string;
    avatar?: string | null;
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
        specs.push({ name: identity?.name?.trim() || "你", anchor: userBits.join("，") || undefined, avatar: (identity?.faceLockUrl || identity?.avatarUrl) || null });
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

// 浏览器内把头像压缩到最长边 maxSize，减小传给 NAI 的 base64 体积（NAI 参考图无需原图大小）
function resizeImageDataUrl(dataUrl: string, maxSize = 512): Promise<string | null> {
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

    // 参与者：群聊传 participantIds，单聊传 [contactId]
    const participantIds = options?.participantIds && options.participantIds.length
        ? options.participantIds
        : (characterId ? [characterId] : []);
    // 纯净模式：描述未点名「我/你」时排除「你」这个参与者
    const includeUser = !options?.excludeUser;
    const { specs, appearanceText } = buildParticipantSpecs(participantIds, includeUser);
    const participantAppearance = appearanceText || undefined;
    // 收集头像参考图（浏览器内压缩），用于 NAI character_reference 锁脸
    const referenceImages = (await Promise.all(
        specs.map((s) => (s.avatar ? resizeImageDataUrl(s.avatar, 512) : Promise.resolve(null))),
    )).filter(Boolean) as string[];

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
            description: description.slice(0, 160),
            participantAppearance: (participantAppearance || "").slice(0, 160),
            sceneBackground: (settings.sceneBackground || "").slice(0, 160),
            sceneLighting: (settings.sceneLighting || "").slice(0, 160),
            referenceImageCount: referenceImages.length,
            useReferenceImage: message.mediaData?.useReferenceImage === true,
            provider: settings.provider,
        });
        const generated = await generateImageWithReferenceFallback({
            description,
            characterId,
            participantAppearance,
            participants: specs.map((s) => ({ name: s.name, anchor: s.anchor })),
            referenceImages: referenceImages.length ? referenceImages : undefined,
            sceneBackground: settings.sceneBackground?.trim() || undefined,
            sceneLighting: settings.sceneLighting?.trim() || undefined,
            useReferenceImage: message.mediaData?.useReferenceImage === true,
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

    // 根据 prompt 语义决定是否注入作者角色/用户：
    // 纯场景/物品 prompt 不再硬塞角色外貌与头像，避免「跑车马力机」被画成「江慎行」。
    const author = post.authorType === "character" && post.authorId
        ? loadCharacters().find((c) => c.id === post.authorId)
        : undefined;
    const includeCharacters = momentDescriptionImpliesCharacter(description, author?.name);
    const momentParticipantIds = includeCharacters && post.authorId ? [post.authorId] : [];
    const { specs: momentSpecs, appearanceText: momentAppearance } = buildParticipantSpecs(momentParticipantIds, includeCharacters);
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
            description,
            characterId: includeCharacters && post.authorType === "character" ? post.authorId : undefined,
            participantAppearance: includeCharacters ? momentAppearance || undefined : undefined,
            participants: includeCharacters ? momentSpecs.map((s) => ({ name: s.name, anchor: s.anchor })) : undefined,
            referenceImages: includeCharacters && momentRefImages.length ? momentRefImages : undefined,
            sceneBackground: settings.sceneBackground?.trim() || undefined,
            sceneLighting: settings.sceneLighting?.trim() || undefined,
            useReferenceImage: includeCharacters ? post.photoUseReferenceImage === true : false,
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
