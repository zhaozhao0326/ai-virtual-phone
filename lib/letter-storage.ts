// lib/letter-storage.ts
// Letters 异步信存储：角色基于对用户的了解写信投递，用户拆信阅读。
// 独立 IndexedDB（letters 表），按角色隔离。

import { openIndexedDbAtLeast } from "./idb-open";

export type LetterEntry = {
    id: string;
    characterId: string;
    from: string;              // 写信角色名
    content: string;
    createdAt: string;
    read: boolean;
    source?: string;           // 来源：ai 生成 / 手动
    /** 类型：letter=角色写的信 / dream=角色深夜的梦呓 / diary=角色私下写的日记（缺省按 letter） */
    type?: "letter" | "dream" | "diary";
};

const DB_NAME = "ai_phone_letters_db_v1";
const DB_VERSION = 1;
const STORE_NAME = "letters";

function hasBrowserApi(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

async function openDb(): Promise<IDBDatabase | null> {
    if (!hasBrowserApi()) return null;
    return openIndexedDbAtLeast(DB_NAME, DB_VERSION, (db, _oldVersion, tx) => {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
            store.createIndex("by_character", "characterId", { unique: false });
            store.createIndex("by_character_created", ["characterId", "createdAt"], { unique: false });
        } else if (tx) {
            const store = tx.objectStore(STORE_NAME);
            if (!store.indexNames.contains("by_character")) {
                store.createIndex("by_character", "characterId", { unique: false });
            }
            if (!store.indexNames.contains("by_character_created")) {
                store.createIndex("by_character_created", ["characterId", "createdAt"], { unique: false });
            }
        }
    }).catch(() => null);
}

function runRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function saveLetter(letter: LetterEntry): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(letter);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function loadLetters(characterId: string): Promise<LetterEntry[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        const store = db.transaction(STORE_NAME).objectStore(STORE_NAME);
        const req: IDBRequest<LetterEntry[]> = store.index("by_character").getAll(characterId);
        const letters = await runRequest(req);
        return letters.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch {
        return [];
    } finally {
        db.close();
    }
}

export async function markLetterRead(id: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const letter = await runRequest(store.get(id) as IDBRequest<LetterEntry | undefined>);
        if (letter) {
            store.put({ ...letter, read: true });
        }
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function deleteLetter(id: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

/** 加载全部角色的信件（信箱主页 App 用）。可选按类型过滤。 */
export async function loadAllLetters(type?: "letter" | "dream" | "diary"): Promise<LetterEntry[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        const store = db.transaction(STORE_NAME).objectStore(STORE_NAME);
        const req: IDBRequest<LetterEntry[]> = store.getAll();
        const all = await runRequest(req);
        const filtered = type ? all.filter(l => (l.type || "letter") === type) : all;
        return filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch {
        return [];
    } finally {
        db.close();
    }
}
