/**
 * Many open models (Qwen 3/3.5, DeepSeek R1 and others) write their reasoning
 * between <think> and </think> before the answer. This splits a text stream so
 * the reasoning goes to the "Thinking" box and only the answer stays in the reply.
 * Works when the tags arrive split across chunks.
 */
export function makeThinkSplitter(onText: (t: string) => void, onThinking: (t: string) => void) {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let mode: "start" | "think" | "text" = "start";
  let buf = "";

  const feed = (chunk: string): void => {
    buf += chunk;
    while (buf) {
      if (mode === "text") {
        onText(buf);
        buf = "";
        return;
      }
      if (mode === "start") {
        const t = buf.replace(/^\s+/, "");
        if (t.startsWith(OPEN)) {
          buf = t.slice(OPEN.length);
          mode = "think";
          continue;
        }
        if (OPEN.startsWith(t)) return; // might still become "<think>"
        mode = "text";
        continue;
      }
      // mode === "think"
      const end = buf.indexOf(CLOSE);
      if (end !== -1) {
        if (end > 0) onThinking(buf.slice(0, end));
        buf = buf.slice(end + CLOSE.length).replace(/^\s+/, "");
        mode = "text";
        continue;
      }
      // Keep a tail that could be the start of "</think>".
      const keep = CLOSE.length - 1;
      if (buf.length > keep) {
        onThinking(buf.slice(0, buf.length - keep));
        buf = buf.slice(buf.length - keep);
      }
      return;
    }
  };

  const flush = (): void => {
    if (!buf) return;
    if (mode === "think") onThinking(buf);
    else onText(buf);
    buf = "";
  };

  return { feed, flush };
}

/** Removes "[[remember: …]]" lines the AI adds when asked to remember something. */
export function extractRememberTags(text: string): { text: string; facts: string[] } {
  const facts: string[] = [];
  const out = text.replace(/\[\[\s*(?:remember|ingat)\s*:\s*([^\]]{3,300})\]\]\s*/gi, (_m, f: string) => {
    facts.push(f.trim());
    return "";
  });
  return { text: out.trimEnd(), facts };
}
