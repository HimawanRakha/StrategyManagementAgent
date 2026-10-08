"use client";
// Daftar elemen (palet kiri): tarik ke canvas atau klik untuk menambahkan di tengah.
import { useState, type DragEvent, type ReactNode } from "react";
import { cx } from "@/components/ui";
import { INPUT_PRESETS } from "@/lib/engine/canvas";
import { NODE_META } from "@/lib/nodes/meta";
import { CustomIcon, DocIcon, GearIcon, NoteIcon, OutIcon, ReviewIcon, ShieldIcon } from "./flow-nodes";
import { PROCESS_GROUPS } from "./summary";
import type { PaletteItem } from "./types";

export const DND_TYPE = "application/x-strategi-node";

function Item({
  item,
  title,
  hint,
  icon,
  disabled,
  disabledHint,
  onAdd,
}: {
  item: PaletteItem;
  title: string;
  hint?: string;
  icon: ReactNode;
  disabled?: boolean;
  disabledHint?: string;
  onAdd: (item: PaletteItem) => void;
}) {
  function onDragStart(e: DragEvent) {
    e.dataTransfer.setData(DND_TYPE, JSON.stringify(item));
    e.dataTransfer.effectAllowed = "move";
  }
  return (
    <button
      type="button"
      draggable={!disabled}
      onDragStart={onDragStart}
      onClick={() => !disabled && onAdd(item)}
      disabled={disabled}
      title={disabled ? disabledHint : `${hint ?? ""}\nTarik ke canvas atau klik untuk menambahkan`}
      className={cx(
        "flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
        disabled ? "cursor-not-allowed border-transparent opacity-45" : "cursor-grab border-border bg-surface hover:border-primary/50 hover:bg-primary-soft/40 active:cursor-grabbing",
      )}
    >
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium leading-tight">{title}</span>
        {hint && <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted">{disabled ? disabledHint : hint}</span>}
      </span>
    </button>
  );
}

const CUSTOM_ITEM: PaletteItem = { type: "process", key: "custom" };

/** Kartu menonjol di atas palet: proses kustom dengan nama & instruksi sendiri. */
function CustomCard({ onAdd }: { onAdd: (item: PaletteItem) => void }) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_TYPE, JSON.stringify(CUSTOM_ITEM));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onAdd(CUSTOM_ITEM)}
      title="Tulis nama & instruksi sendiri untuk AI — tarik ke canvas atau klik untuk menambahkan"
      className="flex w-full cursor-grab items-center gap-2.5 rounded-lg border border-primary/40 bg-primary-soft px-2.5 py-2.5 text-left shadow-sm transition-colors hover:border-primary hover:bg-primary-soft/70 active:cursor-grabbing"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-lg font-bold leading-none text-white">+</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[13px] font-semibold leading-tight text-primary">
          Buat proses sendiri <CustomIcon className="size-3.5 text-primary" />
        </span>
        <span className="mt-0.5 block text-[11px] leading-tight text-muted">Tulis nama &amp; instruksi sendiri</span>
      </span>
    </button>
  );
}

/** Kelompok analisis (ES, SGS, …) yang bisa dilipat. */
function ProcessGroup({ code, label, hint, open, onToggle, children }: { code: string; label: string; hint: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <button type="button" onClick={onToggle} aria-expanded={open} title={hint} className="flex w-full items-start gap-1.5 rounded px-0.5 pt-1 text-left hover:bg-surface-2/70">
        <span className={cx("mt-0.5 inline-block w-2.5 shrink-0 text-[10px] text-muted transition-transform", open && "rotate-90")}>▸</span>
        <span className="shrink-0 rounded bg-primary-soft px-1 py-0.5 font-mono text-[10px] font-bold leading-none text-primary">{code}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11.5px] font-semibold leading-tight text-text">{label}</span>
          {open && <span className="block text-[10.5px] leading-tight text-muted">{hint}</span>}
        </span>
      </button>
      {open && <div className="space-y-1 pl-1">{children}</div>}
    </div>
  );
}

function Group({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {sub && <p className="text-[11px] text-muted">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

export function Palette({
  presentKeys,
  onAdd,
  collapsed,
  onToggle,
  selectedProcess,
}: {
  presentKeys: Set<string>;
  onAdd: (item: PaletteItem) => void;
  collapsed: boolean;
  onToggle: () => void;
  /** Nama node proses yang sedang dipilih (validator/tinjauan langsung disambungkan ke sana). */
  selectedProcess?: string | null;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  if (collapsed)
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-r border-border bg-surface py-2">
        <button type="button" onClick={onToggle} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-text" title="Buka daftar elemen">
          »
        </button>
        <span className="mt-3 text-[11px] text-muted [writing-mode:vertical-rl]">Daftar elemen</span>
      </aside>
    );
  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold">Daftar elemen</h2>
          <p className="text-[11px] text-muted">Tarik ke canvas atau klik</p>
        </div>
        <button type="button" onClick={onToggle} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-text" title="Sembunyikan">
          «
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <CustomCard onAdd={onAdd} />
        <Group title="Input (dokumen)" sub="Boleh lebih dari satu">
          {INPUT_PRESETS.map((p) => (
            <Item key={p.label} item={{ type: "input", label: p.label, values: p.values }} title={p.label} hint={p.hint} icon={<DocIcon className="text-info" />} onAdd={onAdd} />
          ))}
        </Group>
        <Group title="Proses (analisis)" sub="Satu analisis per tab Excel framework; tiap analisis cukup satu kali">
          {PROCESS_GROUPS.map((g) => (
            <ProcessGroup key={g.id} code={g.code} label={g.label} hint={g.hint} open={!closed.has(g.id)} onToggle={() => toggle(g.id)}>
              {g.keys.map((k) => (
                <Item
                  key={k}
                  item={{ type: "process", key: k }}
                  title={NODE_META[k].label}
                  hint={NODE_META[k].description && !NODE_META[k].description.startsWith("(") ? NODE_META[k].description : `Tab Excel ${NODE_META[k].sheetName}`}
                  icon={<GearIcon className="text-primary" />}
                  disabled={presentKeys.has(k)}
                  disabledHint="Sudah ada di canvas"
                  onAdd={onAdd}
                />
              ))}
            </ProcessGroup>
          ))}
        </Group>
        <Group
          title="Pemeriksaan"
          sub={selectedProcess ? `Klik untuk menyambung ke “${selectedProcess}”` : "Pilih node proses dulu, lalu klik — langsung tersambung"}
        >
          <Item
            item={{ type: "validator", label: "" }}
            title="Validator (gerbang pemeriksaan)"
            hint="Memeriksa & memperbaiki otomatis hasil proses yang panahnya masuk"
            icon={<ShieldIcon className="text-info" />}
            onAdd={onAdd}
          />
          <Item
            item={{ type: "review", label: "" }}
            title="Tinjauan manusia"
            hint="Run berhenti sampai Anda menyetujui hasilnya"
            icon={<ReviewIcon className="text-warn" />}
            onAdd={onAdd}
          />
        </Group>
        <Group title="Output">
          <Item
            item={{ type: "output", label: "Dokumen grand design" }}
            title="Dokumen hasil"
            hint="Menyusun hasil analisis jadi dokumen"
            icon={<OutIcon className="text-primary" />}
            onAdd={onAdd}
          />
        </Group>
        <Group title="Catatan">
          <Item item={{ type: "note", label: "" }} title="Catatan" hint="Catatan bebas untuk Anda; tidak dijalankan" icon={<NoteIcon className="text-[#a08400]" />} onAdd={onAdd} />
        </Group>
      </div>
    </aside>
  );
}
