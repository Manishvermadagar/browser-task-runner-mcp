#!/usr/bin/env node
// Browser Task Runner — local bridge server.
//
// Why this exists: an MV3 service worker CANNOT fetch() a file:// URL.
// "Allow access to file URLs" does not change that (verified live: the
// toggle reads true and fetch still throws "Failed to fetch"). That
// toggle governs content scripts on file:// pages, not SW fetches.
// So the extension cannot read a local exchange folder directly.
//
// This server is the fix: it exposes the exchange folder over
// http://127.0.0.1:<PORT>, which a service worker CAN fetch. a person,
// a script or an AI coding session writes plain files; the extension reads them
// over localhost. No filesystem paths are ever compiled into the
// extension, which is also what makes the same unpacked extension work
// unchanged on Windows and macOS.
//
// Zero dependencies on purpose — `node bridge/server.js` and nothing
// else, on any OS with Node 18+. A coding assistant, a script or a person
// writes plain files; the extension reads them over localhost.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT_REQUESTED = process.env.BTR_PORT === undefined ? 8777 : Number(process.env.BTR_PORT);
let PORT = PORT_REQUESTED; // BTR_PORT=0 picks a free port (used by the tests); set once listening
const { ensureToken, safeEqual, tokenPath } = require("./token");
const { parseAllowHosts, hostAllowed } = require("../engine/browser");

const ROOT = path.resolve(__dirname, "..");
const DATA = process.env.BTR_DATA_DIR || ROOT;
const EXCHANGE = path.join(DATA, "exchange");
const TOKEN = ensureToken(DATA);
const ALLOW = parseAllowHosts(process.env.BTR_ALLOW_HOSTS);
// Optional: pin the one extension allowed to talk to the bridge, e.g.
// BTR_EXTENSION_ORIGIN=chrome-extension://abcdefghijklmnopabcdefghijklmnop
const EXT_ORIGIN = process.env.BTR_EXTENSION_ORIGIN || "";
const JOB_TYPES = ["fetch", "navigate", "closeTab"];

// Jobs are checked here and again in the extension: known type only, and an
// http(s) URL on an allowed host. There is no job type that runs arbitrary
// page JavaScript.
function validateJob(job) {
  if (!job || !JOB_TYPES.includes(job.type)) return `job type must be one of ${JOB_TYPES.join(", ")}`;
  if (job.type === "closeTab") return Number.isInteger(job.tabId) ? null : "closeTab needs an integer tabId";
  if (!hostAllowed(job.url, ALLOW) || !/^https?:/.test(String(job.url))) return `URL not allowed: ${job.url}. Allowed hosts: ${ALLOW.join(", ")} (set BTR_ALLOW_HOSTS)`;
  return null;
}
const OUT = path.join(EXCHANGE, "out");
const JOBS = path.join(EXCHANGE, "jobs");
const RESULTS = path.join(EXCHANGE, "results");

for (const d of [EXCHANGE, OUT, JOBS, RESULTS]) fs.mkdirSync(d, { recursive: true });

// ---- generic job queue ------------------------------------------------
// A job is one browser request, checked by validateJob():
//   {"type":"fetch","url":"https://...","method":"POST","body":"...","write":true}
//   {"type":"navigate","url":"https://..."}
//   {"type":"closeTab","tabId":123}
// Dropped in as a .json file in exchange/jobs/, or POSTed to /job.
// Results land in exchange/results/<jobId>.json.

const waiters = []; // long-poll clients awaiting a job

function scanJobFiles() {
  let found = [];
  for (const f of fs.readdirSync(JOBS)) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(JOBS, f);
    try {
      const job = JSON.parse(fs.readFileSync(full, "utf8"));
      job.id = job.id || f.replace(/\.json$/, "");
      const bad = validateJob(job);
      if (bad) throw new Error(bad);
      fs.renameSync(full, path.join(JOBS, "." + f + ".taken"));
      found.push(job);
    } catch (e) {
      log(`bad job file ${f}: ${e.message}`);
      fs.renameSync(full, path.join(JOBS, "." + f + ".bad"));
    }
  }
  return found;
}

const queue = [];

function pump() {
  queue.push(...scanJobFiles());
  while (queue.length && waiters.length) {
    const job = queue.shift();
    const w = waiters.shift();
    clearTimeout(w.timer);
    json(w.res, 200, { job });
    log(`dispatched job ${job.id} (${job.type})`);
  }
}
setInterval(pump, 500).unref?.();

// ---- helpers ----------------------------------------------------------

