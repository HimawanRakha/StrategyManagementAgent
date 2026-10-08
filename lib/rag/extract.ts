import "server-only";

/** Ekstrak teks mentah dari PDF (pdf-parse), DOCX (mammoth), atau TXT/MD. */
export async function extractText(filename: string, data: Buffer): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      const res = await parser.getText();
      return res.text;
    } finally {
      await parser.destroy();
    }
  }
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const res = await mammoth.extractRawText({ buffer: data });
    return res.value;
  }
  if (ext === "txt" || ext === "md") return data.toString("utf8");
  throw new Error(`Format file .${ext} belum didukung (pakai PDF, DOCX, atau TXT)`);
}
