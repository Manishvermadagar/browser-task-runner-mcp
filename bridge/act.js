#!/usr/bin/env node
// Apply verdicts to a harvested run. DRY RUN IS THE DEFAULT.
//   node bridge/act.js <run_id> --verdicts=verdicts.json        # dry run: shows every request it would send
//   node bridge/approve.js <run_id>                             # after reading the dry-run plan: prints an approval
//   node bridge/act.js <run_id> --live --approval=<token> [--limit=N]
// A live run needs an unexpired, single-use approval bound to this run, its
// verdicts and the dry-run plan, and is capped by the skill's staged rollout.
const fs = require("fs");
const { runCli, flag, opt, positional } = require("./cli-common");
const [runId] = positional();
if (!runId) { console.error("usage: act.js <run_id> [--verdicts=file.json] [--live --approval=TOKEN] [--limit=N]"); process.exit(2); }
const LIVE = flag("live");
runCli(async (engine) => {
  const vf = opt("verdicts");
  if (vf) engine.submitVerdicts(runId, JSON.parse(fs.readFileSync(vf, "utf8")));
  const r = await engine.act(runId, { dryRun: !LIVE, limit: Number(opt("limit")) || undefined, approval: opt("approval") });
  if (!LIVE) r.next = `read the plan above; if it is right: node bridge/approve.js ${runId}, then node bridge/act.js ${runId} --live --approval=<token>`;
  return r;
});
