"use client";
import { useEffect, type ReactNode } from "react";
import { cx } from "@/components/ui";

/** Dialog sederhana: overlay, tutup dengan Esc atau klik di luar. */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal className={cx("flex max-h-[calc(100vh-4rem)] w-full flex-col rounded-lg border border-border bg-surface shadow-xl", wide ? "max-w-4xl" : "max-w-lg")}>
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded px-1.5 text-lg leading-none text-muted hover:bg-surface-2 hover:text-text" aria-label="Tutup">
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Kotak catatan kecil (info/peringatan). */
export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div className={cx("rounded-md px-3 py-2 text-xs leading-relaxed", tone === "warn" ? "bg-warn-soft text-warn" : "bg-info-soft text-info")}>{children}</div>
  );
}
