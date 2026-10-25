// End-to-end test of the web build with a mocked AI provider (no keys, no network).
// Run after `bun run build`:  node tests/e2e.mjs
// Uses Playwright's Chromium (or PW_CHROMIUM=/path/to/chromium).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fx = (f) => path.join(root, "tests", "fixtures", f);
const PORT = 4179;
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* starting */ }
  await wait(250);
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// --- Mock provider (Ollama-style OpenAI API) ---
const reqs = [];
let nextReply = "Okay!";
await ctx.route("http://localhost:11434/**", (r) => {
  const req = JSON.parse(r.request().postData() || "{}");
  reqs.push(req);
  if (!req.stream) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: "NONE" } }] }) });
  const chunks = nextReply.match(/[\s\S]{1,7}/g) ?? [];
  const body = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  r.fulfill({ status: 200, contentType: "text/event-stream", body });
});
const cors = { "access-control-allow-origin": "*" };
await ctx.route("https://html.duckduckgo.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", headers: cors, body:
  `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Rate today</a><a class="result__snippet">USD is 16.250 today.</a></div>` }));
await ctx.route("https://example.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", headers: cors, body: "<title>A</title><article><p>Page body text 16.250</p></article>" }));

const lastStream = () => reqs.filter((r) => r.stream).pop();
const lastUser = () => {
  const m = lastStream().messages.filter((x) => x.role === "user").pop();
  return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "[IMG]")).join("|");
};
const send = async (text, ms = 1800) => {
  await page.locator("textarea").first().fill(text);
  await page.keyboard.press("Enter");
  await wait(ms);
};

// Headless Chromium has no voices: a fake speech synthesis records what is read aloud.
await page.addInitScript(() => {
  window.__spoken = [];
  const fake = { speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 50); }, cancel() {}, getVoices() { return []; } };
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
await page.locator(".settings-head md-icon-button").click();
await wait(300);
await page.locator(".model-chip").click();
await page.locator(".model-option", { hasText: "llama3.2" }).click();

// 1. Attachments for any model
await page.locator("form input[type=file]").setInputFiles([fx("note.txt"), fx("report.docx"), fx("invoice.pdf"), fx("red.png")]);
await wait(3000);
check("4 attachments ready", (await page.locator(".attachment-preview").count()) === 4);
await send("Summarize these files");
const u = lastUser();
check("text file sent", u.includes("TXT-3141"));
check("Word file sent", u.includes("DOCX-5521"));
check("PDF text sent", u.includes("PDF-7788"));
check("picture sent", u.includes("[IMG]"));
check("date in system prompt", /Current date and time/.test(lastStream().messages[0].content));

// 2. Thinking tags go to the Thinking box
nextReply = "<think>Let me add 40 and 2.</think>The answer is 42.";
await send("What is 40+2?");
const lastBubble = page.locator(".message-model").last();
check("thinking box shown", (await lastBubble.locator(".message-thinking").count()) === 1);
check("answer without tags", (await lastBubble.innerText()).includes("The answer is 42.") && !(await lastBubble.innerText()).includes("<think>"));

// 3. Run JavaScript from a reply
nextReply = "Here:\n```js\nconsole.log(6 * 7)\n```";
await send("Write JS that prints 6*7");
await page.locator(".md-code-run").last().click();
await wait(1500);
check("JS Run output", ((await page.locator(".md-code-output").last().innerText().catch(() => "")) || "").includes("42"));

// 3b. Run code can't read the app's data (sandboxed, empty origin)
nextReply = "```js\nlet r = 'readable';\ntry { await new Promise((ok, no) => { const q = indexedDB.open('talkdude'); q.onsuccess = ok; q.onerror = no; }); } catch (e) { r = 'blocked'; }\nconsole.log(r)\n```";
await send("check storage");
await page.locator(".md-code-run").last().click();
await wait(1500);
check("Run is sandboxed", ((await page.locator(".md-code-output").last().innerText().catch(() => "")) || "").includes("blocked"));

// 3c. A double tap sends only once
nextReply = "Once.";
const before = await page.locator(".message-user").count();
await page.locator("textarea").first().fill("double tap test");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await wait(1500);
check("double tap sends once", (await page.locator(".message-user").count()) === before + 1);

// 4. Web search and links for a non-Gemini model
nextReply = "Okay!";
await page.locator(".toolbar-menu-anchor md-icon-button").first().click();
await wait(200);
await page.locator(".tool-toggle", { hasText: "Web search" }).click();
await page.locator(".tool-toggle", { hasText: "Read links" }).click();
await page.locator(".popup-backdrop").first().click({ force: true }).catch(() => {});
await send("dollar rate today? see https://example.com/a", 3000);
const sys = lastStream().messages[0].content;
check("search results in prompt", sys.includes("USD is 16.250"));
check("link page read", sys.includes("Page body text"));
await page.locator(".toolbar-menu-anchor md-icon-button").first().click();
await wait(200);
await page.locator(".tool-toggle", { hasText: "Web search" }).click();
await page.locator(".tool-toggle", { hasText: "Read links" }).click();
await page.locator(".popup-backdrop").first().click({ force: true }).catch(() => {});

