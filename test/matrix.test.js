#!/usr/bin/env node
// Safety matrix: every tool the MCP server exposes, checked against
//   (a) the current page on a disallowed host  -> host error, no page data
//   (b) focus / target on a sensitive field     -> value never returned, nothing typed
//   (c) the page moving off the allow-list      -> refused after the call, tab sent to about:blank
//
// The tool list is read from the MCP server's own registry, so a new tool
// fails this test until it is given a row below.
//
//   node test/matrix.test.js

const assert = require("assert");
const path = require("path");
const { findChromium, connectBrowser } = require("../engine/cdp");
const { createBrowserController } = require("../engine/browser");
const { makeTmp, startDemo } = require("./tmp");

const exe = process.env.BTR_CHROME_PATH || findChromium();
if (!exe) { console.log("\nSKIPPED matrix test: no Chromium-based browser found (set BTR_CHROME_PATH)\n"); process.exit(0); }

const SECRETS = ["4111 1111 1111 1111", "4111", "5500 0000 0000 0004", "737", "ZZ-998877-Q", "demo-secret-pw", "Test Holder", "card-note-5555"];
const DISALLOWED_DATA = ["Payment details", "/payment", "ORD-2026-0042", ...SECRETS];
const hostError = (r) => !!r && r.refused === true && /host not allowed/.test(r.reason || "");
const strip = (r) => (r && r.image_base64 ? { ...r, image_base64: "(image)" } : r);

// Batch tools act through skills on the skill's own origin (host-checked in the
// engine and covered by test/engine.test.js); they never read the browser's
// current page.
const BATCH = ["list_skills", "describe_skill", "list_queue", "harvest", "get_harvest", "submit_verdicts", "act", "approve_live", "run_status", "read_audit_log", "verify"];

