// Test helpers: temp directories under os.tmpdir() (never in the repo), the
// demo app on a free port, and a copy of the skills pointed at that port.
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function makeTmp(prefix) {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  } catch (e) {
    console.error(`\nCannot create a temporary directory under ${os.tmpdir()} (${e.code || e.message}).`);
    console.error("These tests need a writable temp dir. Set TMPDIR to a writable directory and re-run.\n");
    process.exit(1);
  }
}

// Starts demo/server.js on port 0 (any free port). Returns { port, base, server }.
async function startDemo() {
  const demo = require("../demo/server");
  await new Promise((ok, no) => demo.server.once("error", no).listen(0, "127.0.0.1", ok));
  const port = demo.server.address().port;
  return { port, base: `http://127.0.0.1:${port}`, server: demo.server, reset: demo.reset, stats: demo.stats };
}

// A temp root holding a copy of src/skills with demo-review-queue's baseUrl
// set to the demo's real port, plus optional extra skills derived from it:
// extra = { "<id>": (skill) => { mutate } }.
function skillsRoot(port, extra = {}) {
  const r = makeTmp("btr-root-");
  fs.cpSync(path.join(ROOT, "src"), path.join(r, "src"), { recursive: true });
  const f = path.join(r, "src/skills/demo-review-queue/skill.json");
  const base = JSON.parse(fs.readFileSync(f, "utf8"));
  base.baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(f, JSON.stringify(base));
  const ids = ["demo-review-queue"];
  for (const [id, mutate] of Object.entries(extra)) {
    const s = JSON.parse(JSON.stringify(base));
    s.id = id;
    mutate(s);
    fs.mkdirSync(path.join(r, "src/skills", id));
    fs.writeFileSync(path.join(r, "src/skills", id, "skill.json"), JSON.stringify(s));
    ids.push(id);
  }
  fs.writeFileSync(path.join(r, "src/skills/registry.json"), JSON.stringify(ids));
  return r;
}

module.exports = { makeTmp, startDemo, skillsRoot, ROOT };
