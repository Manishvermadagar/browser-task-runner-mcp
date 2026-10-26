// The shared engine. Used by the MCP server (mcp/server.mjs), the bridge
// command-line tools (bridge/*.js) and the tests. It owns the whole run
// life cycle and every safety control:
//
//   harvest (read-only) -> submitVerdicts -> act(dry run) -> act(live) -> verify
//
// State lives on disk so a crash never loses place:
//   <data>/exchange/runs/<run_id>/run.json    one run: ids, harvest, verdicts, results
//   <data>/logs/<skill>.audit.jsonl           append-only audit log, every event
//   <data>/logs/<skill>.processed.json        resumable index of items acted on live
//   <data>/logs/<skill>.rollout.json          staged-rollout progress

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const S = require("./skills");

const ROOT = path.resolve(__dirname, "..");
const APPROVAL_TTL_MS = 15 * 60 * 1000;

function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function createEngine({ root = ROOT, dataDir = process.env.BTR_DATA_DIR || root, transport, sleep, onEvent, allowHosts, lockTimeoutMs = 120000 } = {}) {
  const { parseAllowHosts, hostAllowed } = require("./browser");
  const allow = allowHosts || parseAllowHosts(process.env.BTR_ALLOW_HOSTS);
  // Same host allow-list as the browser tools: a skill can only run against
  // a host the user has allowed.
  const loadSkill = (id) => {
    const s = S.loadSkill(root, id);
    if (!hostAllowed(s.baseUrl, allow)) throw new Error(`skill "${id}" targets ${new URL(s.baseUrl).host}, which is not in the allowed hosts (${allow.join(", ")}). Add it with BTR_ALLOW_HOSTS.`);
    return s;
  };
  if (!transport) throw new Error("createEngine needs a transport");
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const RUNS = path.join(dataDir, "exchange", "runs");
  const LOGS = path.join(dataDir, "logs");
  fs.mkdirSync(RUNS, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });

  // ---- persistence --------------------------------------------------------
  const runFile = (id) => {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error(`invalid run_id "${id}"`);
    return path.join(RUNS, id, "run.json");
  };
  function loadRun(id) {
    const f = runFile(id);
    if (!fs.existsSync(f)) throw new Error(`no run "${id}"`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  function saveRun(run) {
    const f = runFile(run.run_id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
    fs.renameSync(tmp, f); // atomic: a reader never sees half a file
  }
  const jsonFile = (skill, kind) => path.join(LOGS, `${skill}.${kind}.json`);
  const readJson = (f, dflt) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : dflt);
  const writeJson = (f, v) => { const t = f + ".tmp" + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); };

  function audit(run, entry) {
    const e = { at: new Date().toISOString(), run_id: run.run_id, skill: run.skill, ...entry };
    fs.appendFileSync(path.join(LOGS, `${run.skill}.audit.jsonl`), JSON.stringify(e) + "\n");
    if (onEvent) { try { onEvent(e); } catch { /* observer must not break a run */ } }
    return e;
  }

  // ---- every request to a site goes through here ----------------------------
  // Redirects are followed only to the skill's own origin on an allowed host,
  // and only by transports that can see the destination (see transports.js).
  // Any other redirect fails the request with REDIRECT_BLOCKED, unless the
  // action is declared acceptRedirect (a redirect after a successful POST),
  // in which case it counts as success but is still not followed.
  async function send(skill, req, { acceptRedirect = false } = {}) {
    const origin = new URL(skill.baseUrl).origin;
    const allowRedirect = (u) => { try { return new URL(u).origin === origin && hostAllowed(u, allow); } catch { return false; } };
    if (new URL(req.url).origin !== origin || !hostAllowed(req.url, allow)) {
      throw Object.assign(new Error(`request outside the skill origin: ${req.url}`), { code: "HOST_BLOCKED" });
    }
    const res = await transport.request({ ...req, allowRedirect });
    if (res.redirectBlocked) {
      if (acceptRedirect) return { ...res, ok: true };
      throw Object.assign(new Error(`redirect not followed from ${req.url}${res.location ? " to " + res.location : ""} (only same-origin, allowed-host redirects are followed, and only when the destination is visible)`), { code: "REDIRECT_BLOCKED" });
    }
    return res;
  }

  // ---- live-act lock (one live act per skill, across processes) -------------
  // Only a lock whose owning process is dead is treated as stale; a slow but
  // live act is never pre-empted. The lock records a random owner id and is
  // removed only by that owner.
  async function withSkillLock(skillId, fn, { timeoutMs = lockTimeoutMs } = {}) {
    const f = path.join(LOGS, `${skillId}.lock`);
    const owner = crypto.randomUUID();
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(f, "wx");
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, owner }));
        fs.closeSync(fd);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* being written */ }
        let alive = true;
        if (holder) { try { process.kill(holder.pid, 0); } catch (k) { alive = k.code === "EPERM"; } }
        if (holder && !alive) { try { fs.unlinkSync(f); } catch {} continue; }
        if (Date.now() > until) throw Object.assign(new Error(`another live act for skill "${skillId}" holds ${f}`), { code: "LOCKED" });
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    try { return await fn(); } finally {
      try {
        const cur = JSON.parse(fs.readFileSync(f, "utf8"));
        if (cur.owner === owner) fs.unlinkSync(f);
      } catch { /* already gone */ }
    }
  }

  // ---- reading one item ---------------------------------------------------
  async function readItem(skill, item) {
    const vars = { ...item };
    const url = S.resolveUrl(skill, skill.read.urlTemplate, vars);
    const res = await send(skill, { url, method: "GET" });
    if (!res.ok) throw Object.assign(new Error(`read failed: HTTP ${res.status} (${url})`), { code: "FETCH_FAILED" });
    const fields = S.extractFields(res.body, skill);
    for (const r of skill.read.requiredExtract || []) {
      if (fields[r] == null) throw Object.assign(new Error(`required field "${r}" not found; the page layout may have changed`), { code: "EXTRACT_FAILED" });
    }
    // Identity guard: some admin sites serve a different item's page for an
    // id that is no longer pending. Never act on a page that is not the item
    // that was asked for.
    const g = skill.read.identityGuard;
    if (g && String(fields[g.mustEqualExtract]) !== String(vars[g.requestedIdVar || "id"])) {
      throw Object.assign(new Error(`page shows item ${fields[g.mustEqualExtract]}, not ${vars[g.requestedIdVar || "id"]}`), { code: "IDENTITY_MISMATCH" });
    }
    const cf = skill.read.contentField;
    const contentHash = cf ? sha(fields[cf] == null ? "" : fields[cf]) : null;
    return { fields, contentHash };
  }

  const secretNames = (skill) => skill.read.extract.filter((r) => r.secret).flatMap((r) => [r.name, r.name + "Decoded"]);
  function stripSecrets(skill, fields) {
    const out = { ...fields };
    for (const n of secretNames(skill)) delete out[n];
    return out;
  }
  // Replaces secret values (raw, URI-encoded and form-encoded) in a string.
  function hideSecrets(skill, fields, str) {
    if (typeof str !== "string") return str;
    let s = str;
    for (const n of secretNames(skill)) {
      const v = fields[n];
      if (!v) continue;
      for (const form of [String(v), encodeURIComponent(v), new URLSearchParams({ x: v }).toString().slice(2)]) s = s.split(form).join("[secret]");
    }
    return s;
  }

  function preconditionFails(skill, fields) {
    const p = skill.read.actOnlyWhen;
    if (!p) return null;
    return String(fields[p.field]) === String(p.equals) ? null : `${p.field} is "${fields[p.field]}", expected "${p.equals}"`;
  }

  function normaliseIds(ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error("ids must be a non-empty array");
    return ids.map((x) => (x && typeof x === "object" ? { ...x, id: String(x.id) } : { id: String(x) }));
  }

  async function doAct(runId, { live, limit, approval }) {
      const run = loadRun(runId); // re-read under the lock: another act may have changed it
      const skill = loadSkill(run.skill);
      const sf = skill.safety;
      if (!run.verdicts) throw new Error("no verdicts submitted for this run");

      if (live) {
        // Gate 1: an explicit, unexpired, unused approval bound to this run,
        // these verdicts and the dry-run plan the user was shown.
        if (!approval) throw new Error("live act refused: no approval. Run a dry run, show the user the plan, then call approve_live and pass its approval token.");
        const d = run.lastDryRun;
        const entry = (run.approvals || []).find((x) => x.tokenHash === sha(approval));
        if (!entry) throw new Error("live act refused: approval not recognised for this run");
        if (entry.used) throw new Error("live act refused: approval already used; request a new one");
        if (entry.expires < Date.now()) throw new Error("live act refused: approval expired; request a new one");
        if (entry.verdictsHash !== run.verdictsHash || !d || entry.planHash !== d.planHash || d.verdictsHash !== run.verdictsHash) {
          throw new Error("live act refused: verdicts or dry-run plan changed since approval; dry-run again and re-approve");
        }
        entry.used = true;
        entry.usedAt = Date.now();
        saveRun(run); // consumed before any request is sent
      }
      // Gate 2: staged rollout and batch cap.
      const rolloutFile = jsonFile(skill.id, "rollout");
      const rollout = readJson(rolloutFile, { cleanLiveBatches: 0 });
      const stage = sf.stagedRollout[rollout.cleanLiveBatches];
      const cap = live ? Math.min(stage === undefined ? sf.maxBatch : stage, sf.maxBatch) : Infinity;
      const max = Math.min(limit || Infinity, cap);

      const processedFile = jsonFile(skill.id, "processed");
      const processed = readJson(processedFile, {});
      const plan = [];
      let attempted = 0, errors = 0, consecutive = 0, tripped = false;
      audit(run, { phase: "act", status: "START", dryRun: !live, detail: live ? `live, cap ${max}` : "dry run" });

      // A live act may only touch items the approved dry run actually planned
      // (a dry run with a limit plans fewer items than the run holds).
      const approvedIds = live
        ? new Set(run.lastDryRun.summary.items.filter((p) => p.status === "DRY_RUN").map((p) => p.id))
        : null;
      for (const item of run.ids) {
        const v = run.verdicts[item.id];
        if (!v || (approvedIds && !approvedIds.has(item.id))) continue;
        if (attempted >= max) break;
        // Resumable: an item already acted on live is never acted on again.
        if (processed[item.id]) { plan.push({ id: item.id, status: "ALREADY_DONE", at: processed[item.id].at }); continue; }

        const order = skill.actionOrder[v.verdict];
        if (order.length === 0) {
          const r = { id: item.id, verdict: v.verdict, status: "ESCALATE", detail: v.reason || "no automatic action for this verdict; needs a person" };
          plan.push(r); audit(run, { phase: "act", ...r, dryRun: !live });
          continue;
        }
        attempted++;
        try {
          // Fresh read right before acting: current token, current content.
          const { fields, contentHash } = await readItem(skill, item);
          const h = run.harvest[item.id] || {};
          if (skill.read.contentField && h._contentHash && contentHash !== h._contentHash) {
            throw Object.assign(new Error("content changed since it was reviewed; re-harvest and review again"), { code: "STALE" });
          }
          const pre = preconditionFails(skill, fields);
          if (pre) throw Object.assign(new Error("precondition failed: " + pre), { code: "STALE" });
          const vars = { ...item, ...fields, ...v };
          const requests = order.map((a) => ({ action: a, ...S.buildRequest(skill, a, vars) }));
          if (!live) {
            const r = { id: item.id, verdict: v.verdict, status: "DRY_RUN", would: requests.map((q) => ({ action: q.action, method: q.method, url: hideSecrets(skill, fields, q.url), body: hideSecrets(skill, fields, q.body) })) };
            plan.push(r); audit(run, { phase: "act", id: item.id, status: "DRY_RUN", dryRun: true, detail: requests.map((q) => `${q.method} ${q.url}`).join(" ; ") });
          } else {
            for (const q of requests) {
              const { action: _a, ...httpReq } = q;
              const res = await send(skill, httpReq, { acceptRedirect: !!skill.actions[q.action].acceptRedirect });
              if (!res.ok) throw Object.assign(new Error(`action "${q.action}" failed: HTTP ${res.status}`), { code: "ERROR" });
            }
            processed[item.id] = { at: new Date().toISOString(), run_id: run.run_id, verdict: v.verdict, actions: order };
            writeJson(processedFile, processed); // persisted before moving on
            const ver = await verifyOne(skill, item, v.verdict);
            run.results[item.id] = { verdict: v.verdict, actions: order, verified: ver.verified, at: processed[item.id].at };
            const r = { id: item.id, verdict: v.verdict, status: "DONE", verified: ver.verified };
            plan.push(r);
            audit(run, { phase: "act", id: item.id, status: ver.verified === false ? "VERIFY_FAILED" : "DONE", detail: `${order.join(" -> ")} verified=${ver.verified === null ? "n/a" : ver.verified ? "yes" : "no"}${ver.detail ? " (" + ver.detail + ")" : ""}` });
            if (ver.verified === false) errors++;
          }
          consecutive = 0;
        } catch (e) {
          errors++; consecutive++;
          const r = { id: item.id, verdict: v.verdict, status: e.code || "ERROR", detail: e.message };
          plan.push(r); audit(run, { phase: "act", ...r, dryRun: !live });
          if (consecutive >= sf.maxConsecutiveErrors) {
            tripped = true;
            audit(run, { phase: "act", status: "CIRCUIT_OPEN", detail: `${consecutive} consecutive errors; stopped` });
            break;
          }
        }
        saveRun(run);
        await wait(sf.rateLimitMs);
      }

      if (!live && !tripped) {
        run.dryRuns.push(run.verdictsHash);
        const lines = plan.map((p) => ({ id: p.id, verdict: p.verdict, status: p.status, requests: (p.would || []).map((w) => `${w.method} ${w.url}`) }));
        const counts = {};
        for (const p of plan) counts[p.status] = (counts[p.status] || 0) + 1;
        run.lastDryRun = { verdictsHash: run.verdictsHash, planHash: sha(stableStringify(lines)), at: new Date().toISOString(), summary: { counts, items: lines } };
      }
      if (live && !tripped && errors === 0 && attempted > 0) {
        rollout.cleanLiveBatches++;
        writeJson(rolloutFile, rollout);
      }
      run.status = tripped ? "circuit_open" : live ? "acted" : "dry_run_done";
      saveRun(run);
      const remaining = run.ids.filter((i) => run.verdicts[i.id] && !processed[i.id] && skill.actionOrder[run.verdicts[i.id].verdict].length).length;
      audit(run, { phase: "act", status: tripped ? "CIRCUIT_OPEN" : "END", dryRun: !live, detail: `attempted ${attempted}, errors ${errors}, remaining ${remaining}` });
      const out = { run_id: runId, mode: live ? "live" : "dry_run", cap: live ? max : null, attempted, errors, circuit_open: tripped, remaining_to_act: remaining, items: plan };
      if (!live && !tripped) out.next = "Show the user this plan. If they approve, call approve_live, then act with dry_run=false and the approval.";
      return out;
  }

  // ---- public API -----------------------------------------------------------
  const api = {
    dataDir,
    listSkills() {
      return S.loadRegistry(root).map((id) => {
        try { const s = S.loadSkill(root, id); return { id, label: s.label, baseUrl: s.baseUrl, verdicts: Object.keys(s.actionOrder) }; }
        catch (e) { return { id, error: e.message }; }
      });
    },

    describeSkill(id) {
      const skill = S.loadSkill(root, id);
      const dir = path.join(root, "src", "skills", id);
      const opt = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : null);
      return { skill, ruleset: opt("ruleset.md"), notes: opt("NOTES.md") };
    },

    async listQueue(skillId) {
      const skill = loadSkill(skillId);
      if (!skill.list) throw new Error(`skill "${skillId}" has no list config; supply ids directly`);
      const res = await send(skill, { url: skill.baseUrl + skill.list.url, method: "GET" });
      if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`);
      const data = JSON.parse(res.body);
      const rows = skill.list.itemsPath ? String(skill.list.itemsPath).split(".").reduce((o, k) => o && o[k], data) : data;
      return (rows || []).map((r) => ({ id: String(r[skill.list.idField || "id"]) }));
    },

    async harvest(skillId, ids, { limit } = {}) {
      const skill = loadSkill(skillId);
      let items = normaliseIds(ids);
      if (limit) items = items.slice(0, limit);
      const run = { run_id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`, skill: skill.id,
        created: new Date().toISOString(), status: "harvesting", ids: items, harvest: {}, verdicts: null,
        verdictsHash: null, dryRuns: [], results: {} };
      saveRun(run);
      audit(run, { phase: "harvest", status: "START", detail: `${items.length} items` });
      let consecutive = 0;
      for (const item of items) {
        try {
          const { fields, contentHash } = await readItem(skill, item);
          // Fields marked "secret" in the skill (tokens and the like) are used
          // at act time from a fresh read, but never stored or returned.
          run.harvest[item.id] = { ...item, ...stripSecrets(skill, fields), _contentHash: contentHash, _harvestedAt: new Date().toISOString() };
          consecutive = 0;
          audit(run, { phase: "harvest", id: item.id, status: "OK" });
        } catch (e) {
          run.harvest[item.id] = { ...item, _error: e.message, _code: e.code || "ERROR" };
          consecutive++;
          audit(run, { phase: "harvest", id: item.id, status: e.code || "ERROR", detail: e.message });
          if (consecutive >= skill.safety.maxConsecutiveErrors) {
            run.status = "circuit_open";
            saveRun(run);
            audit(run, { phase: "harvest", status: "CIRCUIT_OPEN", detail: `${consecutive} consecutive errors; stopped` });
            return api.runStatus(run.run_id);
          }
        }
        saveRun(run);
        await wait(skill.safety.rateLimitMs);
      }
      run.status = "harvested";
      saveRun(run);
      audit(run, { phase: "harvest", status: "DONE", detail: `${Object.keys(run.harvest).length} items` });
      return api.runStatus(run.run_id);
    },

    getHarvest(runId) {
      const run = loadRun(runId);
      return { run_id: run.run_id, skill: run.skill, status: run.status, items: Object.values(run.harvest) };
    },

    // verdicts: { "<id>": { verdict: "APPROVE", reason: "...", ...extra vars } }
    submitVerdicts(runId, verdicts) {
      const run = loadRun(runId);
      const skill = loadSkill(run.skill);
      if (!verdicts || typeof verdicts !== "object" || Array.isArray(verdicts)) throw new Error("verdicts must be an object keyed by item id");
      const known = new Set(run.ids.map((i) => i.id));
      const errors = [];
      for (const [id, v] of Object.entries(verdicts)) {
        if (!known.has(String(id))) errors.push(`${id}: not part of run ${runId}`);
        else if (!v || typeof v.verdict !== "string") errors.push(`${id}: missing "verdict"`);
        else if (!(v.verdict in skill.actionOrder)) errors.push(`${id}: verdict "${v.verdict}" is not one of ${Object.keys(skill.actionOrder).join(", ")}`);
        else if (!run.harvest[id]) errors.push(`${id}: item was not harvested; harvest and review it before deciding`);
        else if (run.harvest[id]._error) errors.push(`${id}: harvest failed for this item, re-harvest before deciding`);
      }
      if (errors.length) throw new Error("verdicts rejected:\n  - " + errors.join("\n  - "));
      run.verdicts = verdicts;
      run.verdictsHash = sha(stableStringify(verdicts));
      run.status = "verdicts_submitted";
      saveRun(run);
      audit(run, { phase: "verdicts", status: "OK", detail: `${Object.keys(verdicts).length} verdicts, hash ${run.verdictsHash.slice(0, 12)}` });
      return { run_id: runId, count: Object.keys(verdicts).length, verdicts_hash: run.verdictsHash, next: "act with dry_run=true, review the plan, then act with dry_run=false" };
    },

    // Issues a one-time approval for a live act. Call it only after the user
    // has seen the dry-run plan (plan_summary below) and said yes. The token
    // is bound to this run, this exact verdict set and that dry-run plan,
    // expires, and is consumed by the next live act.
    approveLive(runId, { ttlMs = APPROVAL_TTL_MS } = {}) {
      const run = loadRun(runId);
      loadSkill(run.skill);
      if (!run.verdicts) throw new Error("no verdicts submitted for this run");
      const d = run.lastDryRun;
      if (!d || d.verdictsHash !== run.verdictsHash) throw new Error("approve_live refused: run a dry run of the current verdicts first");
      const token = crypto.randomBytes(18).toString("hex");
      const expires = Date.now() + ttlMs;
      run.approvals = (run.approvals || []).filter((a) => !a.used && a.expires > Date.now());
      run.approvals.push({ tokenHash: sha(token), verdictsHash: d.verdictsHash, planHash: d.planHash, expires, used: false });
      saveRun(run);
      audit(run, { phase: "approve", status: "OK", detail: `live approval issued, plan ${d.planHash.slice(0, 12)}, expires ${new Date(expires).toISOString()}` });
      return { run_id: runId, approval: token, expires_at: new Date(expires).toISOString(), plan_summary: d.summary,
        note: "Single use. Pass to act with dry_run=false. Only request this after the user has seen and approved the dry-run plan." };
    },

    async act(runId, { dryRun = true, limit, approval } = {}) {
      if (dryRun === false) {
        const skillId = loadRun(runId).skill;
        loadSkill(skillId);
        // One live act per skill at a time, across processes: the processed
        // index and the rollout counter are read and written under this lock.
        return withSkillLock(skillId, () => doAct(runId, { live: true, limit, approval }));
      }
      return doAct(runId, { live: false, limit });
    },

    async verify(runId) {
      const run = loadRun(runId);
      const skill = loadSkill(run.skill);
      const out = [];
      for (const [id, r] of Object.entries(run.results)) {
        const item = run.ids.find((i) => i.id === id);
        const ver = await verifyOne(skill, item, r.verdict);
        r.verified = ver.verified;
        out.push({ id, verdict: r.verdict, ...ver });
        audit(run, { phase: "verify", id, status: ver.verified === false ? "VERIFY_FAILED" : "OK", detail: `verified=${ver.verified === null ? "n/a" : ver.verified ? "yes" : "no"} ${ver.detail || ""}` });
        await wait(skill.safety.rateLimitMs);
      }
      saveRun(run);
      return { run_id: runId, checked: out.length, failed: out.filter((o) => o.verified === false).length, items: out };
    },

    runStatus(runId) {
      const run = loadRun(runId);
      const harvested = Object.values(run.harvest);
      const counts = {};
      for (const v of Object.values(run.verdicts || {})) counts[v.verdict] = (counts[v.verdict] || 0) + 1;
      return { run_id: run.run_id, skill: run.skill, status: run.status, created: run.created, ids: run.ids.length,
        harvested_ok: harvested.filter((h) => !h._error).length, harvest_errors: harvested.filter((h) => h._error).length,
        verdicts: counts, dry_run_done_for_current_verdicts: !!run.verdictsHash && run.dryRuns.includes(run.verdictsHash),
        acted_live: Object.keys(run.results).length };
    },

    readAuditLog({ runId, skill, tail = 50 } = {}) {
      const sk = skill || (runId ? loadRun(runId).skill : null);
      if (!sk) throw new Error("give run_id or skill");
      const f = path.join(LOGS, `${sk}.audit.jsonl`);
      if (!fs.existsSync(f)) return [];
      let rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (runId) rows = rows.filter((r) => r.run_id === runId);
      return rows.slice(-Math.max(1, Math.min(tail, 1000)));
    },

    rolloutState(skillId) {
      const skill = loadSkill(skillId);
      const r = readJson(jsonFile(skillId, "rollout"), { cleanLiveBatches: 0 });
      const stage = skill.safety.stagedRollout[r.cleanLiveBatches];
      return { ...r, nextLiveCap: Math.min(stage === undefined ? skill.safety.maxBatch : stage, skill.safety.maxBatch) };
    },

    async close() { await transport.close(); },
  };

  async function verifyOne(skill, item, verdict) {
    const rule = (skill.verify || {})[verdict];
    if (!rule) return { verified: null, detail: "no verify rule for this verdict" };
    try {
      const vars = { ...item };
      const url = S.resolveUrl(skill, rule.urlTemplate || skill.read.urlTemplate, vars);
      const res = await send(skill, { url, method: "GET" });
      if (rule.expectStatus) return { verified: res.status === rule.expectStatus, detail: `HTTP ${res.status}` };
      const got = S.extractFields(res.body, skill)[rule.extract];
      return { verified: String(got) === String(rule.equals), detail: `${rule.extract}=${got}` };
    } catch (e) {
      return { verified: false, detail: e.message };
    }
  }

  return api;
}

module.exports = { createEngine, ROOT, stableStringify, ...require("./transports") };