function log(msg) {
  console.log(`[btr-bridge ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

// Block path traversal — this server is localhost-only but still
// refuses to serve anything outside exchange/.
function safeJoin(base, rel) {
  while (rel.startsWith("/") || rel.startsWith(String.fromCharCode(92))) rel = rel.slice(1);
  const p = path.resolve(base, rel);
  return p.startsWith(base) ? p : null;
}

// ---- server -----------------------------------------------------------

const ACTIVITY = [];

const DASHBOARD = `<!doctype html><html><head><meta charset="utf-8">
<title>Browser Task Runner - Live</title>
<style>
 :root{--bg:#0f1115;--fg:#e6e8ee;--dim:#8b93a7;--line:#232838;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#58a6ff}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
 header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:baseline;position:sticky;top:0;background:var(--bg);z-index:2}
 h1{font-size:15px;margin:0;font-weight:600}
 .sub{color:var(--dim)}
 .pill{padding:2px 8px;border-radius:10px;border:1px solid var(--line)}
 .counts{display:flex;gap:8px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--line)}
 .c{padding:4px 10px;border:1px solid var(--line);border-radius:6px}
 .c b{color:var(--acc)}
 table{width:100%;border-collapse:collapse}
 th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
 th{color:var(--dim);font-weight:500;position:sticky;top:52px;background:var(--bg)}
 td.d{color:var(--dim)}
 .s-ok{color:var(--ok)} .s-warn{color:var(--warn)} .s-bad{color:var(--bad)} .s-run{color:var(--acc)}
 .now{padding:12px 18px;border-bottom:1px solid var(--line);font-size:14px}
 .now b{color:var(--acc)}
 .snip{max-width:640px;white-space:pre-wrap;color:var(--dim);max-height:80px;overflow:hidden}
</style></head><body>
<header><h1>Browser Task Runner</h1>
 <span class="sub">live activity</span>
 <span class="pill" id="conn">connecting...</span>
 <span class="sub" id="clock"></span>
</header>
<div class="now" id="now">idle</div>
<div class="counts" id="counts"></div>
<table><thead><tr><th>time</th><th>phase</th><th>id</th><th>status</th><th>verdict</th><th>verified</th><th>detail</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
let seen=0;
const TOKEN=(new URLSearchParams(location.hash.slice(1))).get('token')||'';
if(!TOKEN)document.addEventListener('DOMContentLoaded',()=>{document.getElementById('now').textContent='Open this page as http://127.0.0.1:<port>/#token=<your bridge token> (the token is printed when the bridge starts).'});
const el=id=>document.getElementById(id);
const cls=s=>({OK:'s-ok',DONE:'s-ok',DRY_RUN:'s-warn',SKIP:'s-warn',ESCALATE:'s-warn',
 IDENTITY_MISMATCH:'s-bad',STALE:'s-bad',FETCH_FAILED:'s-bad',ERROR:'s-bad',VERIFY_FAILED:'s-bad',
 CIRCUIT_OPEN:'s-bad',RUNNING:'s-run',START:'s-run'}[s]||'');
const counts={};
async function tick(){
 try{
  const r=await fetch('/activity?since='+seen,{headers:{'X-BTR-Token':TOKEN}});
  if(r.status===401)throw new Error('bad token');
  const d=await r.json();
  el('conn').textContent='connected';el('conn').className='pill s-ok';
  for(const e of d.entries){
   seen++;
   if(e.status){counts[e.status]=(counts[e.status]||0)+1}
   const det=(e.detail||'')+'';
   let ver='', vcls='';
   if(/verified=yes/.test(det)){ver='yes';vcls='s-ok'}
   else if(/verified=no/.test(det)){ver='NO';vcls='s-bad'}
   // Every cell is built with textContent: entry data is never parsed as HTML.
   const tr=document.createElement('tr');
   const cell=(text,cl)=>{const td=document.createElement('td');td.textContent=String(text==null?'':text);if(cl)td.className=cl;tr.appendChild(td);};
   cell(String(e.at||'').slice(11,19),'d');
   cell(e.phase);
   cell(e.id);
   cell(e.status,cls(e.status));
   cell(e.verdict);
   cell(ver,vcls);
   cell(det,'snip');
   el('rows').prepend(tr);
   if(e.phase==='harvest'||e.phase==='act') el('now').textContent=(e.phase||'')+' -> item '+(e.id||'?')+'  '+(e.status||'');
  }
  const box=el('counts');
  box.replaceChildren(...Object.entries(counts).sort().map(([k,v])=>{const sp=document.createElement('span');sp.className='c';sp.textContent=k+' ';const b=document.createElement('b');b.textContent=String(v);sp.appendChild(b);return sp;}));
 }catch(err){el('conn').textContent='bridge offline';el('conn').className='pill s-bad'}
 el('clock').textContent=new Date().toLocaleTimeString();
}
setInterval(tick,600);tick();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  // No CORS headers are ever sent, so a web page cannot read any response.
  // Preflights are refused outright.
  if (req.method === "OPTIONS") return json(res, 403, { error: "cross-origin requests are not accepted" });

  if (p === "/health") return json(res, 200, { ok: true, port: PORT, queued: queue.length, auth: "token" });

  // The dashboard page itself holds no data; it reads /activity with the
  // token taken from its own URL fragment.
  if ((p === "/" || p === "/dashboard") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(DASHBOARD);
  }

  // Origin check: a request from a web page carries an Origin header. Only
  // the extension (chrome-extension://...) and the dashboard's own origin
  // are accepted. Command-line clients send no Origin.
  const origin = req.headers.origin;
  if (origin) {
    const own = origin === `http://127.0.0.1:${PORT}`;
    const ext = origin.startsWith("chrome-extension://") && (!EXT_ORIGIN || origin === EXT_ORIGIN);
    if (!own && !ext) return json(res, 403, { error: "origin not allowed" });
  }
  if (!safeEqual(req.headers["x-btr-token"], TOKEN)) return json(res, 401, { error: "missing or wrong X-BTR-Token (see README: pairing)" });

  // GET /exchange/<relative path> — read any file under exchange/
  if (p.startsWith("/exchange/") && req.method === "GET") {
    const f = safeJoin(EXCHANGE, decodeURIComponent(p.slice("/exchange/".length)));
    if (!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return json(res, 404, { error: "not found" });
    const data = fs.readFileSync(f);
    // ?consume=1 deletes a job result once it has been read, so fetched page
    // bodies do not accumulate on disk.
    if (u.searchParams.get("consume") === "1" && f.startsWith(RESULTS + path.sep)) fs.unlinkSync(f);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    return res.end(data);
  }

  // GET /jobs/next?wait=25 — long-poll for the next generic job
  if (p === "/jobs/next" && req.method === "GET") {
    pump();
    if (queue.length) {
      const job = queue.shift();
      log(`dispatched job ${job.id} (${job.type})`);
      return json(res, 200, { job });
    }
    const waitMs = Math.min(Number(u.searchParams.get("wait") || 25), 55) * 1000;
    const w = { res };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      json(res, 200, { job: null });
    }, waitMs);
    waiters.push(w);
    return;
  }

  // POST /job — submit a generic job directly
  if (p === "/job" && req.method === "POST") {
    try {
      const job = JSON.parse(await readBody(req));
      const bad = validateJob(job);
      if (bad) return json(res, 400, { error: bad });
      job.id = job.id || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      queue.push(job);
      pump();
      return json(res, 200, { ok: true, id: job.id });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // POST /result/<name> — extension writes results/harvest output back
  if (p.startsWith("/result/") && req.method === "POST") {
    const name = decodeURIComponent(p.slice("/result/".length)).replace(/[^A-Za-z0-9._-]/g, "_");
    const body = await readBody(req);
    const dest = path.join(RESULTS, name.endsWith(".json") ? name : name + ".json");
    // Atomic write. A reader polling for this file must never observe a
    // partially-written one: harvesting 500 items hit exactly that race and
    // died with "Unexpected end of JSON input" after 344 items. Writing to a
    // temp name and renaming makes the file appear complete or not at all.
    const tmp = dest + ".tmp" + process.pid;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, dest);
    log(`result written: ${path.relative(ROOT, dest)} (${body.length} bytes)`);
    return json(res, 200, { ok: true, path: dest });
  }

  // POST /out/<name> — bulk harvest output, kept separate from results
  if (p.startsWith("/out/") && req.method === "POST") {
    const name = decodeURIComponent(p.slice("/out/".length)).replace(/[^A-Za-z0-9._-]/g, "_");
    const body = await readBody(req);
    const dest = path.join(OUT, name);
    const tmp2 = dest + ".tmp" + process.pid;
    fs.writeFileSync(tmp2, body);
    fs.renameSync(tmp2, dest);
    log(`out written: ${path.relative(ROOT, dest)} (${body.length} bytes)`);
    return json(res, 200, { ok: true, path: dest });
  }

  // ---- activity log + live dashboard --------------------------------
  // Everything the runner does is posted here so a human can watch it
  // happen in real time. Without this the whole pipeline is invisible,
  // which makes a "test run" impossible to actually verify.

  if (p === "/log" && req.method === "POST") {
    const entry = JSON.parse(await readBody(req));
    entry.at = new Date().toISOString();
    ACTIVITY.push(entry);
    if (ACTIVITY.length > 5000) ACTIVITY.shift();
    log(`${entry.phase || "-"} | ${entry.id || "-"} | ${entry.status || ""} ${entry.detail || ""}`);
    return json(res, 200, { ok: true });
  }

  if (p === "/activity" && req.method === "GET") {
    const since = Number(u.searchParams.get("since") || 0);
    return json(res, 200, { total: ACTIVITY.length, entries: ACTIVITY.slice(since) });
  }

  if (p === "/reset-activity" && req.method === "POST") {
    ACTIVITY.length = 0;
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "no route" });
});

// 127.0.0.1 only — never 0.0.0.0. This server sends requests through the
// user's browser session; it must not be reachable from the network.
server.listen(PORT_REQUESTED, "127.0.0.1", () => {
  PORT = server.address().port;
  log(`listening on http://127.0.0.1:${PORT}`);
  log(`exchange root: ${EXCHANGE}`);
  log(`pairing token file: ${tokenPath(DATA)}`);
  log(`paste the token into the extension popup; dashboard: http://127.0.0.1:${PORT}/#token=<token>`);
});
