/**
 * Attachments for every AI (not just Gemini): files are read on the device and
 * sent to the model as text (documents, code, PDFs, Word files) or as a small
 * picture (for models that can see images). Nothing is uploaded anywhere
 * except to the AI provider you chose, as part of your message.
 */

export type LocalFile =
  | { kind: "text"; name: string; mimeType: string; text: string; truncated: boolean }
  | { kind: "image"; name: string; mimeType: string; data: string; preview: string };

/** Longest text kept per file (the model gets a shorter slice that fits its memory). */
export const MAX_STORED_CHARS = 200_000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_PDF_PAGES = 80;

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "py", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cs", "go", "rs", "rb", "php", "swift", "sh", "bat", "ps1", "sql",
  "yml", "yaml", "toml", "ini", "cfg", "conf", "log", "tex", "srt", "vtt", "gradle", "properties", "env", "lua", "dart", "r",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function isTextLike(file: File): boolean {
  const t = file.type;
  return (
    t.startsWith("text/") ||
    /json|xml|javascript|typescript|yaml|x-sh|csv|x-python|x-java|x-c/.test(t) ||
    TEXT_EXT.has(extOf(file.name))
  );
}

function cap(text: string): { text: string; truncated: boolean } {
  const t = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/\n{4,}/g, "\n\n\n");
  return t.length > MAX_STORED_CHARS ? { text: t.slice(0, MAX_STORED_CHARS), truncated: true } : { text: t, truncated: false };
}

// === Images ===

async function readImage(file: File): Promise<LocalFile> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(`Couldn't read the picture “${file.name}”. Try a JPG or PNG.`);
  }
  const MAX = 1024;
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const url = canvas.toDataURL("image/jpeg", 0.82);
  return { kind: "image", name: file.name, mimeType: "image/jpeg", data: url.slice(url.indexOf(",") + 1), preview: url };
}

// === Word (.docx): a zip with word/document.xml ===

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zipEntry(buf: Uint8Array, wanted: string): Promise<Uint8Array | null> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + csize);
      return method === 0 ? raw : method === 8 ? inflateRaw(raw) : null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function xmlText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function readDocx(file: File): Promise<LocalFile> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const xml = await zipEntry(buf, "word/document.xml");
  if (!xml) throw new Error(`Couldn't open “${file.name}”. Is it a Word (.docx) file?`);
  const { text, truncated } = cap(xmlText(new TextDecoder().decode(xml)));
  if (!text.trim()) throw new Error(`“${file.name}” has no text in it.`);
  return { kind: "text", name: file.name, mimeType: file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text, truncated };
}

// === PDF (pdf.js, loaded only when a PDF is attached) ===

async function readPdf(file: File): Promise<LocalFile> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch {
    throw new Error(`Couldn't open “${file.name}”. The PDF may be damaged or password-protected.`);
  }
  let out = "";
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
  for (let i = 1; i <= pages && out.length < MAX_STORED_CHARS; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    for (const it of content.items) {
      if ("str" in it) line += it.str + (it.hasEOL ? "\n" : " ");
    }
    out += line.trim() + "\n\n";
  }
  const { text, truncated } = cap(out);
  if (!text.trim()) throw new Error(`“${file.name}” has no selectable text (maybe a scan). Try a text-based PDF.`);
  return { kind: "text", name: file.name, mimeType: "application/pdf", text, truncated: truncated || doc.numPages > pages };
}

// === Entry point ===

export async function readLocalFile(file: File): Promise<LocalFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`“${file.name}” is too big (over 30 MB).`);
  const ext = extOf(file.name);
  if (file.type.startsWith("image/")) return readImage(file);
  if (file.type === "application/pdf" || ext === "pdf") return readPdf(file);
  if (ext === "docx" || file.type.includes("wordprocessingml")) return readDocx(file);
  if (isTextLike(file)) {
    const { text, truncated } = cap(await file.text());
    if (!text.trim()) throw new Error(`“${file.name}” is empty.`);
    return { kind: "text", name: file.name, mimeType: file.type || "text/plain", text, truncated };
  }
  throw new Error(`“${file.name}” isn't supported here. Use pictures, PDF, Word (.docx) or text and code files.`);
}

/** How much of a file's text goes to the model, so it fits the model's memory. */
export function fileForModel(name: string, text: string, budget: number): string {
  const body = text.length > budget ? text.slice(0, budget) + "\n[… the rest of the file was left out to fit this model]" : text;
  return `[Attached file: ${name}]\n${body}\n[End of file]`;
}
