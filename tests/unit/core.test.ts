// Unit tests for logic that needs no browser. Run: bun test tests/unit
import { describe, expect, test } from "bun:test";
import { parseMemoryCommand } from "../../src/lib/memory-commands";
import { makeThinkSplitter, extractRememberTags } from "../../src/lib/think";
import { relevantExcerpt, fileForModel } from "../../src/lib/attachments";
import { runnableLanguage } from "../../src/lib/coderun";

describe("memory commands", () => {
  const cases: [string, boolean, { action: string; content: string } | null][] = [
    ["Save to memory: I'm allergic to peanuts", true, { action: "save", content: "I'm allergic to peanuts" }],
    ["save this to memory", true, { action: "save", content: "" }],
    ["save it to memory please", true, { action: "save", content: "" }],
    ["I prefer short answers, save this to memory", true, { action: "save", content: "I prefer short answers" }],
    ["Simpan ke memori bahwa namaku Ari", true, { action: "save", content: "namaku Ari" }],
    ["tolong simpan ini ke memori", true, { action: "save", content: "" }],
    ["Remember that my cat is called Miso", true, { action: "save", content: "my cat is called Miso" }],
    ["Ingat ya, aku kerja di bank", true, { action: "save", content: "aku kerja di bank" }],
    ["add this to my memory: I live in Bandung", true, { action: "save", content: "I live in Bandung" }],
    ["Forget that I like jazz", true, { action: "forget", content: "I like jazz" }],
    ["Lupakan soal jazz", true, { action: "forget", content: "jazz" }],
    ["hapus nama kucing saya dari memori", true, { action: "forget", content: "nama kucing saya" }],
    ["Delete my cat's name from memory", false, { action: "forget", content: "my cat's name" }],
  ];
  for (const [text, loose, want] of cases) {
    test(text, () => expect(parseMemoryCommand(text, loose)).toEqual(want as never));
  }
  test("not commands", () => {
    for (const t of [
      "Do you remember when we talked?",
      "remember when we went to Bali?",
      "ingat gak kemarin kita bahas apa",
      "I will remember this day forever",
      "How do I save a file to memory in C?",
      "Forgetting my mom's birthday was embarrassing",
      "Remembered the keys today",
      "Ingatan saya buruk sekali",
    ]) expect(parseMemoryCommand(t, true)).toBeNull();
  });
  test("roleplay chats only take explicit commands", () => {
    expect(parseMemoryCommand("Remember that the dragon is asleep", false)).toBeNull();
    expect(parseMemoryCommand("Save to memory: I like tea", false)).toEqual({ action: "save", content: "I like tea" });
  });
  test("long input is ignored quickly", () => {
    const t0 = performance.now();
    expect(parseMemoryCommand("remember " + "a".repeat(5000))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("think splitter", () => {
  const run = (chunks: string[]) => {
    let text = "";
    let think = "";
    const s = makeThinkSplitter((t) => { text += t; }, (t) => { think += t; });
    for (const c of chunks) s.feed(c);
    s.flush();
    return { text, think };
  };
  test("tags split across chunks", () => {
    expect(run(["<th", "ink>step 1, ", "step 2</th", "ink>\n\nAnswer: 42"])).toEqual({ think: "step 1, step 2", text: "Answer: 42" });
  });
  test("no tags", () => expect(run(["Hello ", "world"])).toEqual({ think: "", text: "Hello world" }));
  test("empty think block", () => expect(run(["<think>\n\n</think>\n\nNo"])).toEqual({ think: "\n\n", text: "No" }));
  test("unfinished thinking is kept", () => expect(run(["<think>still thinking"])).toEqual({ think: "still thinking", text: "" }));
  test("text that only looks like a tag start", () => expect(run(["<b>bold</b>"])).toEqual({ think: "", text: "<b>bold</b>" }));
});

describe("remember tags", () => {
  test("extracted and removed", () => {
    const r = extractRememberTags("Sure, noted!\n[[remember: The user's sister is Rina]]");
    expect(r).toEqual({ text: "Sure, noted!", facts: ["The user's sister is Rina"] });
  });
  test("nothing to extract", () => expect(extractRememberTags("Hi").facts).toEqual([]));
});

describe("file excerpts", () => {
  const doc = Array.from({ length: 60 }, (_, i) => `Section ${i}. ` + (i === 41 ? "The budget for 2027 rises by twelve percent. " : "Ordinary text about other things. ").repeat(20)).join("\n");
  test("short files are kept whole", () => expect(relevantExcerpt("short", "q", 100)).toBe("short"));
  test("the relevant part of a long file is included", () => {
    const out = relevantExcerpt(doc, "How much does the budget rise in 2027?", 3000);
    expect(out.length).toBeLessThan(3200);
    expect(out).toContain("budget for 2027");
    expect(out).toContain("Section 0.");
  });
  test("without matches it reads from the start", () => {
    const out = relevantExcerpt(doc, "zzz", 2000);
    expect(out.startsWith("Section 0.")).toBe(true);
    expect(out.length).toBeGreaterThan(1500);
  });
  test("file header", () => expect(fileForModel("a.txt", "hello", 100)).toBe("[Attached file: a.txt]\nhello\n[End of file]"));
});

describe("code run", () => {
  test("languages", () => {
    expect(runnableLanguage("JavaScript")).toBe("js");
    expect(runnableLanguage("python3")).toBe("py");
    expect(runnableLanguage("rust")).toBeNull();
  });
});

import { resample, rms, SilenceDetector, detectLang, cleanForSpeech, splitForSpeech, cleanTranscript, concatAudio } from "../../src/lib/voice/audio";

describe("voice audio", () => {
  test("resample 48k to 16k keeps duration and level", () => {
    const sine = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5);
    const out = resample(sine, 48000);
    expect(out.length).toBe(16000);
    expect(Math.abs(rms(out) - rms(sine))).toBeLessThan(0.05);
  });
  test("resample same rate is a no-op", () => {
    const a = new Float32Array([0.1, 0.2]);
    expect(resample(a, 16000)).toBe(a);
  });
  test("concat", () => expect(Array.from(concatAudio([new Float32Array([1]), new Float32Array([2, 3])]))).toEqual([1, 2, 3]));
  test("silence detector ends a turn after speech then quiet", () => {
    const d = new SilenceDetector({ endSilence: 1, minSpeech: 0.2 });
    const states: string[] = [];
    for (let i = 0; i < 10; i++) states.push(d.push(0.002, 0.1)); // room noise
    for (let i = 0; i < 10; i++) states.push(d.push(0.1, 0.1)); // talking
    for (let i = 0; i < 12; i++) states.push(d.push(0.002, 0.1)); // quiet
    expect(states.slice(0, 10).every((s) => s === "waiting")).toBe(true);
    expect(states).toContain("speaking");
    expect(states[states.length - 1]).toBe("done");
  });
  test("silence detector gives up without speech", () => {
    const d = new SilenceDetector({ maxWait: 2 });
    let s = "";
    for (let i = 0; i < 25; i++) s = d.push(0.001, 0.1);
    expect(s).toBe("nothing");
  });
  test("steady noise is not speech", () => {
    const d = new SilenceDetector({ maxWait: 3 });
    let s = "";
    for (let i = 0; i < 35; i++) s = d.push(0.008 + (i % 2) * 0.001, 0.1);
    expect(s).toBe("nothing");
  });
});

describe("voice text", () => {
  test("language guess", () => {
    expect(detectLang("Halo, apa kabar? Saya ingin tahu cara membuat nasi goreng yang enak.")).toBe("id");
    expect(detectLang("What is the weather like in Jakarta today?")).toBe("en");
    expect(detectLang("Bagaimana menurutmu tentang film itu?")).toBe("id");
  });
  test("markdown cleaned for speech", () => {
    const t = cleanForSpeech("## Title\n**Bold** and `code` and [a link](https://x.y).\n```js\nconsole.log(1)\n```\n- item one\nSee https://example.com [1] 😀");
    expect(t).not.toMatch(/[#*`]|https?:|😀|\[1\]/);
    expect(t).toContain("Bold and code and a link.");
    expect(t).toContain("(code)");
    expect(t).toContain("item one");
  });
  test("think blocks are not read", () => expect(cleanForSpeech("<think>hidden</think>Answer")).toBe("Answer"));
  test("long text split at sentences", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const parts = splitForSpeech(text, 120);
    expect(parts.every((p) => p.length <= 120)).toBe(true);
    expect(parts.join(" ")).toBe(text);
  });
  test("very long sentence split", () => {
    const parts = splitForSpeech("word ".repeat(200).trim(), 100);
    expect(parts.every((p) => p.length <= 101)).toBe(true);
    expect(parts.join(" ").split(" ").length).toBe(200);
  });
  test("whisper silence hallucinations dropped", () => {
    expect(cleanTranscript(" Terima kasih telah menonton! ")).toBe("");
    expect(cleanTranscript("[Music]")).toBe("");
    expect(cleanTranscript("  Halo   dunia ")).toBe("Halo dunia");
  });
});
