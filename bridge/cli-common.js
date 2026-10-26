// Shared setup for the bridge command-line tools. They use the same engine as
// the MCP server. Default transport is the browser extension (via this
// bridge); set BTR_TRANSPORT=cdp with BTR_BROWSER_URL, or BTR_TRANSPORT=node,
// to use another.

const http = require("http");
const { createEngine, makeBridgeTransport, transportFromEnv } = require("../engine");

const PORT = Number(process.env.BTR_PORT || 8777);

let TOKEN = null;
try { TOKEN = require("./token").readToken(); } catch { /* no bridge set up: dashboard logging is skipped */ }

function postLog(entry) {
  if (!TOKEN) return;
  const data = JSON.stringify({ phase: entry.phase, id: entry.id, status: entry.status, verdict: entry.verdict, detail: entry.detail });
  const r = http.request({ host: "127.0.0.1", port: PORT, path: "/log", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "X-BTR-Token": TOKEN } });
  r.on("error", () => {}); // dashboard is optional
  r.end(data);
}

function engineForCli() {
  const transport = process.env.BTR_TRANSPORT ? transportFromEnv() : makeBridgeTransport({ port: PORT });
  return createEngine({ transport, onEvent: postLog });
}

const flag = (name) => process.argv.includes("--" + name);
const opt = (name) => { const f = process.argv.find((a) => a.startsWith("--" + name + "=")); return f ? f.slice(name.length + 3) : undefined; };
const positional = () => process.argv.slice(2).filter((a) => !a.startsWith("--"));

async function runCli(fn) {
  let engine;
  try { engine = engineForCli(); console.log(JSON.stringify(await fn(engine), null, 2)); }
  catch (e) { console.error("ERROR: " + e.message); process.exitCode = 1; }
  finally { if (engine) await engine.close(); }
}

module.exports = { runCli, flag, opt, positional };
