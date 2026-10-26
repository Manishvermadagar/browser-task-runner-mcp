#!/usr/bin/env node
// Issue a single-use live approval for a run, after you have read its dry-run
// plan. Prints the plan summary again and the token (valid 15 minutes).
//   node bridge/approve.js <run_id>
const { runCli, positional } = require("./cli-common");
const [runId] = positional();
if (!runId) { console.error("usage: approve.js <run_id>"); process.exit(2); }
runCli((engine) => engine.approveLive(runId));
