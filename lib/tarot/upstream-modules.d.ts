// 迷恋塔罗上游引擎的模块声明（上游为未经类型标注的原生 JS，按 THIRD_PARTY_NOTICES 保持原样引入）。
// 来源与许可：upstream/tarot/LICENSE、upstream/companion/LICENSE、upstream-source.json。

declare module "*tarot/cards.js" {
  export interface TarotCard {
    id: string;
    major: boolean;
    suit?: string;
    rank: number;
    rankZh?: string;
    rankEn?: string;
    numeral?: string;
    zh: string;
    en: string;
    astro: string;
    element?: string;
    k_up: string;
    k_rev: string;
    up: string;
    rev: string;
    sym?: string;
    motif: string;
  }
  export const DECK: TarotCard[];
  export const SUITS: Record<string, { zh: string; en: string; element: string; theme: string }>;
  export const ROMAN: string[];
  export const byId: Record<string, TarotCard>;
}

declare module "*tarot/spreads.js" {
  export interface TarotSlot { x: number; y: number; rot: number; label: string; hint: string }
  export interface TarotSpread {
    id: string; zh: string; en: string; count: number;
    desc: string; bestFor: string;
    slots: TarotSlot[];
    layout: { w: number; h: number };
  }
  export const SPREADS: TarotSpread[];
  export function classifyQuestion(q: string): string;
  export function autoSpread(question: string): TarotSpread;
}

declare module "*tarot/reading.js" {
  export const READER_SYSTEM: string;
  export function buildReadingMessages(input: {
    question: string;
    spread: { id: string; zh: string; en: string; count: number; desc: string };
    placed: Array<{ card: { zh: string; en: string; k_up: string; k_rev: string; up: string; rev: string; sym?: string; astro?: string }; reversed: boolean; slot: { label: string; hint: string } }>;
    note?: string;
  }): Array<{ role: string; content: string }>;
  export function buildIdentifyMessages(dataUrl: string): Array<{ role: string; content: string }>;
  export function mdToHtml(src: string): string;
}

declare module "*tarot/cardface.js" {
  export const PW: number;
  export const PH: number;
  export function renderCardFace(card: { id: string; zh: string; en: string; motif: string; major?: boolean; suit?: string; rank?: number }): HTMLCanvasElement;
  export function preloadFaces(cards: Array<{ id: string }>): void;
  export function releaseFaceCache(): void;
}

declare module "*companion/result.js" {
  export function canonicalDraw(
    payload: { question: string; spread_id: string; draws: Array<{ position: number; card_id: string; reversed: boolean }> },
    opts: { deck: Array<{ id: string }>; spreads: Array<{ id: string; count: number; slots: Array<{ label: string }> }> },
  ): {
    question: string;
    spread_id: string;
    spread: { id: string; zh: string; en: string; count: number };
    draws: Array<{ position: number; card_id: string; zh: string; reversed: boolean; slot: string }>;
  };
  export function extractSynthesis(text: string): string;
  export function buildResult(
    session: Record<string, unknown>,
    opts: { deck: Array<{ id: string }>; spreads: Array<{ id: string; count: number; slots: Array<{ label: string }> }>; maxChars?: number },
  ): { synthesis: string; advice: string; [k: string]: unknown };
}
