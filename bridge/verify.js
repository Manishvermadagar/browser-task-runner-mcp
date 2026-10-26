#!/usr/bin/env node
// Re-read every item acted on in a run and check the expected result.
//   node bridge/verify.js <run_id>
const { runCli, positional } = require("./cli-common");
const [runId] = positional();
if (!runId) { console.error("usage: verify.js <run_id>"); process.exit(2); }
runCli((engine) => engine.verify(runId));
