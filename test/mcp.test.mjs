#!/usr/bin/env node
// Starts the MCP server over stdio exactly as an MCP client would, lists its
// tools and drives the demo skill through it: harvest -> submit_verdicts ->
// act(dry run) -> act(live) -> verify. Browser tools are exercised too when a
// Chromium-based browser is available (launched headless by the server).
//
//   node test/mcp.test.mjs

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const { findChromium } = require("../engine/cdp.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const step = (n) => { passed++; console.log("  PASS  " + n); };

const { makeTmp, startDemo, skillsRoot } = require("./tmp.js");
const demo = await startDemo();
const data = makeTmp("btr-mcp-");
const exe = process.env.BTR_CHROME_PATH || findChromium();
const env = { ...process.env, BTR_DATA_DIR: data, BTR_TRANSPORT: "node", BTR_SKILLS_ROOT: skillsRoot(demo.port) };
if (exe) Object.assign(env, { BTR_CHROME_PATH: exe, BTR_HEADLESS: "1", BTR_USER_DATA_DIR: path.join(data, "profile") });

const client = new Client({ name: "btr-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "mcp/server.mjs")], env, stderr: "ignore" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0];
  if (r.isError) throw new Error(t.text);
  return t.type === "text" ? JSON.parse(t.text) : t;
};

try {
  console.log("\n=== MCP server (stdio) ===");
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["list_skills", "describe_skill", "harvest", "get_harvest", "submit_verdicts", "act", "approve_live", "run_status", "read_audit_log", "verify"]) assert.ok(tools.includes(t), t);
  step(`server lists ${tools.length} tools, including all batch tools`);

  const skills = await call("list_skills");
  assert.strictEqual(skills[0].id, "demo-review-queue");
  const d = await call("describe_skill", { skill: "demo-review-queue" });
  assert.ok(d.ruleset.includes("ESCALATE"));
  step("list_skills and describe_skill (with ruleset)");

  const ids = (await call("list_queue", { skill: "demo-review-queue" })).map((r) => r.id);
  const h = await call("harvest", { skill: "demo-review-queue", ids });
  assert.strictEqual(h.harvested_ok, 6);
  assert.strictEqual((await call("get_harvest", { run_id: h.run_id })).items.length, 6);
  step("list_queue -> harvest -> get_harvest");

  const verdicts = JSON.parse(fs.readFileSync(path.join(ROOT, "demo/verdicts.example.json"), "utf8"));
  await assert.rejects(call("submit_verdicts", { run_id: h.run_id, verdicts: { 101: { verdict: "NOPE" } } }), /not one of/);
  await call("submit_verdicts", { run_id: h.run_id, verdicts });
  await assert.rejects(call("act", { run_id: h.run_id, dry_run: false }), /no approval/);
  step("submit_verdicts validates; live act refused without approval");

  const dry = await call("act", { run_id: h.run_id });
  assert.strictEqual(dry.mode, "dry_run");
  await assert.rejects(call("act", { run_id: h.run_id, dry_run: false }), /no approval/);
  const ap = await call("approve_live", { run_id: h.run_id });
  assert.ok(ap.approval && ap.plan_summary);
  const live = await call("act", { run_id: h.run_id, dry_run: false, approval: ap.approval });
  assert.strictEqual(live.cap, 1);
  await assert.rejects(call("act", { run_id: h.run_id, dry_run: false, approval: ap.approval }), /already used/);
  step("act defaults to dry run; live needs approve_live; first batch capped at 1; approval single-use");

  const v = await call("verify", { run_id: h.run_id });
  assert.strictEqual(v.failed, 0);
  const st = await call("run_status", { run_id: h.run_id });
  assert.strictEqual(st.acted_live, 1);
  const log = await call("read_audit_log", { run_id: h.run_id, tail: 5 });
  assert.strictEqual(log.length, 5);
  step("verify, run_status, read_audit_log");

  if (exe) {
    for (const t of ["navigate", "snapshot", "click", "fill", "run_plan", "get_text", "get_attribute", "query_all", "screenshot"]) assert.ok(tools.includes(t), t);
    assert.ok(!tools.includes("evaluate"), "evaluate must not be offered unless BTR_ALLOW_EVALUATE=1");
    const plan = await call("run_plan", { steps: [
      { tool: "navigate", args: { url: demo.base + "/contact" } },
      { tool: "fill", args: { text: "Your name", value: "MCP" } },
      { tool: "click", args: { text: "Send message", role: "button" } },
    ] });
    assert.strictEqual(plan.stop_reason, "needs_confirmation");
    const pw = await call("fill", { text: "Account password", value: "x" });
    assert.ok(pw.refused);
    const shot = await client.callTool({ name: "screenshot", arguments: {} });
    assert.strictEqual(shot.content[0].type, "image");
    step("browser tools over MCP: no evaluate tool by default, run_plan stops for confirmation, password refused, screenshot works");
  } else {
    console.log("  SKIP  browser tools over MCP (no Chromium-based browser found)");
  }
} finally {
  await client.close();
  demo.server.close();
}
console.log(`\nMCP TESTS PASSED (${passed})\n`);
