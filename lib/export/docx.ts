import "server-only";
import {
  AlignmentType, Document, Footer, HeadingLevel, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell,
  TableRow, TextRun, WidthType,
} from "docx";
import type { GrandDesignDoc } from "@/lib/grand-design/doc";
import { docToBlocks, type Block } from "./blocks";

/** Teks bisa memuat baris baru: satu paragraf per baris (TextRun tidak memecah baris baru). */
const lines = (text: string) => String(text ?? "").split(/\r?\n/);

function cell(text: string, head = false, width?: number) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: head ? { type: ShadingType.CLEAR, color: "auto", fill: "E8ECEF" } : undefined,
    children: lines(text).map((t) => new Paragraph({ children: [new TextRun({ text: t, bold: head, size: 18 })] })),
  });
}

function render(b: Block): (Paragraph | Table)[] {
  switch (b.type) {
    case "title":
      return [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(b.text)] }),
        new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: b.sub, italics: true, size: 18, color: "666666" })] }),
      ];
    case "h1":
      return [new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 280 }, children: [new TextRun(b.text)] })];
    case "h2":
      return [new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200 }, children: [new TextRun(b.text)] })];
    case "p":
      return lines(b.text).map((t) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t, italics: b.italic })] }));
    case "note":
      return [new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: b.text, italics: true, color: "8A5A00", size: 18 })] })];
    case "bullets":
      return b.items.map((t) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(t)] }));
    case "table":
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: b.head.map((h, i) => cell(h, true, b.widths?.[i])) }),
            ...b.rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, false, b.widths?.[i])) })),
          ],
        }),
        new Paragraph({ text: "" }),
      ];
  }
}

/** Ekspor DOCX: gaya judul, tabel, dan nomor halaman. */
export async function grandDesignDocx(doc: GrandDesignDoc): Promise<Buffer> {
  const d = new Document({
    creator: "Platform Eksperimen Alur Agen LLM",
    title: `Grand Design ${doc.projectName}`,
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: ["DRAF · Halaman ", PageNumber.CURRENT, " dari ", PageNumber.TOTAL_PAGES], size: 16, color: "888888" })],
              }),
            ],
          }),
        },
        children: docToBlocks(doc).flatMap(render),
      },
    ],
  });
  return Packer.toBuffer(d);
}
