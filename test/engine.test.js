#!/usr/bin/env node
// End-to-end test of the shared engine against the demo app, with no browser:
// requests go through Node's fetch (the "node" transport) and, later, through
// the real bridge server and a stand-in for the extension.
//
//   node test/engine.test.js
//
// The demo app and the test bridge listen on free ports chosen by the OS.
// Writes only under os.tmpdir().

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { createEngine, makeNodeTransport, makeBridgeTransport } = require("../engine");
const { makeTmp, startDemo, skillsRoot } = require("./tmp");

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
const step = (name) => { passed++; console.log("  PASS  " + name); };
const get = (u, headers) => fetch(u, { headers }).then((r) => r.json());
const noSleep = async () => {};
let D, SR; // demo app, skills root pointed at it
const newEngine = (extra = {}) => createEngine({ root: SR, dataDir: makeTmp("btr-test-"), transport: makeNodeTransport(), sleep: noSleep, ...extra });
const goLive = async (e, runId, opts = {}) => e.act(runId, { dryRun: false, approval: e.approveLive(runId).approval, ...opts });

const rootWithSkill = (mutate) => skillsRoot(D.port, { "redirect-test": mutate });

async function main() {
  D = await startDemo();
  SR = skillsRoot(D.port);
  const engine = newEngine();
  console.log("\n=== engine (node transport) ===");

  const queue = (await engine.listQueue("demo-review-queue")).map((r) => r.id);
  assert.deepStrictEqual(queue, ["101", "102", "103", "104", "105", "106"]);
  step("list_queue returns the 6 pending ids");

  const h = await engine.harvest("demo-review-queue", queue);
  assert.strictEqual(h.status, "harvested"); assert.strictEqual(h.harvested_ok, 6);
  const i104 = engine.getHarvest(h.run_id).items.find((i) => i.id === "104");
  assert.ok(i104.body.includes("&amp;") && i104.bodyDecoded.includes(" & "));
  assert.strictEqual((await get(D.base + "/api/items?status=pending")).items.length, 6);
  step("harvest reads all 6 items, keeps raw and decoded body, changes nothing");

  assert.throws(() => engine.submitVerdicts(h.run_id, { 101: { verdict: "MAYBE" } }), /not one of APPROVE, REJECT, ESCALATE/);
  assert.throws(() => engine.submitVerdicts(h.run_id, { 999: { verdict: "APPROVE" } }), /not part of run/);
  step("submit_verdicts rejects unknown verdicts and ids");

  const verdicts = JSON.parse(fs.readFileSync(path.join(ROOT, "demo/verdicts.example.json"), "utf8"));
  engine.submitVerdicts(h.run_id, verdicts);
  assert.throws(() => engine.approveLive(h.run_id), /run a dry run of the current verdicts first/);
  await assert.rejects(engine.act(h.run_id, { dryRun: false }), /no approval/);
  step("approve_live and live act are refused before a dry run");

  const dry = await engine.act(h.run_id);
  assert.strictEqual(dry.mode, "dry_run");
  assert.strictEqual(dry.items.filter((i) => i.status === "DRY_RUN").length, 5);
  assert.strictEqual(dry.items.find((i) => i.id === "105").status, "ESCALATE");
  assert.strictEqual((await get(D.base + "/api/items?status=pending")).items.length, 6);
  step("dry run plans 5 requests, escalates 105, sends nothing");

  await assert.rejects(engine.act(h.run_id, { dryRun: false }), /no approval/);
  await assert.rejects(engine.act(h.run_id, { dryRun: false, approval: "not-a-token" }), /not recognised/);
  const exp = engine.approveLive(h.run_id, { ttlMs: -1 });
  await assert.rejects(engine.act(h.run_id, { dryRun: false, approval: exp.approval }), /expired/);
  step("a dry run alone does not unlock live; bad and expired approvals are refused");

  const ap = engine.approveLive(h.run_id);
  assert.ok(ap.plan_summary.items.length === 6 && ap.expires_at);
  const l1 = await engine.act(h.run_id, { dryRun: false, approval: ap.approval });
  assert.strictEqual(l1.cap, 1); assert.strictEqual(l1.attempted, 1);
  await assert.rejects(engine.act(h.run_id, { dryRun: false, approval: ap.approval }), /already used/);
  step("approve_live returns the plan summary; the approval is single-use");

  const l2 = await goLive(engine, h.run_id);
  assert.strictEqual(l2.cap, 3); assert.strictEqual(l2.attempted, 3);
  const l3 = await goLive(engine, h.run_id);
  assert.strictEqual(l3.attempted, 1); assert.strictEqual(l3.remaining_to_act, 0);
  step("staged rollout caps live batches at 1, then 3, then the rest");

  const st = Object.fromEntries((await get(D.base + "/api/items")).items.map((i) => [i.id, i.status]));
  assert.deepStrictEqual(st, { 101: "approved", 102: "rejected", 103: "approved", 104: "approved", 105: "pending", 106: "approved" });
  step("site state matches the verdicts; escalated 105 untouched");

  const again = await goLive(engine, h.run_id);
  assert.strictEqual(again.attempted, 0);
  const v = await engine.verify(h.run_id);
  assert.strictEqual(v.checked, 5); assert.strictEqual(v.failed, 0);
  step("re-running live acts on nothing; verify confirms all 5");

  // Verdicts changed after approval.
  D.reset();
  const e2 = newEngine();
  const h2 = await e2.harvest("demo-review-queue", ["103", "104"]);
  e2.submitVerdicts(h2.run_id, { 103: { verdict: "APPROVE" }, 104: { verdict: "APPROVE" } });
  await e2.act(h2.run_id);
  const ap2 = e2.approveLive(h2.run_id);
  e2.submitVerdicts(h2.run_id, { 103: { verdict: "REJECT" } });
  await assert.rejects(e2.act(h2.run_id, { dryRun: false, approval: ap2.approval }), /changed since approval/);
  step("an approval is void once the verdicts change");

  // Stale content.
  e2.submitVerdicts(h2.run_id, { 103: { verdict: "APPROVE" } });
  const runPath = path.join(e2.dataDir, "exchange/runs", h2.run_id, "run.json");
  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  run.harvest["103"]._contentHash = "edited-since-review";
  fs.writeFileSync(runPath, JSON.stringify(run));
  assert.strictEqual((await e2.act(h2.run_id)).items.find((i) => i.id === "103").status, "STALE");
  step("an item whose content changed since review is skipped as STALE");

  const cb = await engine.harvest("demo-review-queue", ["901", "902", "903", "904", "905"]);
  assert.strictEqual(cb.status, "circuit_open"); assert.strictEqual(cb.harvest_errors, 3);
  step("circuit breaker stops after 3 consecutive errors");

  const log = engine.readAuditLog({ runId: h.run_id, tail: 1000 });
  assert.ok(log.length > 20 && log.some((e) => e.phase === "approve"));
  step(`audit log holds ${log.length} entries for the run, including approvals`);

  await assert.rejects(newEngine({ allowHosts: ["example.com"] }).harvest("demo-review-queue", ["101"]), /not in the allowed hosts/);
  step("a skill whose host is not allowed is refused");

  // ---- concurrency ----
  console.log("\n=== live-act lock ===");
  D.reset();
  const cdir = makeTmp("btr-conc-");
  const ca = createEngine({ root: SR, dataDir: cdir, transport: makeNodeTransport(), sleep: (ms) => new Promise((r) => setTimeout(r, 20)) });
  const cb2 = createEngine({ root: SR, dataDir: cdir, transport: makeNodeTransport(), sleep: (ms) => new Promise((r) => setTimeout(r, 20)) });
  const ch = await ca.harvest("demo-review-queue", ["101", "102", "103", "104", "106"]);
  ca.submitVerdicts(ch.run_id, { 101: { verdict: "APPROVE" }, 102: { verdict: "REJECT" }, 103: { verdict: "APPROVE" }, 104: { verdict: "APPROVE" }, 106: { verdict: "APPROVE" } });
  await ca.act(ch.run_id);
  const t1 = ca.approveLive(ch.run_id).approval, t2 = cb2.approveLive(ch.run_id).approval;
  const [r1, r2] = await Promise.all([ca.act(ch.run_id, { dryRun: false, approval: t1 }), cb2.act(ch.run_id, { dryRun: false, approval: t2 })]);
  const done = [...r1.items, ...r2.items].filter((i) => i.status === "DONE").map((i) => i.id);
  assert.strictEqual(done.length, new Set(done).size, "an item was acted on twice");
  assert.deepStrictEqual([r1.attempted, r2.attempted].sort(), [1, 3]);
  assert.ok(!fs.existsSync(path.join(cdir, "logs/demo-review-queue.lock")));
  step("two concurrent live acts run one after the other: caps 1 then 3, no item twice, lock released");

  fs.writeFileSync(path.join(cdir, "logs/demo-review-queue.lock"), JSON.stringify({ pid: 999999, owner: "dead" }));
  const r3 = await goLive(ca, ch.run_id);
  assert.strictEqual(r3.attempted, 1);
  step("a stale lock left by a dead process is cleared");

  // ---- redirects ----
  console.log("\n=== redirects ===");
  D.reset();
  const rd = newEngine();
  const rh = await rd.harvest("demo-review-queue", ["r1", "r2"]);
  const items = Object.fromEntries(rd.getHarvest(rh.run_id).items.map((i) => [i.id, i._code]));
  assert.strictEqual(items.r1, "REDIRECT_BLOCKED");
  assert.strictEqual(items.r2, "IDENTITY_MISMATCH");
  step("read: an off-host redirect is not followed; a same-origin one is, and the identity guard catches it");

  const rootL = rootWithSkill((s) => { s.list.url = "/redirect-offsite"; });
  await assert.rejects(createEngine({ root: rootL, dataDir: makeTmp("btr-r-"), transport: makeNodeTransport() }).listQueue("redirect-test"), /redirect not followed/);
  step("list: an off-host redirect is refused");

  const rootA = rootWithSkill((s) => { s.actions.approve.urlTemplate = "/items/{id}/redirect-offsite"; });
  const ra = createEngine({ root: rootA, dataDir: makeTmp("btr-r-"), transport: makeNodeTransport(), sleep: noSleep });
  const rah = await ra.harvest("redirect-test", ["101"]);
  ra.submitVerdicts(rah.run_id, { 101: { verdict: "APPROVE" } });
  await ra.act(rah.run_id);
  const rres = await goLive(ra, rah.run_id);
  assert.strictEqual(rres.items[0].status, "REDIRECT_BLOCKED");
  step("act: a POST answered with an off-host redirect fails and is not followed");

  const rootV = rootWithSkill((s) => { s.verify.APPROVE = { urlTemplate: "/redirect-offsite", expectStatus: 200 }; });
  const rv = createEngine({ root: rootV, dataDir: makeTmp("btr-r-"), transport: makeNodeTransport(), sleep: noSleep });
  const rvh = await rv.harvest("redirect-test", ["103"]);
  rv.submitVerdicts(rvh.run_id, { 103: { verdict: "APPROVE" } });
  await rv.act(rvh.run_id);
  const rvl = await goLive(rv, rvh.run_id);
  assert.strictEqual(rvl.items[0].status, "VERIFY_FAILED");
  step("verify: an off-host redirect counts as a failed verification");

  // ---- round-2 fixes ----
  console.log("\n=== request origin, approved scope, lock ownership ===");
  D.reset();
  const rootH = rootWithSkill((s) => { s.read.urlTemplate = "@evil.example/items/{id}"; });
  const hb = createEngine({ root: rootH, dataDir: makeTmp("btr-r-"), transport: makeNodeTransport(), sleep: noSleep });
  const hbr = await hb.harvest("redirect-test", ["101"]);
  assert.strictEqual(hb.getHarvest(hbr.run_id).items[0]._code, "HOST_BLOCKED");
  step("a URL template that changes the host (\"@evil.example\") is refused before any request (HOST_BLOCKED)");

  const rootS = rootWithSkill((s) => { s.safety.stagedRollout = [20]; });
  const sc = createEngine({ root: rootS, dataDir: makeTmp("btr-r-"), transport: makeNodeTransport(), sleep: noSleep });
  const sch = await sc.harvest("redirect-test", ["101", "103", "106"]);
  sc.submitVerdicts(sch.run_id, { 101: { verdict: "APPROVE" }, 103: { verdict: "APPROVE" }, 106: { verdict: "APPROVE" } });
  const scd = await sc.act(sch.run_id, { limit: 1 });
  assert.strictEqual(scd.items.filter((i) => i.status === "DRY_RUN").length, 1);
  const scl = await goLive(sc, sch.run_id);
  assert.deepStrictEqual(scl.items.filter((i) => i.status === "DONE").map((i) => i.id), ["101"]);
  const after = Object.fromEntries((await get(D.base + "/api/items")).items.map((i) => [i.id, i.status]));
  assert.deepStrictEqual([after[101], after[103], after[106]], ["approved", "pending", "pending"]);
  step("a live act after a limited dry run touches only the items that dry run planned");

  const lk = createEngine({ root: SR, dataDir: makeTmp("btr-lock-"), transport: makeNodeTransport(), sleep: noSleep, lockTimeoutMs: 500 });
  const lkh = await lk.harvest("demo-review-queue", ["104"]);
  lk.submitVerdicts(lkh.run_id, { 104: { verdict: "APPROVE" } });
  await lk.act(lkh.run_id);
  const lockFile = path.join(lk.dataDir, "logs/demo-review-queue.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, owner: "someone-else", at: 0 }));
  await assert.rejects(goLive(lk, lkh.run_id), /holds/);
  assert.ok(fs.existsSync(lockFile));
  step("a lock held by a live process is never treated as stale, however old");
  fs.unlinkSync(lockFile);
  const lk2 = createEngine({ root: SR, dataDir: lk.dataDir, transport: makeNodeTransport(), sleep: noSleep,
    onEvent: (e) => { if (e.phase === "act" && e.status === "START" && !e.dryRun) fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, owner: "someone-else" })); } });
  await goLive(lk2, lkh.run_id);
  assert.strictEqual(JSON.parse(fs.readFileSync(lockFile, "utf8")).owner, "someone-else");
  fs.unlinkSync(lockFile);
  step("a finishing act removes the lock only if it still owns it");

  // ---- round 7 ----
  console.log("\n=== read-only reads, harvested-only verdicts, secrets ===");
  D.reset();
  const postsBefore = D.stats.posts;
  const rootP = rootWithSkill((s) => { s.read.method = "POST"; });
  const pe = createEngine({ root: rootP, dataDir: makeTmp("btr-r-"), transport: makeNodeTransport(), sleep: noSleep });
  await assert.rejects(pe.harvest("redirect-test", ["101"]), /read\.method must be GET/);
  const rootPL = rootWithSkill((s) => { s.list.method = "POST"; });
  await assert.rejects(createEngine({ root: rootPL, dataDir: makeTmp("btr-r-"), transport: makeNodeTransport() }).listQueue("redirect-test"), /list\.method must be GET/);
  assert.strictEqual(D.stats.posts, postsBefore, "a POST reached the demo app");
  step("a skill with read.method or list.method POST is rejected; no POST reaches the site");

  const ue = newEngine();
  const uh = await ue.harvest("demo-review-queue", ["901", "902", "903", "101"]);
  assert.strictEqual(uh.status, "circuit_open");
  assert.throws(() => ue.submitVerdicts(uh.run_id, { 101: { verdict: "APPROVE" } }), /101: item was not harvested/);
  assert.throws(() => ue.submitVerdicts(uh.run_id, { 901: { verdict: "APPROVE" } }), /harvest failed/);
  assert.strictEqual((await get(D.base + "/api/items")).items.find((i) => i.id === "101").status, "pending");
  step("a verdict for an id the harvest never reached (stopped early) is rejected, so it can never be acted on");

  const se = newEngine();
  const sh = await se.harvest("demo-review-queue", ["103"]);
  const page103 = await (await fetch(D.base + "/items/103")).text();
  const csrf = page103.match(/name="csrf" value="([^"]+)"/)[1];
  assert.ok(!("csrfToken" in se.getHarvest(sh.run_id).items[0]));
  se.submitVerdicts(sh.run_id, { 103: { verdict: "APPROVE" } });
  const sd = await se.act(sh.run_id);
  assert.ok(sd.items[0].would[0].body.includes("csrf=[secret]"), JSON.stringify(sd.items[0].would));
  const onDisk = fs.readFileSync(path.join(se.dataDir, "exchange/runs", sh.run_id, "run.json"), "utf8") + fs.readFileSync(path.join(se.dataDir, "logs/demo-review-queue.audit.jsonl"), "utf8");
  assert.ok(!JSON.stringify(sd).includes(csrf) && !onDisk.includes(csrf));
  assert.strictEqual((await goLive(se, sh.run_id)).items[0].verified, true);
  step("fields marked secret (the CSRF token) are used at act time but never stored, returned or logged");

  // ---- round 8 ----
  console.log("\n=== secret URLs in the dry-run log, verification failures trip the breaker ===");
  D.reset();
  const rootQ = rootWithSkill((s) => { s.actions.approve.urlTemplate = "/items/{id}/approve?csrf={csrfToken}"; });
  const qe = createEngine({ root: rootQ, dataDir: makeTmp("btr-r-"), transport: makeNodeTransport(), sleep: noSleep });
  const qh = await qe.harvest("redirect-test", ["103"]);
  const csrfQ = (await (await fetch(D.base + "/items/103")).text()).match(/name="csrf" value="([^"]+)"/)[1];
  qe.submitVerdicts(qh.run_id, { 103: { verdict: "APPROVE" } });
  const qd = await qe.act(qh.run_id);
  assert.ok(qd.items[0].would[0].url.includes("csrf=[secret]"), JSON.stringify(qd.items[0].would));
  const qlog = fs.readFileSync(path.join(qe.dataDir, "logs/redirect-test.audit.jsonl"), "utf8");
  assert.ok(!qlog.includes(csrfQ) && qlog.includes("csrf=[secret]"));
  step("a secret in an action URL is redacted in the dry-run audit log, not only in the returned plan");

  D.reset();
  const rootC = rootWithSkill((s) => { s.safety.stagedRollout = [20]; s.verify.APPROVE = { urlTemplate: "/redirect-offsite", expectStatus: 200 }; });
  const ce = createEngine({ root: rootC, dataDir: makeTmp("btr-r-"), transport: makeNodeTransport(), sleep: noSleep });
  const cbh = await ce.harvest("redirect-test", ["101", "103", "104", "106"]);
  ce.submitVerdicts(cbh.run_id, { 101: { verdict: "APPROVE" }, 103: { verdict: "APPROVE" }, 104: { verdict: "APPROVE" }, 106: { verdict: "APPROVE" } });
  await ce.act(cbh.run_id);
  const cl = await goLive(ce, cbh.run_id);
  assert.strictEqual(cl.circuit_open, true);
  assert.strictEqual(cl.attempted, 3);
  assert.deepStrictEqual(cl.items.map((i) => i.status), ["VERIFY_FAILED", "VERIFY_FAILED", "VERIFY_FAILED"]);
  assert.strictEqual((await get(D.base + "/api/items")).items.find((i) => i.id === "106").status, "pending");
  step("three consecutive failed verifications open the circuit breaker; the fourth item is never acted on");

  // ---- bridge path ----
  console.log("\n=== bridge (token, origin, job policy) + extension stand-in ===");
  D.reset();
  const bdir = makeTmp("btr-bridge-");
  const bridge = spawn(process.execPath, [path.join(ROOT, "bridge/server.js")], { env: { ...process.env, BTR_PORT: "0", BTR_DATA_DIR: bdir }, stdio: ["ignore", "pipe", "ignore"] });
  const BP = await new Promise((ok, no) => {
    let out = "";
    bridge.stdout.on("data", (c) => { out += c; const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/); if (m) ok(Number(m[1])); });
    bridge.on("exit", () => no(new Error("bridge exited: " + out)));
  });
  bridge.stdout.resume();
  const BB = `http://127.0.0.1:${BP}`;
  try {
    const token = fs.readFileSync(path.join(bdir, ".btr-token"), "utf8").trim();
    assert.ok(/^[0-9a-f]{48}$/.test(token));
    // POSIX mode bits are not enforced on Windows; there the file inherits the data dir's ACL.
    if (process.platform !== "win32") assert.ok((fs.statSync(path.join(bdir, ".btr-token")).mode & 0o077) === 0);
    const post = (p, body, headers = {}) => fetch(BB + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.strictEqual((await post("/job", { type: "fetch", url: D.base + "/health" })).status, 401);
    assert.strictEqual((await fetch(BB + "/activity")).status, 401);
    assert.strictEqual((await post("/job", { type: "fetch", url: D.base + "/health" }, { "X-BTR-Token": token, Origin: "https://evil.example" })).status, 403);
    assert.strictEqual((await fetch(BB + "/job", { method: "OPTIONS" })).status, 403);
    assert.strictEqual((await post("/job", { type: "exec", url: D.base + "/", code: "1" }, { "X-BTR-Token": token })).status, 400);
    assert.strictEqual((await post("/job", { type: "fetch", url: "https://example.com/" }, { "X-BTR-Token": token })).status, 400);
    const hres = await fetch(BB + "/health");
    assert.ok(!hres.headers.get("access-control-allow-origin"));
    step("bridge: token required, foreign origin and preflight refused, exec and disallowed hosts refused, no CORS");

    let stop = false;
    // Does what src/background.js does: token header, allow-list, write flag, manual redirects.
    (async function fakeExtension() {
      const H = { "X-BTR-Token": token };
      while (!stop) {
        let job;
        try { ({ job } = await get(BB + "/jobs/next?wait=1", H)); } catch { await new Promise((r) => setTimeout(r, 100)); continue; }
        if (!job) continue;
        let out;
        const m = (job.method || "GET").toUpperCase();
        if (m !== "GET" && job.write !== true) out = { ok: false, error: "unmarked write" };
        else {
          const r = await fetch(job.url, { method: m, headers: job.headers || {}, body: job.body, redirect: "manual" });
          out = r.status >= 300 && r.status < 400 ? { ok: false, status: r.status, redirectBlocked: true } : { ok: r.ok, status: r.status, url: r.url, body: await r.text() };
        }
        await new Promise((ok) => { const q = http.request({ host: "127.0.0.1", port: BP, path: "/result/" + job.id, method: "POST", headers: H }, (s) => { s.resume(); s.on("end", ok); }); q.end(JSON.stringify({ jobId: job.id, ...out })); });
      }
    })();
    const be = createEngine({ root: SR, dataDir: makeTmp("btr-test-b-"), transport: makeBridgeTransport({ port: BP, token }), sleep: noSleep });
    const bh = await be.harvest("demo-review-queue", ["101", "102", "r1"]);
    assert.strictEqual(bh.harvested_ok, 2);
    assert.strictEqual(be.getHarvest(bh.run_id).items.find((i) => i.id === "r1")._code, "REDIRECT_BLOCKED");
    be.submitVerdicts(bh.run_id, { 101: { verdict: "APPROVE" }, 102: { verdict: "REJECT" } });
    await be.act(bh.run_id);
    const bl = await goLive(be, bh.run_id);
    assert.strictEqual(bl.attempted, 1); assert.strictEqual(bl.items.find((i) => i.status === "DONE").verified, true);
    step("harvest -> dry run -> approve -> live through the bridge; redirects reported as blocked");
    const leftover = fs.readdirSync(path.join(bdir, "exchange/results"));
    assert.deepStrictEqual(leftover, [], "fetched page bodies left on disk: " + leftover);
    step("bridge job results (fetched page bodies) are deleted once read");
    stop = true;
  } finally { bridge.kill(); }

  D.server.close();
  console.log(`\nENGINE TESTS PASSED (${passed})\n`);
}

main().catch((e) => { console.error("\nENGINE TEST FAILED:", (e && e.stack) || e); process.exit(1); });
