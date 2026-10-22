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

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll E2E checks passed");
process.exit(failures ? 1 : 0);
