#!/usr/bin/env node
// Send one job to the browser through the bridge and print the result.
//
//   node bridge/job.js fetch https://admin.example.com/status
//   node bridge/job.js nav   https://admin.example.com/
//   node bridge/job.js file  path/to/job.json
//
// Uses the per-install token (bridge/token.js). The bridge and the extension
// both refuse unknown job types and hosts outside the allow-list.

const http = require("http");
const fs = require("fs");
const { readToken } = require("./token");

const PORT = Number(process.env.BTR_PORT || 8777);

function call(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { "X-BTR-Token": token };
    if (data) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, text: d })); });
    req.on("error", reject);
    req.end(data);
  });
}

async function main() {
  const [mode, a] = process.argv.slice(2);
  let job;
  if (mode === "fetch") job = { type: "fetch", url: a };
  else if (mode === "nav") job = { type: "navigate", url: a };
  else if (mode === "file") job = JSON.parse(fs.readFileSync(a, "utf8"));
  else { console.error("usage: job.js fetch <url> | nav <url> | file <path.json>"); process.exit(2); }

  const token = readToken();
  const sub = await call("POST", "/job", job, token);
  if (sub.status !== 200) { console.error("refused:", sub.text); process.exit(1); }
  const { id } = JSON.parse(sub.text);
  process.stderr.write(`submitted ${id}, waiting...\n`);
  for (let i = 0; i < 120; i++) {
    const r = await call("GET", "/exchange/results/" + encodeURIComponent(id) + ".json", undefined, token);
    if (r.status === 200) { console.log(r.text); return; }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  console.error("timed out after 60s; is the extension loaded and paired?");
  process.exit(1);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
