"use client";
/**
 * 情侣空间 · 私藏短笺（宣纸信笺浮层）
 *
 * 设计要点（严格按需求）：
 * - 极简文人折纸小信笺：泛黄做旧宣纸质感 / 米白纸面 + 一道微弱暗红折痕；
 * - 只读展示：一行行带时间戳的手写体碎碎念，没有未读红点、没有邮件列表；
 * - 右下角只留一个「合上」按钮；点遮罩 / 按 Esc / 点按钮三条路都能退，
 *   组件内部没有任何异步阻塞，从根上杜绝「进得去出不来」。
 */

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { LoveLetter } from "@/lib/love-letters-store";

type Props = {
  characterName: string;
  letters: LoveLetter[];
  onClose: () => void;
};

/** 时间戳：11月18日 22:14 */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

export function CoupleLoveLetter({ characterName, letters, onClose }: Props) {
  const paperRef = useRef<HTMLDivElement | null>(null);

  // Esc 关闭 + 锁背景滚动（卸载时全部还原，不留副作用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="cll-mask"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="cll-paper"
        ref={paperRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${characterName} 写的短笺`}
      >
        {/* 暗红折痕：一道很淡的斜线，像真的折过 */}
        <div className="cll-fold" aria-hidden />
        <div className="cll-fold-v" aria-hidden />

        <header className="cll-head">
          <div className="cll-title">私藏短笺</div>
          <div className="cll-sub">{characterName} 写给你的</div>
        </header>

        <div className="cll-body">
          {letters.length > 0 ? (
            letters.map((l, i) => (
              <article className="cll-note" key={l.id}>
                <p className="cll-text">{l.text}</p>
                <div className="cll-meta">
                  <span className="cll-time">{stamp(l.created_at)}</span>
                  <span className="cll-sign">— {characterName}</span>
                </div>
                {i < letters.length - 1 && <div className="cll-divider" aria-hidden />}
              </article>
            ))
          ) : (
            <div className="cll-empty">
              <div className="cll-empty-mark" aria-hidden>✧</div>
              <p>还没有短笺。</p>
              <p className="cll-empty-hint">和 {characterName} 说些体己话，Ta 会悄悄写一张塞进来。</p>
            </div>
          )}
        </div>

        <footer className="cll-foot">
          <button type="button" className="cll-close" onClick={onClose} aria-label="合上信笺">
            <X size={14} />
            <span>合上</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
