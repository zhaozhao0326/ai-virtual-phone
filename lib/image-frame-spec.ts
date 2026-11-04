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
