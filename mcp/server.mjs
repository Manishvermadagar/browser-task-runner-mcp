#!/usr/bin/env node
// MCP server (stdio). Exposes two tool groups to any MCP client:
//
//   Batch skills:    list_skills, describe_skill, list_queue, harvest,
//                    get_harvest, submit_verdicts, act, approve_live, run_status,
//                    read_audit_log, verify
//   Browser control: list_pages, new_page, select_page, close_page, navigate,
//                    snapshot, screenshot, find, click, fill, type_text,
//                    press_key, select_option, hover, wait_for, extract,
//                    get_text, get_attribute, query_all, upload_file,
//                    get_network, get_console, run_plan, and evaluate only
//                    when BTR_ALLOW_EVALUATE=1
//
// Configuration (environment variables):
//   BTR_BROWSER_URL    attach to a running browser, e.g. http://127.0.0.1:9222
//   BTR_WS_ENDPOINT    or attach by WebSocket endpoint
//   BTR_USER_DATA_DIR  or attach through a profile's DevToolsActivePort file
//   BTR_CHROME_PATH    or launch this browser executable (BTR_HEADLESS=1 for headless)
//   BTR_TRANSPORT      batch transport: cdp (default when a browser is set), node, bridge
//   BTR_ALLOW_HOSTS    extra hosts the tools may touch, comma separated (localhost is always allowed)
//   BTR_DATA_DIR       where runs and logs are written (default: the package folder)
//   BTR_SKILLS_ROOT    folder containing src/skills/ to load skills from (default: this package)
//   BTR_ALLOW_EVALUATE set to 1 to offer the evaluate tool (every call still needs confirm=true)

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { createEngine, makeNodeTransport, makeCdpTransport, makeBridgeTransport, cdpOptionsFromEnv } = require("../engine/index.js");
const { connectBrowser } = require("../engine/cdp.js");
const { createBrowserController, parseAllowHosts } = require("../engine/browser.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;

export function buildServer({ engine, browser, allowHosts }) {
  const server = new McpServer({ name: "browser-task-runner", version: "0.3.0" });
  const ok = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
  const fail = (e) => ({ isError: true, content: [{ type: "text", text: String((e && e.message) || e) }] });
  const wrap = (fn) => async (args) => { try { return ok(await fn(args || {})); } catch (e) { return fail(e); } };
  const tool = (name, description, shape, fn) => server.registerTool(name, { description, inputSchema: shape }, wrap(fn));

  // ---------------------------------------------------------- batch skills
  tool("list_skills", "List the batch skills installed (one per admin task) with their target site and allowed verdicts.", {},
    () => engine.listSkills());
  tool("describe_skill", "Show a skill's full config, its ruleset (the rules for deciding verdicts) and notes. Read the ruleset before writing verdicts.",
    { skill: z.string().describe("skill id") }, ({ skill }) => engine.describeSkill(skill));
  tool("list_queue", "Read-only. Fetch the list of item ids waiting in the skill's queue, if the skill defines a list endpoint.",
    { skill: z.string() }, ({ skill }) => engine.listQueue(skill));
  tool("harvest", "Read-only. Fetch each item and extract the skill's fields. Starts a run and returns its run_id. Nothing on the site changes.",
    { skill: z.string(), ids: z.array(z.union([z.string(), z.number()])).min(1).describe("item ids to read"), limit: z.number().int().positive().optional() },
    ({ skill, ids, limit }) => engine.harvest(skill, ids, { limit }));
  tool("get_harvest", "Return the harvested items of a run, for review.", { run_id: z.string() }, ({ run_id }) => engine.getHarvest(run_id));
  tool("submit_verdicts", "Attach verdicts to a run. Each verdict must be one the skill's actionOrder defines. Extra keys become template variables. Replaces earlier verdicts and requires a new dry run.",
    { run_id: z.string(), verdicts: z.record(z.string(), z.object({ verdict: z.string(), reason: z.string().optional() }).passthrough()).describe('{"<id>": {"verdict": "APPROVE", "reason": "..."}}') },
    ({ run_id, verdicts }) => engine.submitVerdicts(run_id, verdicts));
  tool("act", "Apply the verdicts. dry_run defaults to true and only reports the exact requests that would be sent. A live run (dry_run=false) needs an approval token from approve_live, and is capped by the skill's staged rollout and batch size. Live runs for one skill are serialised.",
    { run_id: z.string(), dry_run: z.boolean().default(true), limit: z.number().int().positive().optional(), approval: z.string().optional().describe("token from approve_live; required when dry_run=false") },
    ({ run_id, dry_run, limit, approval }) => engine.act(run_id, { dryRun: dry_run !== false, limit, approval }));
  tool("approve_live", "Issue a single-use approval for a live act, bound to this run, its current verdicts and the last dry-run plan; expires in 15 minutes. Call this ONLY after showing the user the dry-run plan and receiving their explicit yes.",
    { run_id: z.string() }, ({ run_id }) => engine.approveLive(run_id));
  tool("run_status", "Summary of a run: harvest counts, verdict counts, whether a dry run is done, items acted on.", { run_id: z.string() },
    ({ run_id }) => engine.runStatus(run_id));
  tool("read_audit_log", "Read the append-only audit log for a run or a whole skill.",
    { run_id: z.string().optional(), skill: z.string().optional(), tail: z.number().int().positive().max(1000).default(50) },
    ({ run_id, skill, tail }) => engine.readAuditLog({ runId: run_id, skill, tail }));
  tool("verify", "Re-read every item acted on in a run and check the site shows the expected result.", { run_id: z.string() },
    ({ run_id }) => engine.verify(run_id));

  // ------------------------------------------------------- browser control
  if (browser) {
    const target = { uid: z.string().optional().describe("element uid from snapshot"), selector: z.string().optional().describe("CSS selector"), text: z.string().optional().describe("visible text or label"), role: z.enum(["button", "link", "textbox"]).optional() };
    const confirm = z.boolean().optional().describe("Set true only after the user has approved this exact irreversible action.");
    const b = (name) => (args) => browser[name](args);
    tool("list_pages", "List open tabs with ids.", {}, b("list_pages"));
    tool("new_page", "Open a new tab, optionally at a URL (host must be allowed).", { url: z.string().optional() }, b("new_page"));
    tool("select_page", "Make a tab the current one.", { id: z.number().int() }, b("select_page"));
    tool("close_page", "Close a tab.", { id: z.number().int() }, b("close_page"));
    tool("navigate", "Go to a URL in the current tab, or back / forward / reload.", { url: z.string().optional(), action: z.enum(["goto", "back", "forward", "reload"]).optional() }, b("navigate"));
    tool("snapshot", "Text outline of the current page: headings, text, links, buttons and form fields, each interactive element with a uid. Prefer this over screenshots.", { max_lines: z.number().int().positive().optional() }, b("snapshot"));
    server.registerTool("screenshot", { description: "PNG screenshot of the current tab.", inputSchema: { full_page: z.boolean().optional() } }, async (a) => {
      const r = await browser.screenshot(a || {});
      return r.image_base64 ? { content: [{ type: "image", data: r.image_base64, mimeType: "image/png" }] } : ok(r);
    });
    tool("find", "Find an element by visible text or label and return its uid.", { text: z.string(), role: target.role }, b("find"));
    tool("click", "Click an element. Clicks that submit a form or look irreversible (submit, send, pay, buy, delete, publish, confirm, place order...) return needs_confirmation unless confirm=true.", { ...target, confirm }, b("click"));
    tool("fill", "Clear a text field and type a value. Refuses password, payment-card and ID fields.", { ...target, value: z.string() }, b("fill"));
    tool("type_text", "Type into the focused element. Refuses password, payment-card and ID fields.", { text: z.string() }, b("type_text"));
    tool("press_key", "Press a key, e.g. Enter, Tab, ArrowDown, Control+A. Enter inside a form needs confirm=true.", { key: z.string(), confirm }, b("press_key"));
    tool("select_option", "Choose an option in a select by value or visible text.", { ...target, value: z.string() }, b("select_option"));
    tool("hover", "Hover over an element.", target, b("hover"));
    tool("wait_for", "Wait until text appears on the page or a selector matches.", { text: z.string().optional(), selector: z.string().optional(), timeout: z.number().int().positive().optional().describe("ms") }, b("wait_for"));
    tool("extract", "Read structured data: for each element matching selector (or uid), return its text, or the named fields {name: 'css' | 'css@attr'}.", { selector: z.string().optional(), uid: z.string().optional(), fields: z.record(z.string(), z.string()).optional(), limit: z.number().int().positive().optional() }, b("extract"));
    tool("get_text", "Visible text of an element (or the whole page if no target). Read-only; sensitive fields are not read.", target, b("get_text"));
    tool("get_attribute", "One attribute of an element. Read-only.", { ...target, name: z.string() }, b("get_attribute"));
    tool("query_all", "All elements matching a CSS selector: uid, tag, text and the listed attributes. Read-only.", { selector: z.string(), limit: z.number().int().positive().optional(), attributes: z.array(z.string()).optional() }, b("query_all"));
    if (browser.evaluateEnabled) {
      tool("evaluate", "Run JavaScript in the page and return the result (use `return`). Enabled by BTR_ALLOW_EVALUATE=1. Every call returns needs_confirmation first: show the user the script and pass confirm=true only after they approve.", { js: z.string(), confirm }, b("evaluate"));
    }
    tool("upload_file", "Attach a local file to a file input.", { uid: z.string().optional(), selector: z.string().optional(), path: z.string() }, b("upload_file"));
    tool("get_network", "Recent network requests of the current tab.", { filter: z.string().optional(), limit: z.number().int().positive().optional() }, b("get_network"));
    tool("get_console", "Recent console messages and page errors of the current tab.", { limit: z.number().int().positive().optional() }, b("get_console"));
    tool("run_plan", "Run several browser steps in one call, e.g. navigate -> wait_for -> fill -> click -> extract. Each step is {tool, args}; an arg may be {\"use\": \"step2.uid\"} to reuse an earlier result. Stops at the first error (stop_on_error) and always stops at a step that needs confirmation. Returns every step's result and a short snapshot of the final page.",
      { steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() })).min(1).max(50), stop_on_error: z.boolean().default(true), snapshot_lines: z.number().int().positive().max(400).optional() },
      b("run_plan"));
  }
  return server;
}

