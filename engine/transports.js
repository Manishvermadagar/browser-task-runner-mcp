// Page-fetch transports. The engine only ever calls
//
//   transport.request({ url, method, headers, body, allowRedirect })
//     -> { ok, status, url, body, redirectBlocked?, location? }
//
// Redirects are never followed blindly. `allowRedirect(url)` is supplied by
// the engine and returns true only for destinations on the skill's own
// origin that are also in the host allow-list. The node transport sees the
// Location header, checks it, and follows (GET) only if allowed. The cdp and
// bridge transports run fetch() inside the browser with redirect: "manual";
// a browser hides the destination of a manual redirect, so every redirect
// there is reported as redirectBlocked and is not followed.
//
// and does not care how the request reaches the site. Three implementations:
//
//   node    - Node's own fetch. No browser, no cookies. Used by the tests
//             and for sites that need no login (such as the demo app).
//   cdp     - attaches to a Chromium-based browser over the Chrome DevTools
//             Protocol (puppeteer-core) and runs fetch() inside a tab on the
//             skill's origin, so the user's existing logged-in session is
//             used. The connection options follow chrome-devtools-mcp's
//             approach; see NOTICE.md.
//   bridge  - hands the request to the browser extension through the local
//             bridge server. The extension runs the fetch with the browser's
//             session.

const http = require("http");

const MAX_REDIRECTS = 5;

function makeNodeTransport() {
  return {
    name: "node",
    async request(req) {
      let url = req.url, method = req.method || "GET", body = req.body, headers = req.headers || {};
      for (let hop = 0; ; hop++) {
        const r = await fetch(url, { method, headers, body, redirect: "manual" });
        if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
          const next = new URL(r.headers.get("location"), url).toString();
          await r.arrayBuffer().catch(() => {});
          if (hop >= MAX_REDIRECTS || !req.allowRedirect || !req.allowRedirect(next)) {
            return { ok: false, status: r.status, url, body: "", redirectBlocked: true, location: next };
          }
          url = next;
          if (r.status !== 307 && r.status !== 308) { method = "GET"; body = undefined; headers = {}; }
          continue;
        }
        return { ok: r.ok, status: r.status, url, body: await r.text() };
      }
    },
    async close() {},
  };
}

// Runs inside the page (CDP) - kept as a standalone function so it is
// serialised, not closed over.
async function pageFetch(r) {
  const res = await fetch(r.url, { method: r.method || "GET", headers: r.headers || {}, body: r.body, credentials: "include", redirect: "manual" });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    return { ok: false, status: res.status, url: r.url, body: "", redirectBlocked: true, location: null };
  }
  return { ok: res.ok, status: res.status, url: res.url, body: await res.text() };
}

// ---- CDP ---------------------------------------------------------------

// opts: { browserUrl } | { wsEndpoint } | { userDataDir } (attach to a running
// browser that was started with remote debugging) or { launch: true,
// executablePath, userDataDir, headless } to start one. See engine/cdp.js.
function makeCdpTransport(opts = {}) {
  const { connectBrowser } = require("./cdp");
  const conn = opts.connection || connectBrowser(opts);
  const pages = new Map(); // origin -> page

  // One tab per origin, reused for every request. Prefers a tab the user
  // already has open on that origin; otherwise opens one in the background.
  async function pageFor(origin) {
    const b = await conn.get();
    const cached = pages.get(origin);
    if (cached && !cached.isClosed()) return cached;
    let page = (await b.pages()).find((p) => { try { return new URL(p.url()).origin === origin; } catch { return false; } });
    if (!page) {
      page = await b.newPage();
      await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    pages.set(origin, page);
    return page;
  }

  return {
    name: "cdp",
    connection: conn,
    async request(req) {
      const page = await pageFor(new URL(req.url).origin);
      const { allowRedirect, ...plain } = req; // functions cannot cross into the page
      return page.evaluate(pageFetch, plain);
    },
    async close() { pages.clear(); await conn.close(); },
  };
}

// ---- bridge (extension front end) ----------------------------------------

function httpJson(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { "X-BTR-Token": token || "" };
    if (data) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers },
      (s) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => resolve({ status: s.statusCode, text: d })); });
    r.on("error", reject);
    r.end(data);
  });
}

// The bridge requires the per-install token (see bridge/token.js) on every
// request. Write requests are marked write: true; the extension refuses a
// non-GET request that is not marked.
function makeBridgeTransport({ port = Number(process.env.BTR_PORT || 8777), timeoutMs = 60000, token, dataDir } = {}) {
  const tok = token || require("../bridge/token").readToken(dataDir);
  return {
    name: "bridge",
    async request(req) {
      const method = (req.method || "GET").toUpperCase();
      const sub = await httpJson(port, "POST", "/job", { type: "fetch", url: req.url, method, headers: req.headers, body: req.body, write: method !== "GET" }, tok);
      if (sub.status !== 200) throw new Error(`bridge refused the job: HTTP ${sub.status} ${sub.text}`);
      const { id } = JSON.parse(sub.text);
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const r = await httpJson(port, "GET", "/exchange/results/" + encodeURIComponent(id) + ".json?consume=1", undefined, tok);
        if (r.status === 200) {
          const res = JSON.parse(r.text);
          if (res.error) throw new Error("extension: " + res.error);
          return { ok: res.ok, status: res.status, url: res.url || req.url, body: res.body, redirectBlocked: !!res.redirectBlocked, location: null };
        }
        await new Promise((ok) => setTimeout(ok, 300));
      }
      throw new Error("no result from the extension within " + timeoutMs / 1000 + "s; is the extension loaded and the bridge running?");
    },
    async close() {},
  };
}

function transportFromEnv(env = process.env) {
  const kind = env.BTR_TRANSPORT || (env.BTR_BROWSER_URL || env.BTR_WS_ENDPOINT || env.BTR_USER_DATA_DIR || env.BTR_CHROME_PATH ? "cdp" : "node");
  if (kind === "node") return makeNodeTransport();
  if (kind === "bridge") return makeBridgeTransport();
  if (kind === "cdp") return makeCdpTransport(cdpOptionsFromEnv(env));
  throw new Error(`unknown BTR_TRANSPORT "${kind}" (node | cdp | bridge)`);
}

function cdpOptionsFromEnv(env = process.env) {
  return {
    browserUrl: env.BTR_BROWSER_URL, wsEndpoint: env.BTR_WS_ENDPOINT, userDataDir: env.BTR_USER_DATA_DIR,
    launch: !!env.BTR_CHROME_PATH && !env.BTR_BROWSER_URL && !env.BTR_WS_ENDPOINT,
    executablePath: env.BTR_CHROME_PATH, headless: env.BTR_HEADLESS === "1",
  };
}

module.exports = { makeNodeTransport, makeCdpTransport, makeBridgeTransport, transportFromEnv, cdpOptionsFromEnv };
