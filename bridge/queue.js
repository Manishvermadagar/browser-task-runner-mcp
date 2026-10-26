#!/usr/bin/env node
// Read-only: list the ids waiting in a skill's queue.
//   node bridge/queue.js <skill> [--out=exchange/<skill>/ids_to_harvest.json]
const fs = require("fs");
const path = require("path");
const { runCli, opt, positional } = require("./cli-common");
const [skill] = positional();
if (!skill) { console.error("usage: queue.js <skill> [--out=file.json]"); process.exit(2); }
runCli(async (engine) => {
  const ids = (await engine.listQueue(skill)).map((r) => r.id);
  const out = opt("out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(ids, null, 2)); }
  return { skill, count: ids.length, ids, written: out || null };
});
