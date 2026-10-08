import "server-only";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { GrandDesignDoc } from "@/lib/grand-design/doc";
import { docToBlocks, type Block } from "./blocks";

// Pemenggalan kata bawaan react-pdf berbasis bahasa Inggris; matikan agar kata Indonesia tidak terpotong.
Font.registerHyphenationCallback((word) => [word]);

const s = StyleSheet.create({
  page: { padding: 40, paddingBottom: 56, fontSize: 9.5, fontFamily: "Helvetica", color: "#1f2328" },
  title: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  sub: { fontSize: 8.5, color: "#666", marginBottom: 14 },
  h1: { fontSize: 13.5, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 6 },
  h2: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 10, marginBottom: 4 },
  // lineHeight HANYA untuk teks bebas: lineHeight yang diwarisi sel tabel memicu galat tata letak react-pdf
  // ("unsupported number") pada pemenggalan halaman tertentu.
  p: { marginBottom: 6, lineHeight: 1.35 },
  note: { marginBottom: 6, color: "#8a5a00", fontFamily: "Helvetica-Oblique", fontSize: 8.5 },
  table: { borderTopWidth: 0.5, borderLeftWidth: 0.5, borderColor: "#c9ced4", marginBottom: 8 },
  row: { flexDirection: "row" },
  cell: { borderRightWidth: 0.5, borderBottomWidth: 0.5, borderColor: "#c9ced4", padding: 3, fontSize: 8 },
  head: { backgroundColor: "#e8ecef", fontFamily: "Helvetica-Bold" },
  footer: { position: "absolute", bottom: 24, left: 0, right: 0, textAlign: "center", fontSize: 7.5, color: "#888" },
});

// Font bawaan PDF (Helvetica) hanya memuat WinAnsi; ganti simbol di luar set itu.
const WIN_ANSI_EXTRA = "…–—‘’“”•€";
const t = (x: string) =>
  x
    .replace(/→/g, "->")
    .replace(/◆/g, "(*)")
    .replace(/·/g, "-")
    .split("")
    .map((ch) => (ch.charCodeAt(0) <= 0xff || WIN_ANSI_EXTRA.includes(ch) ? ch : "?"))
    .join("");

function B({ b, compact = false }: { b: Block; compact?: boolean }) {
  const lh = compact ? { lineHeight: 1 } : {};
  switch (b.type) {
    case "title":
      return (
        <View>
          <Text style={s.title}>{t(b.text)}</Text>
          <Text style={s.sub}>{t(b.sub)}</Text>
        </View>
      );
    case "h1":
      return <Text style={s.h1} minPresenceAhead={40}>{t(b.text)}</Text>;
    case "h2":
      return <Text style={s.h2} minPresenceAhead={30}>{t(b.text)}</Text>;
    case "p":
      return <Text style={[s.p, lh, b.italic ? { fontFamily: "Helvetica-Oblique" } : {}]}>{t(b.text)}</Text>;
    case "note":
      return <Text style={s.note}>{t(b.text)}</Text>;
    case "bullets":
      return (
        <View style={[s.p, lh]}>
          {b.items.map((x, i) => (
            <Text key={i}>{"•"} {t(x)}</Text>
          ))}
        </View>
      );
    case "table": {
      const w = b.widths ?? b.head.map(() => 100 / b.head.length);
      return (
        <View style={s.table}>
          <View style={s.row} fixed>
            {b.head.map((h, i) => (
              <Text key={i} style={[s.cell, s.head, { width: `${w[i]}%` }]}>{t(h)}</Text>
            ))}
          </View>
          {b.rows.map((r, ri) => (
            <View key={ri} style={s.row} wrap={false}>
              {r.map((c, i) => (
                <Text key={i} style={[s.cell, { width: `${w[i]}%` }]}>{t(c)}</Text>
              ))}
            </View>
          ))}
        </View>
      );
    }
  }
}

function render(doc: GrandDesignDoc, blocks: Block[], compact: boolean) {
  return renderToBuffer(
    <Document title={`Grand Design ${doc.projectName}`} author="Platform Eksperimen Alur Agen LLM">
      <Page size="A4" style={s.page}>
        {blocks.map((b, i) => (
          <B key={i} b={b} compact={compact} />
        ))}
        <Text style={s.footer} fixed render={({ pageNumber, totalPages }) => `DRAF - Halaman ${pageNumber} dari ${totalPages}`} />
      </Page>
    </Document>,
  );
}

/** Ekspor PDF dengan templat yang sama seperti DOCX. */
export async function grandDesignPdf(doc: GrandDesignDoc): Promise<Buffer> {
  const blocks = docToBlocks(doc);
  try {
    return await render(doc, blocks, false);
  } catch {
    // Cadangan: tata letak react-pdf kadang gagal pada pemenggalan halaman tertentu; ulangi dengan spasi baris rapat.
    return render(doc, blocks, true);
  }
}
