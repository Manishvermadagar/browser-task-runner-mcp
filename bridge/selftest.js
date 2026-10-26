#!/usr/bin/env node
// Static self-tests: no servers, no browser. Run before any live work.
//
//   node bridge/selftest.js
//
// Each check exists because the failure it catches is silent: a detector
// that finds nothing looks the same as one that is broken, and a safety
// default that has been flipped looks the same as one that has not.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const ok = (n) => console.log("  PASS  " + n);
const bad = (n, d) => { failures++; console.log("  FAIL  " + n + "\n        " + d); };
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const S = require("../engine/skills");
const B = require("../engine/browser");

console.log("\n=== skills ===");
const registry = S.loadRegistry(ROOT);
check(Array.isArray(registry) && registry.length > 0, "registry.json lists at least one skill", JSON.stringify(registry));
for (const id of registry) {
  try {
    const s = S.loadSkill(ROOT, id);
    ok(`skill "${id}" loads and validates`);
    check(Object.values(s.actionOrder).some((o) => o.length === 0), `skill "${id}" has an escalation verdict (empty actionOrder)`, "every skill should give reviewers a way to say 'a person decides'");
    for (const f of ["ruleset.md", "NOTES.md"]) check(fs.existsSync(path.join(ROOT, "src/skills", id, f)), `skill "${id}" has ${f}`, "missing");
  } catch (e) { bad(`skill "${id}" loads`, e.message); }
}
const broken = S.validateSkill({ id: "x", baseUrl: "http://h", read: { urlTemplate: "/{id}", extract: [] }, actions: {}, actionOrder: { A: ["nope"] } });
check(broken.some((e) => e.includes('unknown action "nope"')), "validator catches an actionOrder that names a missing action", JSON.stringify(broken));

console.log("\n=== templating ===");
const skill = S.loadSkill(ROOT, "demo-review-queue");
const req = S.buildRequest(skill, "approve", { id: "101", csrfToken: "t&1", note: "a b" });
check(req.url === "http://127.0.0.1:8790/items/101/approve", "URL template resolves", req.url);
check(req.body === "csrf=t%261&note=a+b", "form body is encoded", req.body);
const evil = S.buildRequest(skill, "approve", { id: "../../x?y=1", csrfToken: "t" });
check(evil.url.startsWith("http://127.0.0.1:8790/items/") && !evil.url.includes("../"), "an id cannot change the request path (URI-encoded)", evil.url);
let threw = false;
try { S.buildRequest(skill, "approve", { id: "1" }); } catch { threw = true; }
check(threw, "a missing required var refuses the request", "no error thrown");

console.log("\n=== extraction contract ===");
const html = '<main data-item-id="7" data-status="pending"><span id="author">A &amp; B</span><span id="rating">4</span>'
  + '<blockquote id="review-body">x &amp; y&nbsp;z</blockquote><input type="hidden" name="csrf" value="tok"></main>';
const f = S.extractFields(html, skill);
check(f.body === "x &amp; y&nbsp;z", "raw value is returned untouched (the form you write back)", JSON.stringify(f.body));
check(f.bodyDecoded === "x & y z", "decoded value is returned separately (the form you review)", JSON.stringify(f.bodyDecoded));
check(f.itemId === "7" && f.csrfToken === "tok" && f.status === "pending", "identity, status and token extract", JSON.stringify(f));
check(S.extractFields("<p>nothing</p>", skill).itemId === null, "a missing field is null, not an empty string", "");

