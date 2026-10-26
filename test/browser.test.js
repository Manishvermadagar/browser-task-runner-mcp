#!/usr/bin/env node
// Browser-control and CDP-transport tests against the demo app, using a real
// headless Chromium-based browser (Chrome, Chromium, Brave or Edge) found on
// this machine, or the one in BTR_CHROME_PATH. Skips cleanly if none exists.
//
//   node test/browser.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { findChromium, connectBrowser } = require("../engine/cdp");
const { createBrowserController } = require("../engine/browser");
const { createEngine, makeCdpTransport } = require("../engine");
const { spawn } = require("child_process");
const { makeTmp, startDemo, skillsRoot } = require("./tmp");

const ROOT = path.resolve(__dirname, "..");
const exe = process.env.BTR_CHROME_PATH || findChromium();
if (!exe) {
  console.log("\nSKIPPED browser tests: no Chromium-based browser found (set BTR_CHROME_PATH to run them)\n");
  process.exit(0);
}

let passed = 0;
const step = (n) => { passed++; console.log("  PASS  " + n); };
let BASE;

async function main() {
  const demo = await startDemo();
  BASE = demo.base;
  const tmp = makeTmp("btr-browser-");
  const connection = connectBrowser({ launch: true, executablePath: exe, headless: true, userDataDir: path.join(tmp, "profile") });
  const b = createBrowserController({ connection, allowHosts: ["localhost", "127.0.0.1"], logDir: path.join(tmp, "logs") });
  console.log(`\n=== browser control (headless ${path.basename(exe)}) ===`);
  try {
    const nav = await b.navigate({ url: "https://example.com/" });
    assert.ok(nav.refused && /host not allowed/.test(nav.reason));
    step("navigation to a host outside the allow-list is refused");

    const plan = await b.run_plan({ steps: [
      { tool: "navigate", args: { url: BASE + "/contact" } },
      { tool: "wait_for", args: { text: "Contact support" } },
      { tool: "fill", args: { text: "Your name", value: "Test User" } },
      { tool: "fill", args: { text: "Email", value: "test@example.test" } },
      { tool: "select_option", args: { text: "Topic", value: "Bug report" } },
      { tool: "fill", args: { text: "Message", value: "The export button does nothing." } },
      { tool: "find", args: { text: "Send message", role: "button" } },
      { tool: "click", args: { uid: { use: "step7.uid" } } },
    ] });
    assert.strictEqual(plan.stop_reason, "needs_confirmation");
    assert.strictEqual(plan.stopped_at, 8);
    assert.ok(plan.steps.slice(0, 7).every((s) => !s.result.error && !s.result.refused), JSON.stringify(plan.steps));
    assert.ok(/submits a form/.test(plan.steps[7].result.description));
    assert.strictEqual((await (await fetch(BASE + "/api/messages")).json()).messages.length, 0);
    step("run_plan: navigate -> wait_for -> fill x3 -> select -> find -> click stops at needs_confirmation; nothing sent");

    const pw = await b.fill({ text: "Account password", value: "hunter2" });
    assert.ok(pw.refused && /password, payment or ID field/.test(pw.reason));
    await b.click({ text: "Account password" }); // focus it (a label click; not irreversible)
    const pw2 = await b.type_text({ text: "hunter2" });
    assert.ok(pw2.refused, JSON.stringify(pw2));
    step("typing into the password field is refused (fill and type_text)");

    const enter = await b.run_plan({ steps: [{ tool: "click", args: { text: "Your name" } }, { tool: "press_key", args: { key: "Enter" } }] });
    assert.strictEqual(enter.stop_reason, "needs_confirmation");
    step("Enter inside a form needs confirmation");

    const ev = await b.evaluate({ js: "return document.title", confirm: true });
    assert.ok(ev.refused && /disabled/.test(ev.reason));
    const evPlan = await b.run_plan({ steps: [{ tool: "evaluate", args: { js: "document.querySelector('#password').value='x'", confirm: true } }] });
    assert.strictEqual(evPlan.stop_reason, "refused");
    const t = await b.get_text({ selector: "h1" });
    assert.strictEqual(t.text, "Contact support");
    const at = await b.get_attribute({ text: "Email", name: "type" });
    assert.strictEqual(at.value, "email");
    const qa = await b.query_all({ selector: "input", attributes: ["name", "value"] });
    assert.ok(qa.count >= 3 && qa.rows.find((r) => r.name === "password").value === "[redacted: sensitive field]");
    const pv = await b.get_attribute({ text: "Account password", name: "value" });
    assert.strictEqual(pv.value, "[redacted: sensitive field]");
    step("evaluate is off by default (also inside run_plan); get_text, get_attribute and query_all read safely");

    const b2 = createBrowserController({ connection, allowHosts: ["127.0.0.1"], allowEvaluate: true });
    const ev2 = await b2.evaluate({ js: "return document.title" });
    assert.ok(ev2.needs_confirmation, "even a read-only script needs confirmation when evaluate is enabled");
    const ev3 = await b2.evaluate({ js: "return document.title", confirm: true });
    assert.strictEqual(ev3.value, "Contact");
    step("with BTR_ALLOW_EVALUATE, every evaluate call needs confirm=true");

    const done = await b.run_plan({ steps: [
      { tool: "click", args: { text: "Send message", role: "button", confirm: true } },
      { tool: "wait_for", args: { selector: "#sent" } },
      { tool: "extract", args: { selector: "#sent" } },
    ] });
    assert.ok(done.completed, JSON.stringify(done));
    assert.strictEqual(done.steps[2].result.rows[0], "Thanks, your message was received.");
    const msgs = (await (await fetch(BASE + "/api/messages")).json()).messages;
    assert.strictEqual(msgs.length, 1);
    assert.deepStrictEqual([msgs[0].name, msgs[0].topic, msgs[0].message], ["Test User", "bug", "The export button does nothing."]);
    step("click with confirm=true submits; extract reads the result; the app received exactly one message");

    const snap = await b.snapshot({});
    assert.ok(/\[e\d+\] button "Send message"/.test(snap.snapshot) && /textbox type=password "Account password"/.test(snap.snapshot));
    assert.ok(done.final_snapshot && done.final_snapshot.lines > 0);
    step("snapshot lists elements with uids; run_plan returns a final snapshot");

    // ---- sensitive values never leave the page through any read tool ----
    const SECRETS = ["4111 1111 1111 1111", "4111", "5500 0000 0000 0004", "0004", "737", "ZZ-998877-Q", "998877", "demo-secret-pw", "Test Holder", "card-note-5555"];
    const leaks = (label, v) => {
      const txt = JSON.stringify(v);
      const hit = SECRETS.filter((x) => txt.includes(x));
      assert.deepStrictEqual(hit, [], `${label} leaked ${hit.join(", ")}: ${txt.slice(0, 400)}`);
    };
    const pay = await b.run_plan({ steps: [{ tool: "navigate", args: { url: BASE + "/payment" } }, { tool: "snapshot", args: {} }], snapshot_lines: 200 });
    assert.ok(pay.completed);
    leaks("run_plan steps and final snapshot", pay);
    assert.ok(pay.final_snapshot.snapshot.includes("[redacted: sensitive field]") && pay.final_snapshot.snapshot.includes("ORD-2026-0042"));
    const snapP = await b.snapshot({});
    leaks("snapshot", snapP);
    const fields = ["#ccname", "#cardnumber", "#cvc", "#natid", "#pw", "#notes", "#ariacard", "#cardbtn"];
    for (const f of fields) {
      leaks(`get_text ${f}`, await b.get_text({ selector: f }));
      for (const a of ["value", "data-btr-sensitive", "name"]) leaks(`get_attribute ${f}@${a}`, await b.get_attribute({ selector: f, name: a }));
      leaks(`extract ${f}`, await b.extract({ selector: f }));
    }
    assert.strictEqual((await b.get_attribute({ selector: "#cardnumber", name: "value" })).value, "[redacted: sensitive field]");
    assert.strictEqual((await b.get_attribute({ selector: "#ref", name: "value" })).value, "ORD-2026-0042");
    assert.strictEqual((await b.get_attribute({ selector: "#cardnumber", name: "autocomplete" })).value, "cc-number");
    leaks("get_text page", await b.get_text({}));
    leaks("get_text form", await b.get_text({ selector: "form" }));
    leaks("extract form fields", await b.extract({ selector: "form", fields: { card: "#cardnumber@value", cvc: "#cvc", id: "#natid@value", notes: "#notes", ref: "#ref@value" } }));
    const ex = await b.extract({ selector: "form", fields: { ref: "#ref@value", card: "#cardnumber@value" } });
    assert.deepStrictEqual(ex.rows[0], { ref: "ORD-2026-0042", card: "[redacted: sensitive field]" });
    const q = await b.query_all({ selector: "input, textarea", attributes: ["value", "name", "autocomplete"] });
    leaks("query_all", q);
    assert.strictEqual(q.rows.filter((r) => r.sensitive).length, 8);
    // Text search ignores field values, so it cannot be used to probe them.
    const probe = await b.find({ text: "1111 1111" }); // part of the card number, not a visible label
    assert.ok(probe.error && !probe.uid, JSON.stringify(probe));
    leaks("fill cvc", await b.fill({ selector: "#cvc", value: "123" }));
    assert.ok((await b.fill({ selector: "#natid", value: "x" })).refused);
    // aria-label is the only name on these two elements.
    const af = await b.fill({ selector: "#ariacard", value: "1234" });
    assert.ok(af.refused, JSON.stringify(af));
    const afText = await b.fill({ text: "Card number", role: "textbox", value: "1234" });
    assert.ok(afText.refused, JSON.stringify(afText));
    await (await (await connection.get()).pages()).find((pg) => pg.url().endsWith("/payment")).focus("#ariacard");
    const at2 = await b.type_text({ text: "1234" });
    assert.ok(at2.refused, JSON.stringify(at2));
    assert.ok(!JSON.stringify(await b.get_attribute({ selector: "#ariacard", name: "value" })).includes("1234"));
    const fb = await b.find({ text: "4111 1111 1111 1111" });
    assert.ok(fb.error && !fb.uid, "find matched a sensitive button's value: " + JSON.stringify(fb));
    const fb2 = await b.find({ selector: undefined, text: "Card number", role: "button" });
    assert.ok(fb2.uid && fb2.text === "[redacted: sensitive field]", JSON.stringify(fb2));
    leaks("find sensitive button", fb2);
    const snapBtn = await b.snapshot({});
    assert.ok(/button "\[redacted: sensitive field\]"/.test(snapBtn.snapshot), snapBtn.snapshot);
    leaks("snapshot with sensitive button", snapBtn);
    // The only allowed occurrence is the probe string this test itself passed to find.
    const auditText = fs.readFileSync(path.join(tmp, "logs/browser.audit.jsonl"), "utf8").split("\n").filter(Boolean)
      .filter((l) => { const e = JSON.parse(l); return !(e.tool === "find" && e.args.text === "4111 1111 1111 1111"); }).join("\n");
    for (const x of SECRETS) assert.ok(!auditText.includes(x), "audit log contains " + x);
    step("payment form: card (incl. aria-label-only field and a sensitive button), CVC, national ID, password and card-notes values never returned by snapshot, run_plan, extract, query_all, get_attribute, get_text or find, nor written to the audit log");

    // ---- screenshots mask sensitive fields ----
    let atCapture = null;
    const bm = createBrowserController({ connection, allowHosts: ["127.0.0.1"], onCapture: async (pg) => {
      atCapture = await pg.evaluate(() => {
        const marked = [...document.querySelectorAll('[data-btr-sensitive="1"]')];
        return { marked: marked.length, overlays: document.querySelectorAll(".btr-mask-overlay").length,
          styled: marked.filter((el) => { const cs = getComputedStyle(el); return cs.color === "rgba(0, 0, 0, 0)" && (cs.webkitTextSecurity === "disc" || el.tagName !== "INPUT"); }).length,
          ref: getComputedStyle(document.getElementById("ref")).color };
      });
    } });
    const masked = await bm.screenshot({});
    assert.strictEqual(atCapture.marked, 8);
    assert.strictEqual(atCapture.styled, 8, JSON.stringify(atCapture));
    assert.strictEqual(atCapture.overlays, 8);
    assert.notStrictEqual(atCapture.ref, "rgba(0, 0, 0, 0)");
    assert.strictEqual(masked.masked_fields, 8);
    const afterShot = await (await connection.get()).pages().then(async (ps) => {
      for (const pg of ps) if (pg.url().endsWith("/payment")) return pg.evaluate(() => ({ style: !!document.getElementById("btr-mask-style"), overlays: document.querySelectorAll(".btr-mask-overlay").length, color: getComputedStyle(document.getElementById("cardnumber")).color }));
      return null;
    });
    assert.deepStrictEqual([afterShot.style, afterShot.overlays], [false, 0]);
    assert.notStrictEqual(afterShot.color, "rgba(0, 0, 0, 0)");
    const unmasked = await createBrowserController({ connection, allowHosts: ["127.0.0.1"], maskScreenshots: false }).screenshot({});
    assert.notStrictEqual(Buffer.from(masked.image_base64, "base64").compare(Buffer.from(unmasked.image_base64, "base64")), 0);
    const masked2 = await bm.screenshot({});
    assert.strictEqual(masked2.image_base64, masked.image_base64, "masking should be deterministic");
    const planShot = await b.run_plan({ steps: [{ tool: "screenshot", args: {} }] });
    assert.strictEqual(planShot.steps[0].result.masked_fields, 8);
    step("screenshot masks all 8 sensitive fields at capture (style + overlay), removes the masking afterwards, and differs from an unmasked capture; run_plan screenshots are masked too");

    await b.navigate({ url: BASE + "/contact" });
    const shot = await b.screenshot({});
    assert.ok(shot.image_base64 && shot.image_base64.length > 1000);
    const net = await b.get_network({ filter: "/contact" });
    assert.ok(net.requests.some((r) => r.method === "POST" && r.status === 200));
    step("screenshot and network log work");

    const audit = fs.readFileSync(path.join(tmp, "logs/browser.audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(audit.some((a) => a.outcome === "needs_confirmation") && audit.some((a) => a.outcome === "refused"));
    assert.ok(!fs.readFileSync(path.join(tmp, "logs/browser.audit.jsonl"), "utf8").includes("hunter2"));
    step(`every action audit-logged (${audit.length} entries), typed values never logged`);

    // Batch skill through the same browser, CDP transport.
    console.log("\n=== batch skill over CDP ===");
    demo.reset();
    const engine = createEngine({ root: skillsRoot(demo.port), dataDir: path.join(tmp, "data"), transport: makeCdpTransport({ connection }), sleep: async () => {} });
    const h = await engine.harvest("demo-review-queue", ["101", "102", "105", "r1"]);
    assert.strictEqual(h.harvested_ok, 3);
    assert.strictEqual(engine.getHarvest(h.run_id).items.find((i) => i.id === "r1")._code, "REDIRECT_BLOCKED");
    engine.submitVerdicts(h.run_id, { 101: { verdict: "APPROVE" }, 102: { verdict: "REJECT", note: "spam" }, 105: { verdict: "ESCALATE" } });
    await engine.act(h.run_id);
    await engine.act(h.run_id, { dryRun: false, approval: engine.approveLive(h.run_id).approval });
    await engine.act(h.run_id, { dryRun: false, approval: engine.approveLive(h.run_id).approval });
    const v = await engine.verify(h.run_id);
    assert.strictEqual(v.checked, 2); assert.strictEqual(v.failed, 0);
    step("harvest (off-host redirect blocked) -> verdicts -> dry run -> approve -> live -> verify, inside the browser page");

    // Dashboard: activity entries must be shown as text, never parsed as HTML.
    console.log("\n=== bridge dashboard ===");
    const bdir = makeTmp("btr-dash-");
    const bridge = spawn(process.execPath, [path.join(ROOT, "bridge/server.js")], { env: { ...process.env, BTR_PORT: "0", BTR_DATA_DIR: bdir }, stdio: ["ignore", "pipe", "ignore"] });
    try {
      const bp = await new Promise((ok, no) => { let o = ""; bridge.stdout.on("data", (c) => { o += c; const m = o.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/); if (m) ok(Number(m[1])); }); bridge.on("exit", () => no(new Error(o))); });
      bridge.stdout.resume();
      const token = fs.readFileSync(path.join(bdir, ".btr-token"), "utf8").trim();
      const payload = '<img src=x onerror="window.__pwned=1">';
      await fetch(`http://127.0.0.1:${bp}/log`, { method: "POST", headers: { "Content-Type": "application/json", "X-BTR-Token": token },
        body: JSON.stringify({ phase: "act", id: payload, status: payload, verdict: payload, detail: payload }) });
      const page = await (await connection.get()).newPage();
      await page.goto(`http://127.0.0.1:${bp}/#token=${token}`);
      await page.waitForFunction(() => document.querySelectorAll("#rows tr").length > 0, { timeout: 10000 });
      const res = await page.evaluate(() => ({ imgs: document.querySelectorAll("#rows img, #now img").length, pwned: !!window.__pwned,
        cells: [...document.querySelectorAll("#rows td")].map((t) => t.textContent), now: document.getElementById("now").textContent }));
      await page.close();
      assert.strictEqual(res.imgs, 0); assert.strictEqual(res.pwned, false);
      assert.ok(res.cells.includes(payload) && res.now.includes(payload));
      step("dashboard renders hostile activity entries as plain text (no element created, no script run)");
    } finally { bridge.kill(); }
  } finally {
    await connection.close();
    demo.server.close();
  }
  console.log(`\nBROWSER TESTS PASSED (${passed})\n`);
}

main().catch((e) => { console.error("\nBROWSER TEST FAILED:", (e && e.stack) || e); process.exit(1); });
