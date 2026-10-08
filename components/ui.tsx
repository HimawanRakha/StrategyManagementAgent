"use client";
// Komponen UI bersama (Tailwind v4, token warna di app/globals.css).
import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
const BTN: Record<BtnVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover border-transparent",
  secondary: "bg-surface text-text border-border hover:bg-surface-2",
  ghost: "bg-transparent text-text border-transparent hover:bg-surface-2",
  danger: "bg-surface text-danger border-border hover:bg-danger-soft",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        BTN[variant],
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "secondary", className }: { href: string; children: ReactNode; variant?: BtnVariant; className?: string }) {
  return (
    <Link
      href={href}
      className={cx("inline-flex items-center justify-center gap-1.5 rounded-md border h-9 px-3.5 text-sm font-medium transition-colors", BTN[variant], className)}
    >
      {children}
    </Link>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent", className)} aria-hidden />;
}

export function Card({ children, className, title, actions, subtitle }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx("rounded-lg border border-border bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "primary" | "accent";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  info: "bg-info-soft text-info border-transparent",
  primary: "bg-primary-soft text-primary border-transparent",
  accent: "bg-[#eef0fd] text-accent border-transparent",
};

export function Badge({ children, tone = "neutral", className, title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap", TONE[tone], className)}>
      {children}
    </span>
  );
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "menunggu", tone: "neutral" },
  queued: { label: "antre", tone: "neutral" },
  running: { label: "berjalan", tone: "info" },
  needs_review: { label: "perlu tinjauan", tone: "warn" },
  waiting_review: { label: "menunggu tinjauan", tone: "warn" },
  done: { label: "selesai", tone: "ok" },
  failed: { label: "gagal", tone: "danger" },
};

/** Status node run / run / job. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = STATUS[status ?? ""] ?? { label: status ?? "–", tone: "neutral" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1 text-sm", className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

const INPUT = "h-9 rounded-md border border-border bg-surface px-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(INPUT, props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(INPUT, "pr-7", props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(INPUT, "h-auto min-h-20 py-2", props.className)} />;
}

export function Toggle({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2 text-sm select-none", disabled && "opacity-50 cursor-not-allowed")} title={title}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("relative h-5 w-9 rounded-full transition-colors", checked ? "bg-primary" : "bg-border")}
      >
        <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", checked ? "left-4.5" : "left-0.5")} />
      </button>
      {label}
    </label>
  );
}

export function PageHeader({ title, subtitle, actions, crumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; crumbs?: { href: string; label: string }[] }) {
  return (
    <div className="mb-5">
      {crumbs && (
        <nav className="mb-1.5 flex flex-wrap items-center gap-1 text-xs text-muted">
          {crumbs.map((c, i) => (
            <span key={c.href} className="flex items-center gap-1">
              {i > 0 && <span>/</span>}
              <Link href={c.href} className="hover:text-text hover:underline">
                {c.label}
              </Link>
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
      <div>{children}</div>
      {action}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>;
}

export function Loading({ label = "Memuat…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted justify-center">
      <Spinner /> {label}
    </div>
  );
}

/** Tabel sederhana dengan gaya seragam. */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto rounded-md border border-border", className)}>
      <table className="w-full border-collapse text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b border-border px-3 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_tr:last-child_td]:border-b-0">{children}</tbody>
      </table>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2.5">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

/** Label draf wajib di setiap output AI (mitigasi: hasil AI bukan keputusan final). */
export function DraftLabel() {
  return (
    <Badge tone="warn" title="Hasil AI adalah draf dan wajib ditelaah sebelum dipakai">
      DRAF AI
    </Badge>
  );
}
