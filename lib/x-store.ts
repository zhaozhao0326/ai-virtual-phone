// 推特/X · 数据存储（localStorage 全局时间线，不发帖人隔离）
// 全部 AI 调用由用户点击触发（零后台调用），见 phone-twitter-app.tsx。

export type XComment = {
    id: string;
    characterId?: string; // 角色评论
    isUser?: boolean;     // 用户评论
    text: string;
    createdAt: string;
};

export type XPost = {
    id: string;
    characterId?: string; // 角色发帖
    isUser?: boolean;     // 用户发帖
    text: string;
    createdAt: string;
    likes: number;
    liked?: boolean;      // 用户是否点过赞
    comments: XComment[];
};

const POSTS_KEY = "x_posts_v1";
const FOLLOWING_KEY = "x_following_v1";
const MAX_POSTS = 300;
const MAX_COMMENTS_PER_POST = 60;

function safeParse<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? (v as T) : fallback;
    } catch {
        return fallback;
    }
}

function uid(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `x-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function loadXPosts(): XPost[] {
    if (typeof window === "undefined") return [];
    try { return safeParse<XPost[]>(window.localStorage.getItem(POSTS_KEY), []); } catch { return []; }
}

function savePosts(posts: XPost[]): void {
    try { window.localStorage.setItem(POSTS_KEY, JSON.stringify(posts.slice(0, MAX_POSTS))); } catch { /* 容量满则静默 */ }
}

export function addXPost(input: { characterId?: string; isUser?: boolean; text: string; createdAt?: string }): XPost {
    const posts = loadXPosts();
    const post: XPost = {
        id: uid(),
        characterId: input.characterId,
        isUser: input.isUser,
        text: input.text.trim().slice(0, 500),
        createdAt: input.createdAt ?? new Date().toISOString(),
        likes: 0,
        liked: false,
        comments: [],
    };
    savePosts([post, ...posts]);
    return post;
}

export function deleteXPost(postId: string): void {
    savePosts(loadXPosts().filter(p => p.id !== postId));
}

export function addXComments(postId: string, comments: Array<{ characterId?: string; isUser?: boolean; text: string }>): XPost | null {
    const posts = loadXPosts();
    const idx = posts.findIndex(p => p.id === postId);
    if (idx < 0) return null;
    const post = posts[idx];
    const now = new Date().toISOString();
    const added: XComment[] = comments
        .filter(c => c.text && c.text.trim())
        .slice(0, 5)
        .map(c => ({ id: uid(), characterId: c.characterId, isUser: c.isUser, text: c.text.trim().slice(0, 300), createdAt: now }));
    const merged = [...post.comments, ...added].slice(-MAX_COMMENTS_PER_POST);
    posts[idx] = { ...post, comments: merged };
    savePosts(posts);
    return posts[idx];
}

export function toggleXLike(postId: string): XPost | null {
    const posts = loadXPosts();
    const idx = posts.findIndex(p => p.id === postId);
    if (idx < 0) return null;
    const p = posts[idx];
    const liked = !p.liked;
    posts[idx] = { ...p, liked, likes: Math.max(0, p.likes + (liked ? 1 : -1)) };
    savePosts(posts);
    return posts[idx];
}

// —— 关注列表（选人白名单：默认空 = 不会给任何角色烧 token）——

export function loadXFollowing(): string[] {
    if (typeof window === "undefined") return [];
    try { return safeParse<string[]>(window.localStorage.getItem(FOLLOWING_KEY), []); } catch { return []; }
}

export function saveXFollowing(ids: string[]): void {
    try { window.localStorage.setItem(FOLLOWING_KEY, JSON.stringify([...new Set(ids)].slice(0, 50))); } catch { /* ignore */ }
}

export function toggleXFollowing(characterId: string): string[] {
    const cur = loadXFollowing();
    const next = cur.includes(characterId) ? cur.filter(id => id !== characterId) : [...cur, characterId];
    saveXFollowing(next);
    return next;
}
