// Per-install bridge token. Generated on the bridge's first run and stored in
// <data dir>/.btr-token (gitignored, file mode 600). Every bridge endpoint
// except /health requires it in the X-BTR-Token header, so a web page open
// in the browser cannot post jobs to 127.0.0.1 or read results.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const tokenPath = (dataDir) => path.join(dataDir || process.env.BTR_DATA_DIR || ROOT, ".btr-token");

function ensureToken(dataDir) {
  const f = tokenPath(dataDir);
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(f, t + "\n", { mode: 0o600, flag: "wx" });
  return t;
}

function readToken(dataDir) {
  const f = tokenPath(dataDir);
  if (!fs.existsSync(f)) throw new Error(`no bridge token at ${f}; start the bridge once (npm run bridge) to create it`);
  return fs.readFileSync(f, "utf8").trim();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { ensureToken, readToken, tokenPath, safeEqual };
