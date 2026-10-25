// Voice test with the real Whisper model (not run in CI: it needs the model files).
//   WHISPER_DIR=/path/to/whisper-base  (config.json, tokenizer.json, … and onnx/*_quantized.onnx)
//   node tests/voice.mjs speech.wav      (16-bit PCM WAV with a spoken sentence and ~3 s of silence at the end)
// Run `bun run build` first. Uses Playwright's Chromium (or PW_CHROMIUM=/path/to/chromium).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WHISPER_DIR = process.env.WHISPER_DIR;
if (!WHISPER_DIR || !process.argv[2]) { console.error("Usage: WHISPER_DIR=… node tests/voice.mjs speech.wav"); process.exit(2); }
const ORT = path.join(root, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm");
const audio = path.resolve(process.argv[2]);
const PORT = 4188;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!ok) fails++; };
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore" });
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await wait(250); }
const browser = await chromium.launch({ ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}), args: [
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audio}`, "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone", "camera"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/error|warn/i.test(m.type())) console.log("console:", m.text().slice(0, 300)); });
const served = [];
const cors = { "access-control-allow-origin": "*" };
await ctx.route("https://huggingface.co/**", (r) => {
  const u = new URL(r.request().url());
  const m = u.pathname.match(/^\/onnx-community\/whisper-base\/resolve\/main\/(.+)$/);
  const f = m && path.join(WHISPER_DIR, m[1]);
  if (f && fs.existsSync(f)) { served.push(m[1]); return r.fulfill({ status: 200, headers: { ...cors, "content-type": "application/octet-stream" }, body: fs.readFileSync(f) }); }
  served.push("404 " + u.pathname);
  return r.fulfill({ status: 404, headers: cors, body: "not found" });
});
await ctx.route("https://cdn.jsdelivr.net/npm/onnxruntime-web@*/dist/*.wasm", (r) => { served.push("ort.wasm"); r.fulfill({ status: 200, headers: { ...cors, "content-type": "application/wasm" }, body: fs.readFileSync(ORT) }); });
const reqs = [];
let nextReply = "Sure! Here is a simple answer.";
await ctx.route("http://localhost:11434/**", (r) => {
  const req = JSON.parse(r.request().postData() || "{}");
  reqs.push(req);
  if (!req.stream) return r.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: "NONE" } }] }) });
  const body = (nextReply.match(/[\s\S]{1,7}/g) ?? []).map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  r.fulfill({ status: 200, headers: cors, contentType: "text/event-stream", body });
});
await page.addInitScript(() => {
  // Headless Chromium has no voices; fake speech synthesis so read-aloud finishes.
  window.__spoken = [];
  const fake = { speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 300); }, cancel() {}, getVoices() { return []; }, speaking: false, pending: false, paused: false };
  Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
});
await page.goto(`http://localhost:${PORT}/`);
await wait(1200);
await page.getByText("Other providers").click();
await wait(300);
await page.getByText("Add provider").click();
await page.locator(".preset-item", { hasText: "Ollama local" }).click();
await page.locator(".settings-form button[type=submit]").click();
await wait(200);
// Voice tab: download voice input
await page.locator(".settings-tab", { hasText: "Voice" }).click();
await wait(300);
await page.locator(".voice-setup button", { hasText: "Download" }).click();
const t0 = Date.now();
await page.waitForFunction(() => document.body.innerText.includes("Whisper Base · downloaded"), null, { timeout: 180000 }).catch(() => {});
check("voice input downloaded", (await page.locator("text=Whisper Base · downloaded").count()) > 0, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log("served:", served.join(", "));
await page.locator(".settings-head md-icon-button").click();
await wait(300);
await page.locator(".model-chip").click();
await page.locator(".model-option", { hasText: "llama3.2" }).click();
// Dictation
await page.locator(".mic-btn").click();
await wait(500);
check("listening state", (await page.locator(".dictation-status").innerText().catch(() => "")).includes("Listening"));
const t1 = Date.now();
await page.waitForFunction(() => (document.querySelector("textarea.chat-input")?.value ?? "").length > 3, null, { timeout: 120000 }).catch(() => {});
const said = await page.locator("textarea.chat-input").inputValue();
check("dictation wrote text", said.length > 3, `"${said}" (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
await page.locator("textarea.chat-input").fill("");
// Voice chat
await page.locator('.voice-chat-btn').click();
await wait(500);
const before = reqs.filter((r) => r.stream).length;
await page.waitForFunction(() => (window.__spoken ?? []).length > 0, null, { timeout: 150000 }).catch(() => {});
const streams = reqs.filter((r) => r.stream);
const lastUser = streams.length ? streams[streams.length - 1].messages.filter((m) => m.role === "user").pop() : null;
check("voice chat sent what was heard", streams.length > before, lastUser ? JSON.stringify(lastUser.content).slice(0, 120) : "");
console.log("voice status:", await page.locator(".voice-status").innerText().catch(() => "-"), "| error:", await page.locator(".voice-error").innerText().catch(() => "-"), "| answer:", await page.locator(".voice-answer").innerText().catch(() => "-"), "| tts:", await page.evaluate(() => "speechSynthesis" in window));
check("voice chat read the answer", (await page.evaluate(() => window.__spoken.join(" "))).includes("simple answer"));
// Camera: the next turn carries a photo
const n0 = reqs.filter((r) => r.stream).length;
await page.locator(".voice-controls md-icon-button").first().click();
await wait(800);
check("camera preview on", await page.evaluate(() => { const v = document.querySelector(".voice-video"); return !!v && v.style.display !== "none" && v.videoWidth > 0; }));
await page.waitForFunction((n) => true, n0);
await page.waitForTimeout(1000);
for (let i = 0; i < 120 && reqs.filter((r) => r.stream).length <= n0; i++) await wait(1000);
const withPhoto = reqs.filter((r) => r.stream).slice(n0).some((r) => JSON.stringify(r.messages[r.messages.length - 1]).includes("image_url"));
check("voice chat sent a camera photo", withPhoto);
await page.locator(".voice-end").click();
await wait(300);
console.log("streams:", reqs.filter((r) => r.stream).length, "msgs:", await page.locator(".message-model").count(), await page.locator(".message-user").count());
check("voice chat closed", (await page.locator(".voice-mode").count()) === 0);
// Read aloud button
await page.locator('.message-model .read-aloud-btn').last().click();
await wait(800);
check("read aloud button", (await page.evaluate(() => window.__spoken.length)) >= 2);
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.kill();
console.log(fails ? `${fails} failed` : "All voice checks passed");
process.exit(fails ? 1 : 0);
