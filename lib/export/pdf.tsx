import "server-only";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { GrandDesignDoc } from "@/lib/grand-design/doc";
import type { Grid, GridCell } from "@/lib/sheets/grid";
import { docToReport, type ReportBlock, type TocEntry } from "./report";

// PDF berformat laporan kajian (sampul, daftar isi berhalaman, BAB I–IV, daftar pustaka, lampiran).
// Daftar isi diisi dengan dua kali render: render pertama mencatat halaman setiap judul, render kedua menuliskannya.

// Pemenggalan kata bawaan react-pdf berbasis bahasa Inggris; matikan agar kata Indonesia tidak terpotong.
Font.registerHyphenationCallback((word) => [word]);

const SERIF = "Times-Roman";
const s = StyleSheet.create({
  page: { paddingTop: 72, paddingBottom: 72, paddingLeft: 85, paddingRight: 72, fontSize: 11, fontFamily: SERIF, color: "#111" },
  cover: { flexGrow: 1, alignItems: "center", justifyContent: "center", textAlign: "center" },
  coverTitle: { fontSize: 18, fontFamily: "Times-Bold", marginBottom: 18, textAlign: "center" },
  coverOrg: { fontSize: 15, fontFamily: "Times-Bold", marginBottom: 6, textAlign: "center" },
  coverSub: { fontSize: 12, marginBottom: 4, textAlign: "center" },
  chapterNum: { fontSize: 14, fontFamily: "Times-Bold", textAlign: "center" },
  chapterTitle: { fontSize: 14, fontFamily: "Times-Bold", textAlign: "center", marginBottom: 18 },
  h2: { fontSize: 12, fontFamily: "Times-Bold", marginTop: 12, marginBottom: 6 },
  h3: { fontSize: 11.5, fontFamily: "Times-Bold", marginTop: 10, marginBottom: 5 },
  h4: { fontSize: 11, fontFamily: "Times-BoldItalic", marginTop: 6, marginBottom: 4 },
  // lineHeight HANYA untuk teks bebas: lineHeight yang diwarisi sel tabel memicu galat tata letak react-pdf.
  p: { marginBottom: 7, lineHeight: 1.5, textAlign: "justify" },
  li: { flexDirection: "row", marginBottom: 3 },
  liMark: { width: 18 },
  liText: { flex: 1, lineHeight: 1.4, textAlign: "justify" },
  note: { marginBottom: 6, color: "#555", fontFamily: "Times-Italic", fontSize: 10 },
  caption: { fontSize: 10.5, fontFamily: "Times-Bold", textAlign: "center", marginTop: 6, marginBottom: 4 },
  // Tabel ringkasan bergaya sheet Excel framework: kepala biru tua, huruf sans, garis abu tipis.
  table: { borderTopWidth: 0.4, borderLeftWidth: 0.4, borderColor: "#7f7f7f", marginBottom: 10 },
  row: { flexDirection: "row" },
  cell: { borderRightWidth: 0.4, borderBottomWidth: 0.4, borderColor: "#7f7f7f", padding: 2, fontSize: 8.5, fontFamily: "Helvetica" },
  head: { backgroundColor: "#1F4E78", color: "#ffffff", fontFamily: "Helvetica-Bold", textAlign: "center" },
  tocTitle: { fontSize: 14, fontFamily: "Times-Bold", textAlign: "center", marginBottom: 14 },
  tocRow: { flexDirection: "row", marginBottom: 3 },
  footer: { position: "absolute", bottom: 36, left: 0, right: 0, textAlign: "center", fontSize: 9.5, color: "#444" },
});

// Font bawaan PDF hanya memuat WinAnsi; ganti simbol di luar set itu.
const WIN_ANSI_EXTRA = "…–—‘’“”•€";
const t = (x: string) =>
  x
    .replace(/→/g, "->")
    .replace(/◆/g, "(*)")
    .replace(/·/g, "-")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/×/g, "x")
    .replace(/Σ\s*/g, "jumlah ")
    .replace(/≈/g, "~")
    .split("")
    .map((ch) => (ch.charCodeAt(0) <= 0xff || WIN_ANSI_EXTRA.includes(ch) ? ch : "?"))
    .join("");

type Pages = Record<string, number>;
/** Pencatat nomor halaman judul (dipanggil saat tata letak). */
type Recorder = (id: string, page: number) => void;

