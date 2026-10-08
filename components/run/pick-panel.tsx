"use client";
// Bukti untuk butir yang diklik: kutipan dokumen bila butir membawanya, atau teks butir yang dirujuk.
import { EvidenceList, SidePanel, UserAnswerBadge } from "./evidence";
import type { IndexedItem } from "./trace-utils";
import { hasUserEvidence, type ChunkLookup, type Picked } from "./types";

type PickProps = {
  picked: Picked;
  /** Indeks butir semua analisis (lihat itemIndexFrom). */
  index: Map<string, IndexedItem>;
  lookup: ChunkLookup;
  /** Nama analisis menurut kunci (untuk "dari analisis …"). */
  labelOf?: (key: string) => string;
};

/** Teks dan bukti butir yang diklik. */
export function resolvePick({ picked, index }: Pick<PickProps, "picked" | "index">) {
  const el = index.get(picked.id);
  const evidence = picked.evidence?.length ? picked.evidence : el?.evidence;
  const text = picked.text ?? el?.text;
  return { el, evidence, text };
}

/** Isi bukti (tanpa bingkai), bisa dipasang di panel mana pun. */
export function PickContent({ picked, index, lookup, labelOf }: PickProps) {
  const { el, evidence } = resolvePick({ picked, index });
  return (
    <div className="space-y-2">
      {el && (
        <p className="text-xs text-muted">
          Butir dari analisis <b className="text-text">{labelOf ? labelOf(el.key) : el.key}</b>
          {el.detail ? ` — ${el.detail}` : ""}.
        </p>
      )}
      {evidence?.length ? (
        <>
          <p className="text-xs text-muted">Kutipan disorot di dalam potongan dokumen sumbernya.</p>
          <EvidenceList evidence={evidence} lookup={lookup} />
        </>
      ) : (
        <p className="text-sm text-muted">
          {el ? (
            <>
              Butir <span className="font-mono">{picked.id}</span> tidak membawa kutipan dokumen langsung. Buka analisisnya untuk melihat angka dan alasan AI di tabelnya.
            </>
          ) : (
            <>
              Butir <span className="font-mono">{picked.id}</span> tidak ditemukan di hasil yang sudah tersedia.
            </>
          )}
        </p>
      )}
    </div>
  );
}

export function PickPanel({ onClose, ...props }: PickProps & { onClose: () => void }) {
  const { evidence, text } = resolvePick(props);
  return (
    <SidePanel
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono">{props.picked.id}</span>
          {hasUserEvidence(evidence) && <UserAnswerBadge />}
        </span>
      }
      subtitle={text}
      onClose={onClose}
    >
      <PickContent {...props} />
    </SidePanel>
  );
}