console.log("\n=== safety defaults ===");
const eng = read("engine/index.js");
check(/async act\(runId, \{ dryRun = true/.test(eng), "engine act() defaults to dry run", "default changed");
check(eng.includes("live act refused: no approval") && eng.includes("approval already used") && eng.includes("APPROVAL_TTL_MS = 15 * 60 * 1000"), "engine requires a single-use, expiring approval for live runs", "gate missing");
check(eng.includes("withSkillLock(skillId, () => doAct(runId, { live: true"), "live acts are serialised per skill by a lock", "lock missing");
check(eng.includes("REDIRECT_BLOCKED") && !/transport\.request\(/.test(eng.replace("const res = await transport.request({ ...req, allowRedirect });", "")), "every engine request goes through the redirect-checking send()", "a direct transport.request call exists");
check(eng.includes("stagedRollout") && eng.includes("maxConsecutiveErrors") && eng.includes("rateLimitMs"), "staged rollout, circuit breaker and rate limit are wired", "missing");
check(eng.includes("IDENTITY_MISMATCH") && eng.includes('"STALE"'), "identity guard and stale-content check exist", "missing");
check(/const LIVE = flag\("live"\)/.test(read("bridge/act.js")), "act.js is a dry run unless --live is passed", "flag handling changed");
check(/dry_run: z\.boolean\(\)\.default\(true\)/.test(read("mcp/server.mjs")), "MCP act tool defaults dry_run to true", "schema default changed");

console.log("\n=== browser safety rules ===");
for (const t of ["Send message", "Place order", "Delete account", "Pay now", "Publish", "Confirm", "Submit"]) check(B.IRREVERSIBLE.test(t), `"${t}" needs confirmation`, "not matched");
for (const t of ["Search", "Next page", "Show details", "Open menu"]) check(!B.IRREVERSIBLE.test(t), `"${t}" does not need confirmation`, "false positive");
for (const t of ["password", "cc-number", "card_number", "passport_no", "ssn", "national-id"]) check(B.SENSITIVE_NAME.test(t), `"${t}" is a sensitive field`, "not matched");
for (const t of ["name", "email", "message", "company"]) check(!B.SENSITIVE_NAME.test(t), `"${t}" is not a sensitive field`, "false positive");
check(B.WRITE_JS.test("document.querySelector('button').click()") && !B.WRITE_JS.test("return document.title"), "evaluate() write detection", "");
const allow = B.parseAllowHosts("");
check(B.hostAllowed("http://localhost:8790/x", allow) && !B.hostAllowed("https://example.com/", allow), "default host allow-list is localhost only", allow.join(","));
check(B.hostAllowed("https://a.example.com/", B.parseAllowHosts("*.example.com")) && !B.hostAllowed("file:///etc/passwd", allow), "wildcard hosts work; non-http schemes are refused", "");

console.log("\n=== evaluate, bridge and extension policy ===");
const br = read("engine/browser.js"), tr = read("engine/transports.js"), srv = read("bridge/server.js"), mcp = read("mcp/server.mjs");
check(/allowEvaluate = process\.env\.BTR_ALLOW_EVALUATE === "1"/.test(br) && br.includes("evaluate is disabled"), "evaluate is off unless BTR_ALLOW_EVALUATE=1", "default changed");
// Structural guarantee: every page-touching tool goes through withPage().
const ctl = B.createBrowserController({ connection: { get: async () => { throw new Error("no browser in selftest"); } } });
const mcpBrowserTools = [...new Set([...(mcp.match(/b\("([a-z_]+)"\)/g) || []).map((m) => m.slice(3, -2)), "screenshot"])];
const NON_PAGE = { list_pages: 1, new_page: 1, select_page: 1, close_page: 1, run_plan: 1 };
const missing = mcpBrowserTools.filter((t) => !ctl.toolMeta[t]);
check(mcpBrowserTools.length >= 20 && !missing.length, `all ${mcpBrowserTools.length} MCP browser tools are known to the controller`, "missing: " + missing.join(", "));
const notWrapped = mcpBrowserTools.filter((t) => ctl.toolMeta[t] && ctl.toolMeta[t].via !== "withPage" && !NON_PAGE[t]);
check(!notWrapped.length, "every page-touching tool goes through withPage (exceptions: " + Object.keys(NON_PAGE).join(", ") + ")", "not wrapped: " + notWrapped.join(", "));
check(Object.keys(NON_PAGE).every((t) => ctl.toolMeta[t] && ctl.toolMeta[t].reason), "each tool outside withPage records why", "");
const wp = br.slice(br.indexOf("async function withPage("), br.indexOf("const blockedEntry"));
check(/checkHost\(page\.url\(\)\)[\s\S]*markSensitive\(page\)[\s\S]*await fn\(page[\s\S]*checkHost\(page\.url\(\)\)[\s\S]*about:blank/.test(wp), "withPage: host check, sensitive marking, tool, host re-check with about:blank", "order changed");
check(!/markSensitive\(page\)\.catch/.test(wp) && /catch \(e\) \{\s*error = e;\s*\}\s*const after = checkHost/.test(wp) && /if \(error\) throw error;/.test(wp) && /page\.close\(\)/.test(wp), "withPage fails closed: marking errors stop the tool; the host re-check runs even after an error; a tab that cannot be blanked is closed", "");
check(!/checksTargetInstead/.test(br), "no tool is exempt from the before-call host check (navigate included)", "");
check(!/\n    async [a-z_]+\(\{/.test(br), "no tool is defined outside def()/defOther()", "an old-style tool definition exists");
check((br.match(/page\.evaluate\(readInPage/g) || []).length >= 4, "every read tool reads through readInPage", "a read path skips redaction");
check(/maskScreenshots = true/.test(br) && /masked = await page\.evaluate\(maskInPage, true\)/.test(br) && /finally \{\s*if \(maskScreenshots\) await page\.evaluate\(maskInPage, false\)/.test(br), "screenshots mask sensitive fields by default and unmask in finally", "");
check(/const sensitive = \(info\) => !!info && info\.marked === true;/.test(br) && (br.match(/SENSITIVE_NAME/g) || []).length === 3 && (br.match(/SENSITIVE_AUTOCOMPLETE/g) || []).length === 3,
  "one sensitive-field check (markSensitiveInPage) serves reads, writes, masking and matching", "a second sensitive-field check exists");
check(/async function resolve\(page, t\) \{\s*await markSensitive\(page\);/.test(br), "every target lookup (find, click, fill, ...) classifies the page first", "");
check(B.REDACTED === "[redacted: sensitive field]" && B.SENSITIVE_AUTOCOMPLETE.test("cc-number") && B.SENSITIVE_AUTOCOMPLETE.test("section-a cc-csc") && !B.SENSITIVE_AUTOCOMPLETE.test("email"), "redaction marker and autocomplete classification", "");
check(/if \(browser\.evaluateEnabled\)/.test(mcp), "MCP only offers evaluate when enabled", "not gated");
check((tr.match(/redirect: "manual"/g) || []).length >= 2 && !/redirect: "follow"/.test(tr), "transports never follow redirects automatically", "");
check(srv.includes('const JOB_TYPES = ["fetch", "navigate", "closeTab"]') && !/"exec"/.test(srv), "bridge accepts no exec job type", "");
check(srv.includes("safeEqual(req.headers[\"x-btr-token\"], TOKEN)") && !srv.includes("Access-Control-Allow-Origin"), "bridge requires the token and sends no CORS headers", "");
check(!/executeScript|new AsyncFunction|"exec"/.test(read("src/background.js")) && read("src/background.js").includes('redirect: "manual"'), "extension runs no arbitrary scripts and does not follow redirects", "");
check(read("src/background.js").includes("job.write !== true") && read("src/background.js").includes("hostAllowed(job.url, hosts)"), "extension enforces the host allow-list and the write flag itself", "");
check(read(".gitignore").includes(".btr-token"), ".btr-token is gitignored", "");
const dash = srv.slice(srv.indexOf("const DASHBOARD = `"), srv.indexOf("</script></body></html>`;"));
check(dash.length > 500 && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(dash), "dashboard never builds HTML from activity entries (no innerHTML)", "innerHTML found in dashboard");
check(/td\.textContent=/.test(dash), "dashboard cells are set with textContent", "");

console.log("\n=== ports and permissions ===");
const manifest = JSON.parse(read("manifest.json"));
const bg = read("src/background.js");
const bridgePort = Number((read("bridge/server.js").match(/BTR_PORT === undefined \? (\d+)/) || [])[1]);
const demoPort = Number((read("demo/server.js").match(/DEMO_PORT \|\| (\d+)/) || [])[1]);
check(bridgePort && demoPort && bridgePort !== demoPort, "bridge and demo ports differ", `${bridgePort} vs ${demoPort}`);
check(bridgePort !== 9222 && demoPort !== 9222, "neither collides with the usual remote-debugging port 9222", "");
check(bg.includes(`http://127.0.0.1:${bridgePort}`), "background.js BRIDGE_ORIGIN matches the bridge port", "mismatch");
check(manifest.host_permissions.includes(`http://127.0.0.1:${bridgePort}/*`), "manifest grants the bridge origin", "missing");
check(!manifest.host_permissions.some((h) => h === "<all_urls>" || h.includes("*://*/")), "manifest has no all-sites host permission", JSON.stringify(manifest.host_permissions));
check(!manifest.permissions.includes("scripting"), "extension has no scripting permission", JSON.stringify(manifest.permissions));
check(manifest.host_permissions.every((h) => /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(h)), "manifest host permissions are localhost only by default", JSON.stringify(manifest.host_permissions));
for (const f of ["bridge/server.js", "demo/server.js"]) check(/listen\([^)]*"127\.0\.0\.1"/.test(read(f)), `${f} listens on 127.0.0.1 only`, "not bound to loopback");

console.log("\n=== source hygiene ===");
const CTRL = new RegExp("[\u0000-\u0008\u000b\u000c\u000e-\u001f]");
const HOME = /(\/Users\/[a-z]|C:\\\\Users\\\\|\/home\/[a-z])/;
const dirty = [], personal = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "exchange", "logs"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!/\.(js|mjs|json|md|html)$/.test(e.name) || e.name === "package-lock.json") continue;
    const t = fs.readFileSync(full, "utf8");
    const rel = path.relative(ROOT, full);
    if (CTRL.test(t)) dirty.push(rel);
    if (e.name !== "selftest.js" && HOME.test(t)) personal.push(rel);
  }
})(ROOT);
check(!dirty.length, "no invisible control characters in source", dirty.join(", "));
check(!personal.length, "no absolute home-directory paths in source or docs", personal.join(", "));

console.log("\n" + (failures ? "SELFTEST FAILED: " + failures + " problem(s)" : "SELFTEST PASSED") + "\n");
process.exit(failures ? 1 : 0);
