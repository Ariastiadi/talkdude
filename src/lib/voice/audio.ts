/**
 * Small, pure helpers for voice: resampling microphone audio for Whisper,
 * detecting when someone stops talking, guessing the reply language and
 * turning markdown into text that sounds right when read aloud.
 * (No browser APIs here, so they can be unit-tested.)
 */

/** Whisper wants mono audio at 16 kHz. */
export const WHISPER_RATE = 16000;

/** Downsamples (or upsamples) mono audio with simple averaging / linear steps. */
export function resample(input: Float32Array, fromRate: number, toRate = WHISPER_RATE): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  if (ratio > 1) {
    // Downsampling: average the samples that fall into each output slot (a cheap low-pass).
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = end > start ? sum / (end - start) : input[Math.min(start, input.length - 1)];
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const t = pos - j;
      const a = input[j];
      const b = input[Math.min(j + 1, input.length - 1)];
      out[i] = a + (b - a) * t;
    }
  }
  return out;
}

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / frame.length);
}

/** Joins recorded chunks into one buffer. */
export function concatAudio(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export interface SilenceOptions {
  /** Seconds of quiet after speech that end a turn. */
  endSilence?: number;
  /** Seconds of speech needed before a turn counts. */
  minSpeech?: number;
  /** Give up after this many seconds without any speech. */
  maxWait?: number;
  /** Hard limit for one turn, in seconds. */
  maxTurn?: number;
}

/**
 * Decides when a spoken turn starts and ends from frame loudness. The noise
 * floor adapts to the room, so a fan or street noise doesn't count as speech.
 */
export class SilenceDetector {
  private floor = 0.004;
  private speech = 0;
  private quiet = 0;
  private waited = 0;
  private total = 0;
  started = false;
  constructor(private opts: SilenceOptions = {}) {}

  /** Feeds one frame; returns "speaking", "waiting", "done" (turn over) or "nothing" (no speech came). */
  push(level: number, seconds: number): "waiting" | "speaking" | "done" | "nothing" {
    const { endSilence = 1.3, minSpeech = 0.25, maxWait = 12, maxTurn = 60 } = this.opts;
    this.total += seconds;
    const threshold = Math.max(0.012, this.floor * 3);
    const loud = level > threshold;
    if (!loud) this.floor = this.floor * 0.95 + level * 0.05;
    if (loud) {
      this.speech += seconds;
      this.quiet = 0;
      if (this.speech >= minSpeech) this.started = true;
    } else {
      this.quiet += seconds;
      if (!this.started) this.waited += seconds;
    }
    if (this.started && (this.quiet >= endSilence || this.total >= maxTurn)) return "done";
    if (!this.started && this.waited >= maxWait) return "nothing";
    return this.started ? "speaking" : "waiting";
  }
}

// === Language ===

const ID_WORDS = new Set(("yang dan tidak ini itu saya aku kamu anda untuk dengan adalah apa bisa ada akan juga sudah kita " +
  "kami mereka dari ke di pada atau jika kalau karena tapi tetapi lebih sangat banyak satu dua hari bagaimana kenapa mengapa " +
  "dia ya tolong terima kasih baik bukan belum sedang harus boleh mau ingin seperti saat oleh agar supaya jadi lagi").split(" "));
const EN_WORDS = new Set(("the and is are was were to of in that it you i for on with as this be have not but what can will " +
  "your my they we he she there about would should could do does how why when which from an or if so just").split(" "));

/** Guesses whether text is Indonesian or English (the two languages talkdude speaks most). */
export function detectLang(text: string): "id" | "en" {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  let id = 0;
  let en = 0;
  for (const w of words.slice(0, 400)) {
    if (ID_WORDS.has(w)) id++;
    if (EN_WORDS.has(w)) en++;
    if (/^(me[mn]|ber|ter|di)[a-z]{3,}(kan|an|nya)$/.test(w)) id += 0.5;
  }
  return id > en ? "id" : "en";
}

export function speechLocale(lang: "id" | "en"): string {
  return lang === "id" ? "id-ID" : "en-US";
}

// === Text for reading aloud ===

/** Removes markdown, code, links and emoji so the text sounds natural when spoken. */
export function cleanForSpeech(md: string): string {
  return md
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, " ").replace(/-{3,}/g, " "))
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\[\d+\]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Splits text into pieces of at most `max` characters, at sentence ends where possible. */
export function splitForSpeech(text: string, max = 220): string[] {
  const out: string[] = [];
  const sentences = text.split(/(?<=[.!?…。])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  let cur = "";
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const s of sentences) {
    if (s.length > max) {
      flush();
      let rest = s;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(",", max);
        if (cut < max / 3) cut = rest.lastIndexOf(" ", max);
        if (cut < max / 3) cut = max;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      cur = rest;
    } else if ((cur + " " + s).length > max) {
      flush();
      cur = s;
    } else {
      cur = cur ? cur + " " + s : s;
    }
  }
  flush();
  return out;
}

/** Whisper sometimes "hears" these in silence or noise; drop them. */
const HALLUCINATIONS = [
  /^\s*(terima kasih( telah menonton| sudah menonton)?|thanks? for watching|thank you( for watching)?|you)[.!\s]*$/i,
  /^\s*[[(]?\s*(music|musik|applause|silence|tepuk tangan|♪+)\s*[\])]?\s*$/i,
  /^\s*(subtitle[s]? by|sub(titles)? oleh|teks oleh).*$/i,
];

export function cleanTranscript(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || HALLUCINATIONS.some((r) => r.test(t))) return "";
  return t;
}
