import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import type { CheckPhonePhotoTone } from "./checkphone-config";

// 用户在线下「定格经典画面」生成的真实图片，单独持久化，与查手机相册的 LLM 模拟内容解耦：
// LLM 相册每次刷新整体重生成，但这里的真实照片独立存放、在相册展示时合并进去，刷新不会被冲掉。

const PREFIX = "ai_phone_checkphone_user_photos_";
registerDynamicPrefix(PREFIX);

export const USER_CLASSIC_FRAMES_ALBUM_ID = "user-classic-frames";
export const USER_CLASSIC_FRAMES_ALBUM_TITLE = "经典画面·线下定格";

export type CheckPhoneUserPhoto = {
  id: string;
  characterId: string;
  /** IndexedDB 资源 id（与线下时间线同一图床：chat-asset-storage）。 */
  assetId: string;
  albumId: string;
  albumTitle: string;
  title: string;
  description: string;
  shotAtLabel: string;
  locationLabel: string;
  tone: CheckPhonePhotoTone;
  createdAt: string;
};

const MAX_USER_PHOTOS_PER_CHARACTER = 60;

function storageKey(characterId: string): string {
  return `${PREFIX}${characterId}`;
}

export function loadCheckPhoneUserPhotos(characterId: string): CheckPhoneUserPhoto[] {
  if (typeof window === "undefined" || !characterId) return [];
  try {
    const raw = kvGet(storageKey(characterId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is CheckPhoneUserPhoto =>
        p && typeof p.id === "string" && typeof p.assetId === "string" && typeof p.characterId === "string",
      )
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  } catch {
    return [];
  }
}

export function appendCheckPhoneUserPhoto(photo: CheckPhoneUserPhoto): void {
  if (typeof window === "undefined" || !photo?.characterId || !photo?.assetId) return;
  const key = storageKey(photo.characterId);
  const current = loadCheckPhoneUserPhotos(photo.characterId);
  const next = [photo, ...current.filter((p) => p.id !== photo.id)].slice(0, MAX_USER_PHOTOS_PER_CHARACTER);
  kvSet(key, JSON.stringify(next));
}

export function removeCheckPhoneUserPhoto(characterId: string, photoId: string): void {
  if (typeof window === "undefined" || !characterId) return;
  const current = loadCheckPhoneUserPhotos(characterId);
  const next = current.filter((p) => p.id !== photoId);
  if (next.length === 0) {
    kvSet(storageKey(characterId), JSON.stringify([]));
    return;
  }
  kvSet(storageKey(characterId), JSON.stringify(next));
}