async function main() {
  const allowHosts = parseAllowHosts(env.BTR_ALLOW_HOSTS);
  const cdpOpts = cdpOptionsFromEnv(env);
  const haveBrowser = !!(cdpOpts.browserUrl || cdpOpts.wsEndpoint || cdpOpts.userDataDir || cdpOpts.launch);
  const connection = haveBrowser ? connectBrowser(cdpOpts) : null;
  const kind = env.BTR_TRANSPORT || (haveBrowser ? "cdp" : "node");
  const transport = kind === "cdp" ? makeCdpTransport({ connection }) : kind === "bridge" ? makeBridgeTransport() : makeNodeTransport();
  const dataDir = env.BTR_DATA_DIR || ROOT;
  // BTR_SKILLS_ROOT: a folder containing src/skills/ to use instead of the bundled one.
  const engine = createEngine({ root: env.BTR_SKILLS_ROOT || ROOT, dataDir, transport, allowHosts });
  const browser = connection ? createBrowserController({ connection, allowHosts, logDir: path.join(dataDir, "logs") }) : null;
  const server = buildServer({ engine, browser, allowHosts });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`browser-task-runner MCP ready (batch transport: ${kind}; browser tools: ${browser ? "on" : "off, set BTR_BROWSER_URL or BTR_CHROME_PATH"}; allowed hosts: ${allowHosts.join(", ")})\n`);
  const shutdown = async () => { try { await engine.close(); } catch {} process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run when executed directly or through the npx/bin symlink, not when imported by the tests.
const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) main();
