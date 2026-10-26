// Browser Task Runner - background service worker.
//
// The extension is one of two front ends for the shared engine (the other is
// the MCP server, which drives the browser over the Chrome DevTools
// Protocol). It holds no task logic at all: it long-polls the local bridge
// server for jobs, runs each one in this browser, and posts the result back.
// Skill loading, templating, rate limiting, the circuit breaker, the audit log
// and verification all live in engine/ and run in Node.
//
// Requests made here use fetch() with credentials: "include", so the browser
// attaches its own session cookie for hosts listed in manifest.json
// host_permissions. This code never reads or stores a cookie.
//
// MV3 service workers are stopped after about 30 s idle and a pending
// setInterval silently stops with them. chrome.alarms is the mechanism Chrome
// guarantees will wake the worker, so all polling hangs off one alarm.
// (Sub-minute alarm periods are honoured for unpacked extensions.)

const BRIDGE_ORIGIN = "http://127.0.0.1:8777"; // keep in step with BTR_PORT and manifest.json
const POLL_ALARM_NAME = "browser-task-runner-poll";
const POLL_PERIOD_MINUTES = 0.5;

chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES });
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES }));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) jobPump();
});

const LOG_KEY = "runLog";
async function appendLog(entry) {
  const { [LOG_KEY]: log } = await chrome.storage.local.get(LOG_KEY);
  const next = (log || []).concat({ timestamp: new Date().toISOString(), ...entry }).slice(-500);
  await chrome.storage.local.set({ [LOG_KEY]: next });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "GET_LOG") {
      const { [LOG_KEY]: log } = await chrome.storage.local.get(LOG_KEY);
      sendResponse({ ok: true, log: log || [] });
    } else sendResponse({ ok: false, error: "unknown message type" });
  })();
  return true;
});

// ======================================================================
// JOB RUNNER
// ======================================================================
//
// Pairing: the bridge requires its per-install token on every request. The
// user pastes it into the popup once; it is kept in chrome.storage.local.
//
// Job types (anything else is refused):
//   {"type":"fetch","url":"https://x/api","method":"POST","body":"...","write":true}
//   {"type":"navigate","url":"https://x/"}
//   {"type":"closeTab","tabId":123}
//
// Checks made here, independently of the bridge, before any job runs:
//   - the URL is http(s) on an allowed host: localhost, plus hosts the user
//     added in the popup (and the extension also needs host permission);
//   - a non-GET fetch must be marked write: true by the engine, which only
//     does so during an approved live act;
//   - redirects are not followed (redirect: "manual"); a redirect is
//     reported back as redirectBlocked.
// There is no job type that runs arbitrary JavaScript in a page.

const JOB_POLL_WAIT_S = 25;
const DEFAULT_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
let jobLoopRunning = false;

async function settings() {
  const { bridgeToken, allowHosts } = await chrome.storage.local.get(["bridgeToken", "allowHosts"]);
  return { token: bridgeToken || "", hosts: [...DEFAULT_HOSTS, ...((allowHosts || []).map((h) => String(h).toLowerCase()))] };
}

function hostAllowed(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!["http:", "https:"].includes(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  return hosts.some((a) => h === a || (a.startsWith("*.") && (h.endsWith(a.slice(1)) || h === a.slice(2))));
}

function bridgeFetch(path, token, init = {}) {
  return fetch(BRIDGE_ORIGIN + path, { ...init, cache: "no-store", headers: { ...(init.headers || {}), "X-BTR-Token": token } });
}

function waitForComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(done); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, timeoutMs);
  });
}

async function runJob(job, hosts) {
  if (job.type === "closeTab") {
    await chrome.tabs.remove(job.tabId);
    return { ok: true };
  }
  if (!["fetch", "navigate"].includes(job.type)) return { ok: false, error: `job type "${job.type}" is not allowed` };
  if (!hostAllowed(job.url, hosts)) return { ok: false, error: `host not allowed: ${job.url}` };
  if (job.type === "navigate") {
    const tab = await chrome.tabs.create({ url: job.url, active: false });
    await waitForComplete(tab.id);
    return { ok: true, tabId: tab.id };
  }
  const method = String(job.method || "GET").toUpperCase();
  if (method !== "GET" && job.write !== true) return { ok: false, error: "a non-GET request must be marked write: true by the engine" };
  const r = await fetch(job.url, { method, headers: job.headers || {}, body: job.body, credentials: "include", redirect: "manual" });
  if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) {
    return { ok: false, status: r.status, url: job.url, body: "", redirectBlocked: true };
  }
  const text = await r.text();
  return { ok: r.ok, status: r.status, url: r.url, body: text.slice(0, 2000000) };
}

async function jobLoop() {
  if (jobLoopRunning) return;
  jobLoopRunning = true;
  try {
    const { token, hosts } = await settings();
    if (!token) return; // not paired yet
    const res = await bridgeFetch(`/jobs/next?wait=${JOB_POLL_WAIT_S}`, token);
    if (!res.ok) return;
    const { job } = await res.json();
    if (!job) return;
    let payload;
    try { payload = await runJob(job, hosts); } catch (e) { payload = { ok: false, error: String((e && e.message) || e) }; }
    await bridgeFetch(`/result/${encodeURIComponent(job.id)}`, token, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job.id, finishedAt: new Date().toISOString(), ...payload }),
    }).catch(() => {});
    await appendLog({ step: "job", result: payload.ok === false ? "error" : "ok", detail: `${job.type} ${job.url || ""} ${payload.error || ""}` });
  } catch (e) {
    // bridge not running - silent, this is a poll loop
  } finally {
    jobLoopRunning = false;
  }
}

// Chain immediately after each job so a queued batch drains fast.
async function jobPump() {
  for (let i = 0; i < 20; i++) {
    const before = Date.now();
    await jobLoop();
    if (Date.now() - before > (JOB_POLL_WAIT_S - 2) * 1000) break;
  }
}