/** Judul yang mencatat nomor halamannya (untuk daftar isi). */
function Heading({ id, text, style, record }: { id: string; text: string; style: (typeof s)[keyof typeof s]; record: Recorder }) {
  return (
    <Text
      style={style}
      minPresenceAhead={60}
      render={({ pageNumber }) => {
        record(id, pageNumber);
        return t(text);
      }}
    />
  );
}

function B({
  b,
  record,
  toc,
  tocPages,
  compact,
  first = false,
  avail,
}: {
  b: ReportBlock;
  record: Recorder;
  toc: TocEntry[];
  tocPages: Pages | null;
  compact: boolean;
  /** Blok pertama di halaman (segmen) baru: bab tidak perlu pemisah halaman lagi. */
  first?: boolean;
  /** Lebar area tulis halaman ini (pt). */
  avail: number;
}) {
  const lh = compact ? { lineHeight: 1 } : {};
  switch (b.type) {
    case "cover":
      return null; // digambar di halaman sampul tersendiri
    case "toc":
      return (
        <View>
          <Text style={s.tocTitle}>DAFTAR ISI</Text>
          {toc.map((e) => (
            <View key={e.id} style={[s.tocRow, { paddingLeft: (e.level - 1) * 16 }]} wrap={false}>
              <Text style={{ flex: 1, fontFamily: e.level === 1 ? "Times-Bold" : SERIF }}>{t(e.text)}</Text>
              <Text style={{ width: 32, textAlign: "right" }}>{tocPages?.[e.id] ?? ""}</Text>
            </View>
          ))}
        </View>
      );
    case "chapter":
      return (
        <View break={!first}>
          {b.num ? <Heading id={`${b.id}-n`} text={b.num} style={s.chapterNum} record={() => {}} /> : null}
          <Heading id={b.id} text={b.title} style={s.chapterTitle} record={record} />
        </View>
      );
    case "h2":
      return <Heading id={b.id} text={b.text} style={s.h2} record={record} />;
    case "h3":
      return <Heading id={b.id} text={b.text} style={s.h3} record={record} />;
    case "h4":
      return (
        <Text style={s.h4} minPresenceAhead={30}>
          {t(b.text)}
        </Text>
      );
    case "p":
      return <Text style={[s.p, lh, b.italic ? { fontFamily: "Times-Italic" } : {}]}>{t(b.text)}</Text>;
    case "note":
      return <Text style={s.note}>{t(b.text)}</Text>;
    case "caption":
      return (
        <Text style={s.caption} minPresenceAhead={40}>
          {t(b.text)}
        </Text>
      );
    case "bullets":
      return (
        <View style={{ marginBottom: 7 }}>
          {b.items.map((x, i) => (
            <View key={i} style={s.li}>
              <Text style={s.liMark}>{b.ordered ? `${i + 1}.` : "•"}</Text>
              <Text style={[s.liText, lh]}>{t(x)}</Text>
            </View>
          ))}
        </View>
      );
    case "grid":
      return <GridTable g={b.grid} avail={avail} />;
    case "table": {
      const w = b.widths ?? b.head.map(() => 100 / b.head.length);
      return (
        <View style={s.table}>
          <View style={s.row} fixed>
            {b.head.map((h, i) => (
              <Text key={i} style={[s.cell, s.head, { width: `${w[i]}%` }]}>
                {t(h)}
              </Text>
            ))}
          </View>
          {b.rows.map((r, ri) => (
            <View key={ri} style={s.row} wrap={false}>
              {r.map((c, i) => (
                <Text key={i} style={[s.cell, { width: `${w[i]}%` }]}>
                  {t(c)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
    }
  }
}

// ---------- Halaman tegak dan mendatar ----------

const AVAIL_PORTRAIT = 595.28 - 85 - 72;
const AVAIL_LANDSCAPE = 841.89 - 85 - 72;
/** Perkiraan lebar 1 satuan kolom Excel (≈ 1 karakter) pada huruf tabel 8,5 pt. */
const CHAR_PT = 5.2;

const gridCols = (g: Grid) => {
  const n = Math.max(1, ...g.cells.map((x) => x.c + (x.cs ?? 1)));
  return Array.from({ length: n }, (_, i) => g.cols?.[i] ?? 10);
};
const isWide = (g: Grid) => gridCols(g).reduce((a, x) => a + x, 0) * CHAR_PT * 0.8 > AVAIL_PORTRAIT;

/**
 * Bagi blok menjadi segmen halaman: tabel yang terlalu lebar untuk halaman tegak (beserta judul tabel di atasnya dan
 * catatan di bawahnya) ditaruh di halaman mendatar; sisanya di halaman tegak.
 */
function segments(blocks: ReportBlock[]) {
  const out: { landscape: boolean; items: ReportBlock[] }[] = [];
  const body = blocks.filter((x) => x.type !== "cover");
  const wideGrid = (y: ReportBlock | undefined) => y?.type === "grid" && isWide(y.grid);
  for (let i = 0; i < body.length; i++) {
    const x = body[i];
    const last = out[out.length - 1];
    if ((x.type === "caption" && wideGrid(body[i + 1])) || wideGrid(x)) {
      const seg: ReportBlock[] = [x];
      if (x.type === "caption") seg.push(body[++i]);
      while (body[i + 1]?.type === "note") seg.push(body[++i]);
      // Beberapa tabel lebar berturut-turut berbagi halaman mendatar.
      if (last?.landscape) last.items.push(...seg);
      else out.push({ landscape: true, items: seg });
    } else if (last && !last.landscape) last.items.push(x);
    else out.push({ landscape: false, items: [x] });
  }
  return out;
}

// ---------- Tabel ala sheet Excel ----------

const BOXED = new Set(["header", "subheader", "label", "text", "num", "int", "pct", "total"]);
const STYLE_FILL: Record<string, string> = { header: "1F4E78", subheader: "D9E1F2", total: "F2F2F2" };
const BOLD = new Set(["header", "subheader", "label", "total", "title"]);
const isDark = (hex: string) => {
  const h = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
};

/** Teks sel seperti tampilan Excel: format angka (desimal, persen) dengan koma desimal. */
export function cellText(x: GridCell): string {
  if (x.display !== undefined && x.display !== null && x.display !== "") return x.display;
  const v = x.v;
  if (v === null || v === undefined) return "";
  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return "";
  const f = x.fmt ?? (x.style === "int" ? "0" : x.style === "pct" ? "0.0%" : x.style === "num" ? "0.000" : undefined);
  if (f && f !== "?/?") {
    const pct = f.includes("%");
    const dec = (f.split(".")[1] ?? "").replace(/[^0#]/g, "").length;
    return (pct ? v * 100 : v).toFixed(dec).replace(".", ",") + (pct ? "%" : "");
  }
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3))).replace(".", ",");
}

const BORDER = "#7f7f7f";

function GridTable({ g, avail }: { g: Grid; avail: number }) {
  const cols = gridCols(g);
  const sum = cols.reduce((a, x) => a + x, 0);
  const W = cols.map((x) => (x / sum) * avail);
  const fontSize = Math.max(5, Math.min(8.5, (8.5 * avail) / (sum * CHAR_PT)));
  const at = new Map(g.cells.map((x) => [`${x.r},${x.c}`, x]));
  // Sel yang tertutup gabungan vertikal dari baris di atasnya: (r,c) → sel asal + apakah baris terakhir gabungan.
  const covered = new Map<string, { o: GridCell; last: boolean }>();
  for (const x of g.cells) for (let dr = 1; dr < (x.rs ?? 1); dr++) covered.set(`${x.r + dr},${x.c}`, { o: x, last: dr === (x.rs ?? 1) - 1 });
  if (!g.cells.length) return null;
  const r0 = Math.min(...g.cells.map((x) => x.r));
  const r1 = Math.max(...g.cells.map((x) => x.r + (x.rs ?? 1) - 1));
  const width = (c: number, cs: number) => W.slice(c, c + cs).reduce((a, x) => a + x, 0);
  const look = (x: GridCell) => ({
    fill: x.fill ?? (x.style ? STYLE_FILL[x.style] : undefined),
    boxed: (x.style ? BOXED.has(x.style) : false) || !!x.fill || typeof x.v === "number",
  });
  const rows = [];
  for (let r = r0; r <= r1; r++) {
    const cells = [];
    let any = false;
    for (let c = 0; c < cols.length; ) {
      const x = at.get(`${r},${c}`);
      const cov = covered.get(`${r},${c}`);
      if (x) {
        any = true;
        const cs = x.cs ?? 1;
        const { fill, boxed } = look(x);
        cells.push(
          <Text
            key={c}
            style={{
              width: width(c, cs),
              padding: 2,
              fontSize: x.style === "title" ? fontSize + 2 : fontSize,
              fontFamily: BOLD.has(x.style ?? "") ? "Helvetica-Bold" : x.style === "note" ? "Helvetica-Oblique" : "Helvetica",
              color: fill && isDark(fill) ? "#ffffff" : x.style === "muted" || x.style === "note" ? "#595959" : "#000000",
              backgroundColor: fill ? `#${fill}` : undefined,
              textAlign: x.center || x.style === "header" ? "center" : typeof x.v === "number" ? "right" : "left",
              ...(boxed
                ? {
                    borderWidth: 0.4,
                    borderColor: BORDER,
                    borderBottomWidth: (x.rs ?? 1) > 1 ? 0 : 0.4,
                    ...(x.style === "total" ? { borderTopWidth: 1, borderTopColor: "#595959" } : {}),
                  }
                : {}),
            }}
          >
            {t(cellText(x))}
          </Text>,
        );
        c += cs;
      } else if (cov) {
        any = true;
        const { fill, boxed } = look(cov.o);
        cells.push(
          <View
            key={c}
            style={{
              width: width(c, cov.o.cs ?? 1),
              backgroundColor: fill ? `#${fill}` : undefined,
              ...(boxed ? { borderLeftWidth: 0.4, borderRightWidth: 0.4, borderBottomWidth: cov.last ? 0.4 : 0, borderColor: BORDER } : {}),
            }}
          />,
        );
        c += cov.o.cs ?? 1;
      } else {
        cells.push(<View key={c} style={{ width: W[c] }} />);
        c++;
      }
    }
    rows.push(
      <View key={r} style={any ? s.row : { height: 5 }} wrap={false}>
        {any ? cells : null}
      </View>,
    );
  }
  return <View style={{ marginBottom: 6 }}>{rows}</View>;
}

function render(doc: GrandDesignDoc, blocks: ReportBlock[], toc: TocEntry[], record: Recorder, tocPages: Pages | null, compact: boolean) {
  const cover = blocks.find((x): x is Extract<ReportBlock, { type: "cover" }> => x.type === "cover");
  return renderToBuffer(
    <Document title={`Kajian ${doc.projectName}`} author="Platform Strategi Agen">
      {cover && (
        <Page size="A4" style={s.page}>
          <View style={s.cover}>
            <Text style={s.coverTitle}>{t(cover.title)}</Text>
            <Text style={s.coverOrg}>{t(cover.org)}</Text>
            {cover.sub ? <Text style={s.coverSub}>{t(cover.sub)}</Text> : null}
            <Text style={[s.coverSub, { marginTop: 40 }]}>{t(cover.date)}</Text>
          </View>
        </Page>
      )}
      {segments(blocks).map((seg, si) => (
        <Page key={si} size="A4" orientation={seg.landscape ? "landscape" : "portrait"} style={s.page}>
          {seg.items.map((b, i) => (
            <B
              key={i}
              b={b}
              record={record}
              toc={toc}
              tocPages={tocPages}
              compact={compact}
              first={i === 0}
              avail={seg.landscape ? AVAIL_LANDSCAPE : AVAIL_PORTRAIT}
            />
          ))}
          <Text style={s.footer} fixed render={({ pageNumber }) => `${pageNumber}`} />
        </Page>
      ))}
    </Document>,
  );
}

/** Ekspor PDF berformat laporan kajian. */
export async function grandDesignPdf(doc: GrandDesignDoc): Promise<Buffer> {
  const { blocks, toc } = docToReport(doc);
  const go = async (compact: boolean) => {
    const first: Pages = {};
    await render(doc, blocks, toc, (id, n) => (first[id] = n), null, compact); // render 1: catat halaman setiap judul
    return render(doc, blocks, toc, () => {}, first, compact); // render 2: daftar isi dengan nomor halaman
  };
  try {
    return await go(false);
  } catch {
    // Cadangan: tata letak react-pdf kadang gagal pada pemenggalan halaman tertentu; ulangi dengan spasi baris rapat.
    return go(true);
  }
}