async function main() {
  const demo = await startDemo();
  const BASE = demo.base, OFF = `http://localhost:${demo.port}`;
  const tmp = makeTmp("btr-matrix-");
  const connection = connectBrowser({ launch: true, executablePath: exe, headless: true, userDataDir: path.join(tmp, "profile") });
  const b = createBrowserController({ connection, allowHosts: ["127.0.0.1"], allowEvaluate: true, logDir: path.join(tmp, "logs"), timeoutMs: 1500 });
  const browser = await connection.get();

  // Tool list from the real MCP server registry.
  const { buildServer } = await import("../mcp/server.mjs");
  const server = buildServer({ engine: {}, browser: b, allowHosts: b.allowHosts });
  const tools = Object.keys(server._registeredTools).sort();
  const browserTools = tools.filter((t) => typeof b[t] === "function");
  const unknown = tools.filter((t) => !BATCH.includes(t) && !browserTools.includes(t));
  assert.deepStrictEqual(unknown, [], "tools that are neither batch nor browser tools: " + unknown);

  // ---- arguments per tool. A new browser tool without a row fails here. ----
  const A = { // (a) on a disallowed page
    list_pages: {}, new_page: { url: OFF + "/payment" }, select_page: null /* filled in */, close_page: null,
    navigate: { action: "reload" }, snapshot: {}, screenshot: {}, find: { text: "Card number" },
    click: { selector: "button" }, fill: { selector: "#ref", value: "x" }, type_text: { text: "x" },
    press_key: { key: "Tab" }, select_option: { selector: "select", value: "x" }, hover: { selector: "h1" },
    wait_for: { selector: "h1", timeout: 2000 }, extract: { selector: "h1" }, evaluate: { js: "return document.title", confirm: true },
    get_text: {}, get_attribute: { selector: "#cardnumber", name: "value" }, query_all: { selector: "input", attributes: ["value"] },
    upload_file: { selector: "input", path: __filename }, get_network: {}, get_console: {},
    run_plan: { steps: [{ tool: "snapshot" }] },
  };
  const S = { // (b) focus and target on #cardnumber
    list_pages: {}, new_page: { url: BASE + "/payment" }, select_page: null, close_page: "skip",
    navigate: { action: "reload" }, snapshot: {}, screenshot: {}, find: { text: "Card number" },
    click: { selector: "#cardnumber" }, fill: { selector: "#cardnumber", value: "9999" }, type_text: { text: "9999" },
    press_key: { key: "9" }, select_option: { selector: "#cardnumber", value: "9999" }, hover: { selector: "#cardnumber" },
    wait_for: { selector: "#cardnumber", timeout: 2000 }, extract: { selector: "#cardnumber" }, evaluate: { js: "return 1" },
    get_text: { selector: "#cardnumber" }, get_attribute: { selector: "#cardnumber", name: "value" },
    query_all: { selector: "#cardnumber", attributes: ["value"] }, upload_file: { selector: "#cardnumber", path: __filename },
    get_network: {}, get_console: {}, run_plan: { steps: [{ tool: "get_text", args: { selector: "#cardnumber" } }, { tool: "type_text", args: { text: "9999" } }] },
  };
  const NAV = { // (c) tools that can move the page, and how
    navigate: { start: "/leave", args: { url: BASE + "/redirect-local" } },
    click: { start: "/leave", args: { selector: "#leave-btn" } },
    press_key: { start: "/leave", focus: "#leave-link", args: { key: "Enter" } },
    new_page: { start: "/leave", args: { url: BASE + "/redirect-local" } },
    wait_for: { start: "/leave-later", args: { text: "Arrived here", timeout: 5000 } },
    run_plan: { start: "/leave", args: { steps: [{ tool: "click", args: { selector: "#leave-link" } }] } },
  };
  const noRow = browserTools.filter((t) => !(t in A) || !(t in S));
  assert.deepStrictEqual(noRow, [], "browser tools with no matrix row (add them to A and S): " + noRow);

  const report = {};
  const row = (t) => (report[t] = report[t] || { a: "", b: "", c: "" });
  const tabId = async (pg) => (await b.list_pages()).pages.find((p) => p.selected || false) && [...(await b.list_pages()).pages].pop().id;

  async function openSelected(url) {
    const pg = await browser.newPage();
    await pg.goto(url, { waitUntil: "domcontentloaded" });
    const list = (await b.list_pages()).pages;
    const id = list[list.length - 1].id;
    await b.select_page({ id });
    return { pg, id };
  }

  // ---- (a) disallowed current page ----
  for (const t of browserTools) {
    const { pg, id } = await openSelected(OFF + "/payment");
    const args = t === "select_page" || t === "close_page" ? { id } : A[t];
    const r = strip(await b[t](args));
    const txt = JSON.stringify(r);
    const leaked = DISALLOWED_DATA.filter((x) => txt.includes(x));
    assert.deepStrictEqual(leaked, [], `(a) ${t} returned data from a disallowed page: ${txt.slice(0, 300)}`);
    if (t === "list_pages" || t === "select_page") {
      assert.ok(txt.includes('"blocked":true'), `(a) ${t} should mark the tab blocked: ${txt}`);
      row(t).a = "tab shown as blocked (id + host only)";
    } else if (t === "close_page") {
      assert.deepStrictEqual(r, { closed: id });
      row(t).a = "closes it, returns only the id";
    } else if (t === "run_plan") {
      assert.ok(hostError(r.steps[0].result) && r.final_snapshot === null, txt);
      row(t).a = "step refused; no final snapshot";
    } else {
      assert.ok(hostError(r), `(a) ${t} should return a host error: ${txt.slice(0, 300)}`);
      row(t).a = t === "navigate" ? "host error (reload/back/forward/goto)" : t === "new_page" ? "host error (target and final URL)" : "host error";
    }
    if (!pg.isClosed()) await pg.close();
  }

  // ---- (b) sensitive field focused / targeted ----
  for (const t of browserTools) {
    if (S[t] === "skip") { row(t).b = "n/a (closes a tab; reads and types nothing)"; continue; }
    const { pg, id } = await openSelected(BASE + "/payment");
    await pg.focus("#cardnumber");
    const r = strip(await b[t](t === "select_page" ? { id } : S[t]));
    const txt = JSON.stringify(r);
    const leaked = SECRETS.filter((x) => txt.includes(x));
    assert.deepStrictEqual(leaked, [], `(b) ${t} returned a sensitive value: ${txt.slice(0, 300)}`);
    const pages = await browser.pages();
    for (const p of pages) {
      if (!p.url().endsWith("/payment") || p.isClosed()) continue;
      const v = await p.$eval("#cardnumber", (el) => el.value).catch(() => null);
      assert.ok(v === null || v === "4111 1111 1111 1111", `(b) ${t} changed the card field to "${v}"`);
    }
    const typed = ["fill", "type_text", "press_key", "select_option"].includes(t);
    if (typed) assert.ok(r.refused || r.error, `(b) ${t} should refuse the sensitive field: ${txt}`);
    if (t === "run_plan") assert.strictEqual(r.stop_reason, "refused");
    if (t === "screenshot") assert.ok(r.masked_fields >= 1);
    row(t).b = typed ? (r.refused ? "refused" : "error (not applicable)") + ", value unchanged"
      : t === "screenshot" ? `masked (${r.masked_fields} fields)` : "no value returned";
    for (const p of await browser.pages()) if (!p.isClosed() && p !== (await browser.pages())[0]) await p.close().catch(() => {});
  }

  // ---- press_key on an irreversible button needs confirmation (Space and Enter) ----
  {
    const { pg } = await openSelected(BASE + "/payment");
    for (const key of ["Space", "Enter"]) {
      await pg.focus("button[type=submit]");
      const r = await b.press_key({ key });
      assert.ok(r.needs_confirmation, `press_key ${key} on "Pay now" should need confirmation: ${JSON.stringify(r)}`);
    }
    await pg.close();
    console.log("  PASS  press_key Space/Enter on \"Pay now\" returns needs_confirmation");
  }

  // ---- round 6: fail closed ----
  {
    const offTab = async () => (await browser.pages()).filter((p) => !p.isClosed() && p.url().startsWith(OFF)).map((p) => p.url());

    // A tool that throws after the page moved off-host still returns the host error and blanks the tab.
    const { pg: p1 } = await openSelected(BASE + "/leave-later");
    const w = await b.wait_for({ text: "text-that-never-appears", timeout: 2500 });
    assert.ok(hostError(w), "wait_for that timed out after the page moved should return the host error: " + JSON.stringify(w));
    assert.deepStrictEqual(await offTab(), []);
    assert.ok(p1.isClosed() || p1.url() === "about:blank");
    console.log("  PASS  a tool that throws after the page moved off-host returns the host error; the tab is blanked");

    // If the sensitive-field check fails, the tool does not run.
    const { pg: p2 } = await openSelected(BASE + "/hostile-dom");
    for (const [t, args] of [["snapshot", {}], ["get_text", {}], ["fill", { selector: "#card", value: "9" }], ["query_all", { selector: "input", attributes: ["value"] }]]) {
      const r = await b[t](args);
      assert.ok(r.error && /querySelectorAll disabled/.test(r.error), `${t} should fail when marking fails: ${JSON.stringify(r).slice(0, 200)}`);
      assert.ok(!JSON.stringify(r).includes("4111"), `${t} leaked the card value`);
    }
    assert.strictEqual(await p2.$eval("#card", (el) => el.value), "4111 1111 1111 1111");
    await p2.close();
    console.log("  PASS  when the sensitive-field check throws, snapshot/get_text/fill/query_all do not run and return nothing");

    // reload / back / forward / goto on a disallowed page are refused.
    const { pg: p3 } = await openSelected(BASE + "/leave");
    await p3.goto(OFF + "/arrived");
    await p3.goto(OFF + "/payment");
    await p3.goBack();
    for (const args of [{ action: "reload" }, { action: "back" }, { action: "forward" }, { url: BASE + "/contact" }]) {
      const before = p3.url();
      const r = await b.navigate(args);
      assert.ok(hostError(r), "navigate " + JSON.stringify(args) + " on a disallowed page: " + JSON.stringify(r));
      assert.strictEqual(p3.url(), before, "the disallowed tab must not have navigated");
    }
    await p3.close();
    console.log("  PASS  navigate reload/back/forward/goto on a disallowed page are refused (way out: new_page or close_page)");

    // new_page whose goto times out after redirecting to a disallowed host leaves no disallowed tab.
    const np = await b.new_page({ url: BASE + "/redirect-slow" });
    assert.ok(hostError(np), "new_page should return the host error: " + JSON.stringify(np));
    assert.deepStrictEqual(await offTab(), []);
    console.log("  PASS  new_page that times out on a redirect to a disallowed host leaves no disallowed tab");
  }

  // ---- round 7: nothing typed, and no sensitive control's value, reaches the audit log ----
  {
    const fs = require("fs");
    const { pg } = await openSelected(BASE + "/contact");
    const plan = await b.run_plan({ steps: [
      { tool: "fill", args: { text: "Your name", value: "plan-secret-value-1" } },
      { tool: "click", args: { text: "Message" } },
      { tool: "type_text", args: { text: "plan-secret-value-2" } },
    ] });
    assert.ok(plan.completed, JSON.stringify(plan));
    await pg.goto(BASE + "/sensitive-submit");
    const c = await b.click({ selector: "input[type=submit]" });
    assert.ok(c.needs_confirmation && !JSON.stringify(c).includes("4111"), JSON.stringify(c));
    await pg.close();
    const log = fs.readFileSync(path.join(tmp, "logs/browser.audit.jsonl"), "utf8");
    for (const x of ["plan-secret-value-1", "plan-secret-value-2", "4111"]) assert.ok(!log.includes(x), "audit log contains " + x);
    const rp = log.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.tool === "run_plan").pop();
    assert.deepStrictEqual(rp.args.steps.map((st) => st.args.value || st.args.text), ["(19 chars)", "Message", "(19 chars)"]);
    console.log("  PASS  run_plan fill/type_text values are logged as (N chars) only; a sensitive submit's value is kept out of messages and logs");
  }

  // ---- (c) page moves off the allow-list during the call ----
  for (const t of browserTools) {
    const spec = NAV[t];
    if (!spec) { row(t).c = t in { list_pages: 1, select_page: 1, close_page: 1 } ? "n/a (does not act on a page)" : "re-checked by withPage"; continue; }
    const { pg } = await openSelected(BASE + spec.start);
    if (spec.focus) await pg.focus(spec.focus);
    const r = strip(await b[t](spec.args));
    const txt = JSON.stringify(r);
    assert.ok(!txt.includes("private-page-text-77") && !txt.includes(OFF + "/arrived"), `(c) ${t} returned data from the page it moved to: ${txt.slice(0, 300)}`);
    const res = t === "run_plan" ? r.steps[0].result : r;
    assert.ok(hostError(res), `(c) ${t} should be refused after moving off-host: ${txt.slice(0, 300)}`);
    const urls = (await browser.pages()).map((p) => p.url());
    assert.ok(!urls.some((u) => u.startsWith(OFF)), `(c) ${t} left a tab on the disallowed host: ${urls}`);
    row(t).c = "refused after the move; tab sent to about:blank";
    for (const p of await browser.pages()) if (!p.isClosed() && p !== (await browser.pages())[0]) await p.close().catch(() => {});
  }

  console.log("\n=== safety matrix (" + browserTools.length + " browser tools from the MCP registry) ===");
  console.log("tool".padEnd(15) + "| (a) disallowed page".padEnd(42) + "| (b) sensitive field".padEnd(36) + "| (c) moves off-host");
  for (const t of browserTools) console.log(t.padEnd(15) + "| " + row(t).a.padEnd(40) + "| " + row(t).b.padEnd(34) + "| " + row(t).c);
  for (const t of BATCH.filter((x) => tools.includes(x))) console.log(t.padEnd(15) + "| batch tool: uses the skill's origin, not the current page (see engine tests)");

  await connection.close();
  demo.server.closeAllConnections();
  demo.server.close();
  console.log(`\nMATRIX TEST PASSED (${browserTools.length} browser tools x 3 conditions, ${tools.length - browserTools.length} batch tools listed)\n`);
}

main().catch((e) => { console.error("\nMATRIX TEST FAILED:", (e && e.stack) || e); process.exit(1); });
