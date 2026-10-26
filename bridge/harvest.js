#!/usr/bin/env node
// Read-only: fetch each item and extract the skill's fields. Starts a run.
//   node bridge/harvest.js <skill> <ids.json> [--limit=N]
// The harvested items are written to exchange/runs/<run_id>/run.json; review
// them, write a verdicts file, then use act.js.
const fs = require("fs");
const { runCli, opt, positional } = require("./cli-common");
const [skill, idsFile] = positional();
if (!skill || !idsFile) { console.error("usage: harvest.js <skill> <ids.json> [--limit=N]"); process.exit(2); }
runCli(async (engine) => {
  const ids = JSON.parse(fs.readFileSync(idsFile, "utf8"));
  const status = await engine.harvest(skill, ids, { limit: Number(opt("limit")) || undefined });
  return { ...status, items: engine.getHarvest(status.run_id).items,
    next: `node bridge/act.js ${status.run_id} --verdicts=<file.json>   (dry run)` };
});
