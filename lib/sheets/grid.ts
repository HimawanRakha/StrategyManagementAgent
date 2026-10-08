// Model "sheet" ala Excel untuk output node bawaan. Modul murni (aman di client).
//
// Satu Grid = satu tab Excel: sel berkoordinat (baris/kolom 0-based), boleh digabung (rs/cs), boleh memuat rumus Excel
// (f, tanpa "=") beserta penjelasannya dalam bahasa awam (explain). Grid yang sama dipakai untuk:
//  - tampilan di panel node (tabel ala Excel, sel bisa diklik untuk melihat rumus, sel `edit` bisa diubah pengguna),
//  - ekspor XLSX (rumus tetap hidup; {{nodeKey!anchor}} diganti alamat sel di sheet lain),
//  - panel Perhitungan dan laporan (daftar sel berumus).
//
// Nilai `v` WAJIB sama dengan hasil rumus `f` bila dihitung Excel — kode TypeScript yang menghitung, Excel hanya cermin.

export type CellStyle =
  | "title" // judul sheet (tebal, besar)
  | "header" // kepala tabel (latar gelap)
  | "subheader" // sub-kepala (latar terang)
  | "label" // label baris (tebal)
  | "text" // teks biasa (dibungkus)
  | "num" // angka desimal
  | "int" // bilangan bulat
  | "pct" // persen
  | "total" // baris total (tebal, garis atas)
  | "note" // catatan miring
  | "muted"; // teks redup

/** Asal angka/isi sel — ditampilkan sebagai penanda kecil agar pembaca tahu siapa yang mengisi. */
export type CellSource =
  | "ai" // diusulkan AI (boleh diubah pengguna bila `edit` ada)
  | "manusia" // diubah/diisi pengguna (ditandai otomatis oleh tampilan bila path sel ada di riwayat edit)
  | "hitung" // dihitung kode dengan rumus
  | "ahp" // bobot hasil AHP
  | "tetap" // konstanta metode (mis. bobot indikator effort 0,35)
  | "dokumen"; // diambil dari dokumen

/** Sel yang bisa diubah pengguna: `path` menunjuk ke output mentah node (yang divalidasi skema Zod). */
export type CellEdit = {
  path: (string | number)[];
  type: "number" | "text" | "select";
  min?: number;
  max?: number;
  step?: number;
  /** Untuk type "select": pilihan nilai (teks, atau label + nilai yang disimpan, mis. {label:"1/3", value:0.3333}). */
  options?: (string | { label: string; value: string | number })[];
  /** Boleh dikosongkan (disimpan null). */
  allowEmpty?: boolean;
};

export type GridCell = {
  r: number;
  c: number;
  v: string | number | null;
  /** Teks tampilan bila berbeda dari v (mis. "1/3" untuk 0,333); Excel tetap menyimpan v. */
  display?: string;
  /** Rumus Excel tanpa "=", alamat A1. Boleh memuat {{nodeKey!anchor}} untuk rujukan ke sheet node lain. */
  f?: string;
  /** Format angka Excel, mis. "0.000" atau "0%". */
  fmt?: string;
  /** Penjelasan rumus dengan angka, untuk orang awam: "Skor = Total rating × Bobot = 3,21 × 0,088 = 0,282". */
  explain?: string;
  edit?: CellEdit;
  src?: CellSource;
  /** Alasan AI / catatan sumber (tampil saat sel diklik). */
  note?: string;
  /** Rujukan bukti, mis. ["C12", "U3"]. */
  refs?: string[];
  style?: CellStyle;
  /** Gabung sel: jumlah baris/kolom (bawaan 1). */
  rs?: number;
  cs?: number;
  /** Warna latar (hex tanpa #), mis. warna kuadran. */
  fill?: string;
  /** Rata tengah. */
  center?: boolean;
};

/** Grafik sederhana yang menyertai sheet (ditampilkan di UI; diekspor sebagai tabel data). */
export type GridChart =
  | {
      type: "quadrant";
      title: string;
      x: number;
      y: number;
      xLabel: string;
      yLabel: string;
      /** Label kuadran: kanan-atas, kiri-atas, kiri-bawah, kanan-bawah. */
      quadrants: [string, string, string, string];
    }
  | { type: "bar"; title: string; data: { label: string; value: number }[]; max?: number }
  | { type: "scatter"; title: string; xLabel: string; yLabel: string; threshold?: number; max?: number; points: { label: string; x: number; y: number }[] };