// 5. Memory: save, undo, save again, use, forget
await send("Save to memory: I live in Bandung and work at a bank");
check("saved toast", (await page.locator(".snackbar").innerText().catch(() => "")).includes("Saved to memory"));
await page.locator(".snackbar-action").click().catch(() => {});
await wait(300);
await send("Where do I live?");
check("undo removed the note", !lastStream().messages[0].content.includes("Bandung"));
await send("Save to memory: I live in Bandung and work at a bank");
await send("What do I drink? I like coffee lately");
check("note used later", lastStream().messages[0].content.includes("Bandung"));
await send("Forget that I live in Bandung");
check("removed toast", (await page.locator(".snackbar").innerText().catch(() => "")).includes("Removed from memory"));

// 6. AI-detected memory ("[[remember: …]]")
nextReply = "Got it!\n[[remember: The user's sister is called Rina]]";
await send("Please keep in mind my sister is called Rina");
check("remember tag hidden", !(await page.locator(".message-model").last().innerText()).includes("[[remember"));
check("remember tag saved", (await page.locator(".snackbar").innerText().catch(() => "")).includes("Rina"));

// 7. Voice: read aloud, and the mic asks for the one-time download first
nextReply = "**Hello** there! Visit https://example.com for more.";
await send("Say hello");
await page.locator(".message-model .read-aloud-btn").last().click();
await wait(500);
const spoken = await page.evaluate(() => window.__spoken.join(" "));
check("read aloud speaks clean text", spoken.includes("Hello there!") && !spoken.includes("**") && !spoken.includes("https"), spoken);
await page.evaluate(() => localStorage.setItem("talkdude_tts_auto", "1"));
await page.reload();
await wait(1500);
await page.evaluate(() => { window.__spoken = []; });
nextReply = "Auto reading works.";
await send("Read this one aloud automatically");
await wait(800);
check("answers read aloud automatically", (await page.evaluate(() => window.__spoken.join(" "))).includes("Auto reading works."));
await page.evaluate(() => localStorage.setItem("talkdude_tts_auto", "0"));
await page.locator(".mic-btn").click();
await wait(300);
check("mic offers the voice download", (await page.locator(".voice-banner .voice-setup").count()) === 1);
await page.locator(".voice-banner button", { hasText: "Not now" }).click();
await page.locator(".voice-chat-btn").click();
await wait(300);
check("voice chat opens", (await page.locator(".voice-mode .voice-setup").count()) === 1);
await page.locator(".voice-mode button", { hasText: "Not now" }).click();
await wait(200);
check("voice chat closes", (await page.locator(".voice-mode").count()) === 0);

// 8. Edited message versions stay right after leaving the chat and coming back
const newChat = () => page.locator(".chat-topbar md-icon-button", { has: page.locator("md-icon", { hasText: "edit_square" }) }).click();
await newChat();
await wait(400);
nextReply = "Reply A.";
await send("Version test question one");
await page.locator(".message-user").last().hover();
await page.locator(".message-user").last().locator("md-icon-button", { has: page.locator("md-icon", { hasText: /^edit$/ }) }).click();
await page.locator("textarea").first().fill("Version test question two");
nextReply = "Reply B.";
await page.keyboard.press("Enter");
await wait(1800);
const indicator = () => page.locator(".message-user .branch-indicator").last().innerText().catch(() => "");
check("edit makes 2 versions", (await indicator()) === "2/2", await indicator());
const branchBtn = (icon) => page.locator(".message-user .branch-nav md-icon-button", { has: page.locator("md-icon", { hasText: icon }) }).last();
await branchBtn("chevron_left").click();
await wait(800);
check("previous version shown", (await indicator()) === "1/2", await indicator());
await branchBtn("chevron_right").click();
await wait(800);
check("back to the newest version", (await indicator()) === "2/2", await indicator());
nextReply = "Follow-up reply.";
await send("A follow-up message");
// Reopen the app (state is rebuilt from the database) and open the chat again
await page.reload();
await wait(1500);
if ((await page.locator(".message-user").count()) === 0) {
  await page.locator(".sidebar-toggle").click();
  await wait(500);
  // The newest chat is listed first (titles come from the mocked AI, so don't match on them).
  await page.locator(".conversation-item").first().click();
  await wait(800);
}
check("versions still 2/2 after reopening", (await indicator()) === "2/2", await indicator());
check("follow-up kept on the current version", (await page.locator(".message-model").last().innerText()).includes("Follow-up reply."));

// 9. A shorter note doesn't replace a more detailed one
nextReply = "Noted.";
await send("Save to memory: I work at Bank Mega as an independent commissioner and chair the risk monitoring committee");
await send("Save to memory: I work at a bank");
check("detailed note kept", (await page.locator(".snackbar").innerText().catch(() => "")).includes("Bank Mega"), await page.locator(".snackbar").innerText().catch(() => ""));

// 10. An empty answer (e.g. blocked by the provider) is explained, not silent
nextReply = "";
await send("This gets an empty answer");
check("empty answer explained", (await page.locator("body").innerText()).includes("empty answer"));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll E2E checks passed");
process.exit(failures ? 1 : 0);
