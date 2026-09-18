// lib/offline-speech-text.ts
// 从线下角色发言里挑出「对话内容」用于朗读。
//
// 单聊线下：角色说话通常用引号包起来（"..." / “...” / 「...」 / 『...』 都识别），
// 这些引号内的才是「角色说的话」；没有引号时退化为整段（去掉 markdown 噪声后朗读）。
//
// 群聊线下：多角色的台词挤在同一段叙事里，用「角色名：」标出发言者。splitBySpeakers
// 按角色名把它拆成每个角色自己的台词，朗读时各自挂各自的嗓音，不串音。

// 同时认：弯引号 “ ” / 全角直角引号 「 」 『 』 / 半角直引号 " "
const QUOTE_OPEN = ["“", "”", "「", "『", '"'];
const QUOTE_CLOSE = ["”", "“", "」", "』", '"'];
const QUOTE_RE = new RegExp(
    `[${QUOTE_OPEN.join("")}]([^${QUOTE_CLOSE.join("")}\\n]{1,200})[${QUOTE_CLOSE.join("")}]`,
    "g",
);

export type SpeakerSegment = { characterId: string; name: string; lines: string };

/** 提取角色发言里要朗读的文本。优先取引号内的对话，没有就退化为整段去噪文本。 */
export function extractSpokenLines(text: string): string {
    if (!text) return "";
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    QUOTE_RE.lastIndex = 0;
    while ((m = QUOTE_RE.exec(text)) !== null) {
        const seg = (m[1] || "").trim();
        if (seg) matches.push(seg);
    }
    if (matches.length) {
        return matches.join("。");
    }
    return stripMarkdown(text);
}

/** 去掉 markdown / 代码块 / 链接等噪声，尽量只留可读的中文。 */
function stripMarkdown(s: string): string {
    return s
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]*`/g, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/[#>*_~|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 群聊线下：把一段多人叙事按「角色名：」拆成每个角色自己的台词。
 * 只返回确实说到话的角色（没台词的不会出按钮）；匹配不到角色名的片段（旁白）会被忽略。
 */
export function splitBySpeakers(text: string, speakers: { id: string; name: string }[]): SpeakerSegment[] {
    if (!text || !speakers.length) return [];
    const names = speakers.map((s) => s.name).filter(Boolean).map(escapeRegExp);
    if (!names.length) return [];
    const re = new RegExp(`(^|\\n)\\s*(${names.join("|")})\\s*[：:]\\s*`, "g");
    const matched: { name: string; start: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        matched.push({ name: m[2], start: m.index + m[0].length });
    }
    if (!matched.length) return [];
    const byName = new Map(speakers.map((s) => [s.name, s] as const));
    const result: SpeakerSegment[] = [];
    for (let i = 0; i < matched.length; i++) {
        const seg = matched[i];
        const nextStart = i + 1 < matched.length ? matched[i + 1].start : text.length;
        let content = text.slice(seg.start, nextStart).trim();
        content = content.replace(/^[“"「『]+/, "").replace(/[”"」』]+$/, "");
        if (!content) continue;
        const sp = byName.get(seg.name);
        if (!sp) continue;
        result.push({ characterId: sp.id, name: sp.name, lines: content });
    }
    return result;
}