export type Grid = {
  /** Unik dalam satu node, mis. "ifas", "ahp-s". */
  id: string;
  /** Nama tab Excel (≤ 31 karakter, tanpa []:*?/\). */
  name: string;
  /** Judul di atas tabel. */
  title: string;
  /** Lebar kolom (satuan karakter Excel). */
  cols?: number[];
  cells: GridCell[];
  /** Nama → alamat sel A1 di grid ini, untuk rujukan antar-sheet (mis. { total: "T27" }). */
  anchors?: Record<string, string>;
  freeze?: { rows: number; cols: number };
  chart?: GridChart;
  /** Cara membaca tabel ini (kalimat pendek untuk orang awam). */
  notes?: string[];
};

// ---------- Alamat A1 ----------

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function colLetter(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** (r, c) 0-based → "D6". `abs` → "$D$6". */
export function addr(r: number, c: number, abs = false): string {
  return abs ? `$${colLetter(c)}$${r + 1}` : `${colLetter(c)}${r + 1}`;
}

/** Rentang "D6:H6" (atau absolut "$D$6:$H$6"). */
export function range(r1: number, c1: number, r2: number, c2: number, abs = false): string {
  return `${addr(r1, c1, abs)}:${addr(r2, c2, abs)}`;
}

/** Nama sheet yang aman untuk Excel. */
export function sheetName(s: string): string {
  return s.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
}

// ---------- Format angka (gaya Indonesia) ----------

/** 0.2838 → "0,284" (d desimal, nol di belakang dibuang bila trim). */
export function num(x: number | null | undefined, d = 3, trim = false): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "–";
  let s = x.toFixed(d);
  if (trim && s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s.replace("-", "−").replace(".", ",");
}

// ---------- Pembangun grid ----------

export class GridBuilder {
  private cells = new Map<string, GridCell>();
  private _anchors: Record<string, string> = {};
  constructor(
    readonly id: string,
    readonly name: string,
    readonly title: string,
  ) {}

  /** Isi sel; mengembalikan alamat A1-nya. Memanggil ulang pada sel yang sama menimpa isinya. */
  set(r: number, c: number, v: GridCell["v"], opts: Omit<Partial<GridCell>, "r" | "c" | "v"> = {}): string {
    this.cells.set(`${r},${c}`, { r, c, v, ...opts });
    return addr(r, c);
  }

  /** Tulis satu baris nilai mulai kolom c (opsi yang sama untuk semua sel). */
  row(r: number, c: number, values: GridCell["v"][], opts: Omit<Partial<GridCell>, "r" | "c" | "v"> = {}) {
    values.forEach((v, i) => this.set(r, c + i, v, opts));
  }

  get(r: number, c: number): GridCell | undefined {
    return this.cells.get(`${r},${c}`);
  }

  /** Beri nama pada sel agar bisa dirujuk node lain lewat {{nodeKey!nama}}. */
  anchor(name: string, r: number, c: number) {
    this._anchors[name] = addr(r, c);
  }

  build(extra: Partial<Pick<Grid, "cols" | "freeze" | "chart" | "notes">> = {}): Grid {
    const cells = [...this.cells.values()].sort((a, b) => a.r - b.r || a.c - b.c);
    return { id: this.id, name: sheetName(this.name), title: this.title, cells, anchors: this._anchors, ...extra };
  }
}

/** Ukuran grid (jumlah baris dan kolom terpakai, termasuk sel gabungan). */
export function gridSize(g: Grid): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const x of g.cells) {
    rows = Math.max(rows, x.r + (x.rs ?? 1));
    cols = Math.max(cols, x.c + (x.cs ?? 1));
  }
  return { rows, cols };
}

/** Kunci path edit untuk mencocokkan riwayat perubahan: ["ratings",0,"v"] → "ratings.0.v". */
export const pathKey = (p: (string | number)[]) => p.join(".");

/** Sel berumus (untuk panel Perhitungan / laporan). */
export function formulaCells(g: Grid): GridCell[] {
  return g.cells.filter((x) => x.f || x.explain);
}

/** Bentuk dokumen ringkas (DOCX/PDF/pratinjau) — sama dengan lib/export/blocks.ts. */
export type Block =
  | { type: "title"; text: string; sub: string }
  | { type: "h1"; text: string }
  | { type: "h2"; text: string }
  | { type: "p"; text: string; italic?: boolean }
  | { type: "note"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "table"; head: string[]; rows: string[][]; widths?: number[] };

/** Penjelasan rumus untuk panel Perhitungan, laporan, dan dokumen. */
export type FormulaDoc = {
  /** Nama besaran, mis. "Skor IFAS". */
  name: string;
  /** Rumus dalam notasi biasa, mis. "Skor = Total rating × Bobot". */
  rumus: string;
  /** Arti untuk orang awam. */
  arti: string;
  /** Rumus Excel yang setara (opsional), mis. "=S6*C6". */
  excel?: string;
};
