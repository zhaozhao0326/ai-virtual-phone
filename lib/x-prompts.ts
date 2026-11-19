// 推特/X · 提示词组装（复用 couple-space-store 的 cleanDisplayText 清洗人设剪报）
import type { Character } from "@/lib/character-types";
import { cleanDisplayText } from "@/lib/couple-space-store";

type ChatMsg = { role: "system" | "user"; content: string };

function personaBlock(character: Character): string {
    const persona = cleanDisplayText(character.persona).slice(0, 1200);
    const sig = cleanDisplayText(character.signature ?? character.status ?? "");
    return `角色名：${character.name}\n${sig ? `个性签名：${sig}\n` : ""}人设：\n${persona || "（人设暂缺，凭名字自然发挥，别编造具体设定）"}`;
}

/** 让一个角色发 1~2 条推（返回推文数组） */
export function tweetGenerationMessages(character: Character): ChatMsg[] {
    return [
        {
            role: "system",
            content:
                "你是推特模拟器。根据角色人设，以该角色的第一人称写 1~2 条推文。要求：\n" +
                "1. 完全符合人设的语气、兴趣、生活状态，像 TA 真的在刷手机随手发的；\n" +
                "2. 每条不超过 140 字，口语化、有生活感，可以带一点点情绪或碎碎念；\n" +
                "3. 不要堆 hashtag（最多 1 个），不要 @ 陌生人，不要出现「作为AI」「以下是」等元话语；\n" +
                "4. 只输出 JSON 数组，格式如 [\"推文一\",\"推文二\"]，不要任何其他文字。",
        },
        { role: "user", content: personaBlock(character) },
    ];
}

/** 让一个角色评论某条推文（返回单条评论） */
export function tweetCommentMessages(character: Character, authorName: string, postText: string): ChatMsg[] {
    return [
        {
            role: "system",
            content:
                "你是推特模拟器。根据角色人设，以该角色的第一人称给下面这条推文写一条评论。要求：\n" +
                "1. 用 TA 自己的口吻（短口语，不超过 60 字），可以是共鸣、调侃、关心或抬杠，但要有善意；\n" +
                "2. 不要复述推文内容，不要 hashtag，不要出现「作为AI」等元话语；\n" +
                "3. 只输出 JSON 对象，格式如 {\"text\":\"评论内容\"}，不要任何其他文字。",
        },
        { role: "user", content: `${personaBlock(character)}\n\n推文作者：${authorName}\n推文内容：${postText.slice(0, 300)}` },
    ];
}

/** 从模型输出里稳健抠出 JSON（容忍围栏/寒暄） */
export function parseTweetsJSON(raw: string): string[] {
    const text = (raw || "").replace(/```(?:json)?/gi, "").trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
        try {
            const arr = JSON.parse(text.slice(start, end + 1));
            if (Array.isArray(arr)) return arr.map(x => String(x)).filter(s => s.trim()).slice(0, 3);
        } catch { /* 落到兜底 */ }
    }
    // 兜底：整段当一条推
    const one = text.replace(/^\s*"|"\s*$/g, "").trim();
    return one ? [one.slice(0, 140)] : [];
}

export function parseCommentJSON(raw: string): string {
    const text = (raw || "").replace(/```(?:json)?/gi, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            const obj = JSON.parse(text.slice(start, end + 1)) as { text?: string };
            if (obj && typeof obj.text === "string" && obj.text.trim()) return obj.text.trim().slice(0, 200);
        } catch { /* 落到兜底 */ }
    }
    return text.replace(/^["']|["']$/g, "").trim().slice(0, 200);
}
