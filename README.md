# Browser Task Runner

Run repetitive admin work in a web browser, in batches, with a person
reviewing every decision before anything is changed. Or just ask your AI
assistant to do something on a site, and let it line up the steps and
carry them out in one go.

Browser Task Runner is a local tool with two halves that share one engine:

- **Batch skills.** For high-volume, rules-based queues (moderating
  reviews, triaging tickets, approving submissions). Items are read
  without changing anything, a person or an AI session decides a verdict
  for each, and only then are the decisions applied, with a dry run
  first, a staged rollout, a rate limit, a circuit breaker, an
  append-only audit log and a check afterwards that each change landed.
- **General browser control.** Navigate, read, fill and click on any
  allowed site, from any MCP client. A plan of many steps runs in one
  call. Irreversible actions stop and ask for confirmation, and password,
  card and ID fields are never typed into.

Everything runs on your machine, in a browser you are already logged into.
There is no hosted service and no API key.

Copyright (c) 2026 Manish Verma. MIT License.

---

## How it works

```
                        +------------------------------+
  MCP client            |  mcp/server.mjs  (stdio)     |
  (Claude Code,  <----> |  batch tools + browser tools |
   Claude Desktop,      +--------------+---------------+
   others)                             |
                                       v
  bridge/*.js CLI  ---->  +------------------------------+      audit log
                          |  engine/   (shared)          | ---> logs/*.jsonl
                          |  skills, templating, rate    |      runs in
                          |  limit, circuit breaker,     | ---> exchange/runs/
                          |  rollout, verify, safety     |
                          +------+---------------+-------+
                                 |               |
                     CDP (puppeteer-core)    bridge server :8777
                                 |               |  (job queue)
                                 v               v
                   +-----------------------------------------+
                   |  Your Chromium-based browser            |
                   |  (Chrome, Brave, Edge, Chromium)        |
                   |  requests run in a tab on the target    |
                   |  site, with your existing session       |
                   |  - or via the optional extension -      |
                   +-----------------------------------------+
```

The batch flow for one skill:

```
 list_queue ──► harvest ──► (person / AI writes verdicts) ──► submit_verdicts
  read-only     read-only        using the skill's ruleset      validated
                                                                    │
         verify ◄── act(live) ◄── person approves the plan ◄── act(dry run)
      re-reads       capped by         shown every request        default
      each item      staged rollout    it would send
```

Two front ends drive the same engine:

1. **MCP server** (`mcp/server.mjs`). Connects to your browser over the
   Chrome DevTools Protocol, either by attaching to one you started with
   remote debugging or by launching one. Requests run inside a tab on the
   target site, so they carry your logged-in session. This is the main
   way to use it.
2. **Browser extension + bridge** (optional). An unpacked Manifest V3
   extension that long-polls a small local server (`bridge/server.js`,
   port 8777) for jobs and runs them in your browser. Useful if you
   prefer not to start the browser with remote debugging. The bridge also
   serves a live dashboard at http://127.0.0.1:8777/.

---

## Requirements

- Node.js 18 or newer
- A Chromium-based browser: Chrome, Chromium, Brave or Edge

```
git clone <this repo> browser-task-runner
cd browser-task-runner
npm install
npm test          # static checks, engine, browser and MCP tests
```

---

## Quick start: the demo, end to end

The repo includes a tiny local admin app, a fake product-review queue,
so you can try everything safely. Its state lives in memory and resets
when it restarts.

**1. Start the demo app**

```
node demo/server.js            # http://127.0.0.1:8790
```

**2. Start a browser for automation**, with remote debugging on and a
separate profile, so your everyday profile is never exposed:

```
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.btr-chrome-profile"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.btr-chrome-profile"

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.btr-chrome-profile"
```

Log in to any site you want the tool to work on in this window. Anything
that can reach port 9222 can control this browser, so keep it on
127.0.0.1 and close it when you are done.

**3. Add the MCP server to your client** (see the next section).

**4. Ask.** For example:

> Use browser-task-runner. List the pending items in the demo review
> queue, harvest them, read the skill's ruleset, and propose a verdict for
> each. Show me the verdicts, then do a dry run.

Review what it proposes, then:

> Looks right. Approve it and run it live.

Only now does the assistant call `approve_live`, which returns a
single-use approval bound to that exact plan, valid for 15 minutes, and
pass it to `act` with `dry_run: false`. A dry run on its own never
unlocks a live run.

The first live batch is capped at 1 item, the next at 3, then up to the
batch size, so a mistake in a skill or a verdict shows up on one item
rather than a hundred. Then:

> Verify the run and show me the audit log.

Open http://127.0.0.1:8790/ to see the result.

### The same flow without an AI client

```
node bridge/queue.js demo-review-queue --out=exchange/demo/ids.json   # or use demo/ids_to_harvest.json
node bridge/harvest.js demo-review-queue demo/ids_to_harvest.json     # prints a run_id and the items
node bridge/act.js <run_id> --verdicts=demo/verdicts.example.json     # dry run
node bridge/approve.js <run_id>                                       # after reading the plan: prints an approval token
node bridge/act.js <run_id> --live --approval=<token>                 # first live batch (1 item)
node bridge/approve.js <run_id> && node bridge/act.js <run_id> --live --approval=<token>   # next batch (3 items) ...
node bridge/verify.js <run_id>
```

The command-line tools use the extension by default
(`npm run bridge`, extension loaded). To use the CDP connection instead:
`BTR_TRANSPORT=cdp BTR_BROWSER_URL=http://127.0.0.1:9222 node bridge/harvest.js ...`.
For a site that needs no login, such as the demo, `BTR_TRANSPORT=node`
uses plain Node requests with no browser at all.

---

## Use with Claude Code, Claude Desktop or any MCP client

The server speaks MCP over stdio. Run it from a clone
(`node /path/to/browser-task-runner/mcp/server.mjs`) or through the
package bin (`npx browser-task-runner-mcp` once installed).

**Claude Code**

```
claude mcp add browser-task-runner \
  --env BTR_BROWSER_URL=http://127.0.0.1:9222 \
  --env BTR_ALLOW_HOSTS=admin.example.com \
  -- node /path/to/browser-task-runner/mcp/server.mjs
```

**Claude Desktop** (`claude_desktop_config.json`), or any client that
uses the same `mcpServers` format:

```json
{
  "mcpServers": {
    "browser-task-runner": {
      "command": "node",
      "args": ["/path/to/browser-task-runner/mcp/server.mjs"],
      "env": {
        "BTR_BROWSER_URL": "http://127.0.0.1:9222",
        "BTR_ALLOW_HOSTS": "admin.example.com"
      }
    }
  }
}
```

**Configuration**

| Variable | Meaning |
|---|---|
| `BTR_BROWSER_URL` | Attach to a running browser, e.g. `http://127.0.0.1:9222` |
| `BTR_WS_ENDPOINT` | Or attach by its WebSocket endpoint |
| `BTR_USER_DATA_DIR` | Or attach through a profile's `DevToolsActivePort` file |
| `BTR_CHROME_PATH` | Or launch this browser executable (`BTR_HEADLESS=1` for headless; with `BTR_USER_DATA_DIR` as its profile) |
| `BTR_ALLOW_HOSTS` | Extra hosts the tools may touch, comma separated. `*.example.com` allowed. localhost is always allowed |
| `BTR_TRANSPORT` | Batch transport: `cdp` (default when a browser is configured), `node`, or `bridge` |
| `BTR_DATA_DIR` | Where runs, logs and the bridge token are written (default: the repo folder) |
| `BTR_ALLOW_EVALUATE` | Set to `1` to offer the `evaluate` tool. Off by default; every call still needs `confirm: true` |

Without any browser setting the batch tools still work over plain Node
requests (fine for the demo), and the browser tools are not offered.

---

## Just ask

With a browser attached, you can describe a task in plain language and
the assistant chains the tools itself. `run_plan` lets it send many steps
in one call, so a ten-step task is one or two round trips rather than ten.

**"Find the open tickets assigned to me on helpdesk.example.com and list
their titles and dates."**
`navigate` to the ticket list, `snapshot` to see the filters, then one
`run_plan`: `select_option` (assignee), `click` (Apply filter),
`wait_for` (results), `extract` with
`{"title": "td.title", "date": "td.date"}`. Read-only, so nothing needs
confirmation.

**"Fill in the contact form on the demo app: name Test User, topic Bug
report, and say the export button does nothing."**
One `run_plan`: `navigate` to `/contact`, `fill` x2, `select_option`,
`click` "Send message". The click submits a form, so the plan stops with
`needs_confirmation` and a description. The assistant shows you what it
is about to send; after you say yes it repeats that click with
`confirm: true`, then `extract`s the confirmation text.

**"Moderate the demo review queue using its ruleset."**
`describe_skill`, `list_queue`, `harvest`, `get_harvest`, decides
verdicts, `submit_verdicts`, `act` (dry run), shows you the plan, calls
`approve_live` only after you agree, then `act` with `dry_run: false`
and the approval, in staged batches, then `verify` and `read_audit_log`.

If a page asks for a password, card number or ID number, the tools refuse
to type it and the assistant should ask you to enter it yourself. Values
already in such fields are redacted from everything the tools read.

---

## Tool reference

### Batch skills

| Tool | What it does | Changes the site? |
|---|---|---|
| `list_skills` | Installed skills, their site and verdicts | No |
| `describe_skill(skill)` | Config, ruleset and notes | No |
| `list_queue(skill)` | Ids waiting in the queue (if the skill defines a list) | No |
| `harvest(skill, ids, limit?)` | Reads each item, extracts fields, starts a run | No |
| `get_harvest(run_id)` | The harvested items | No |
| `submit_verdicts(run_id, verdicts)` | Validates verdicts against the skill's `actionOrder` | No |
| `act(run_id, dry_run=true, limit?, approval?)` | Dry run: lists every request. Live: needs an approval; sends the requests within the caps | Only when `dry_run=false` |
| `approve_live(run_id)` | Single-use approval for the last dry-run plan, 15 min. Call only after the user approves the plan | No |
| `run_status(run_id)` | Counts and state of a run | No |
| `read_audit_log(run_id \| skill, tail)` | The append-only audit log | No |
| `verify(run_id)` | Re-reads acted items and checks the expected result | No |

### Browser control

| Tool | What it does |
|---|---|
| `list_pages`, `new_page(url)`, `select_page(id)`, `close_page(id)` | Tabs |
| `navigate(url \| back \| forward \| reload)` | Go somewhere in the current tab (refused if the current tab is on a disallowed host; use `new_page` or `close_page`) |
| `snapshot()` | Text outline of the page; interactive elements get uids like `e12` |
| `screenshot(full_page?)` | PNG of the tab, with sensitive fields masked |
| `find(text, role?)` | Element uid by visible text or label |
| `click(target, confirm?)` | Click; irreversible clicks need `confirm` |
| `fill(target, value)` | Replace a field's value |
| `type_text(text)` | Type into the focused element |
| `press_key(key, confirm?)` | Key press; Enter in a form, or Enter/Space on an irreversible-looking button or link, needs `confirm`; refused while a sensitive field has focus |
| `select_option(target, value)` | Choose a select option |
| `hover(target)` | Hover |
| `wait_for(text \| selector, timeout)` | Wait for the page |
| `extract(selector \| uid, fields?)` | Structured data: `{"name": "css"}` or `"css@attr"` |
| `get_text(target?)`, `get_attribute(target, name)`, `query_all(selector, attributes?)` | Read-only queries; sensitive field values come back as `[redacted: sensitive field]` |
| `evaluate(js, confirm)` | Only offered with `BTR_ALLOW_EVALUATE=1`; every call needs `confirm` |
| `upload_file(target, path)` | Attach a local file to a file input |
| `get_network(filter)`, `get_console()` | Recent requests and console messages |
| `run_plan(steps, stop_on_error=true)` | Many of the above in one call |

A *target* is any of `uid` (from `snapshot` or `find`), `selector` (CSS),
or `text` (visible text or label, with an optional `role` of `button`,
`link` or `textbox`).

`run_plan` steps look like `{"tool": "fill", "args": {"text": "Email",
"value": "a@b.test"}}`. An argument can reuse an earlier result:
`{"tool": "click", "args": {"uid": {"use": "step3.uid"}}}`.

---

## Safety model

There are two kinds of control. **Enforced** controls are checked in code
on every path that can reach a site: the MCP tools, the command-line
tools and the extension. **Approval** controls stop and wait for a yes.
The tool can make the request for that yes unavoidable, but it cannot
tell whether a person actually gave it: an MCP client could pass
`confirm: true` or call `approve_live` on its own. So the user should run
it with a client that shows tool calls and asks before running them.

### Enforced in code

| Control | Applies to |
|---|---|
| Host allow-list: localhost plus `BTR_ALLOW_HOSTS`. Every tool that touches the current page runs through one wrapper (`withPage`) that refuses a page on a disallowed host, runs the sensitive-field check, runs the tool, then re-checks the host; if the page moved off the allow-list during the call (redirect, link, script, key press, wait), the tab is sent to `about:blank` and nothing from it is returned. The sensitive-field check must succeed or the tool does not run, and the after-call host check runs even if the tool fails; a tab that cannot be sent to `about:blank` is closed. `navigate` gets the same before-check (so reload, back, forward and navigating away are all refused on a disallowed tab; the way out is `new_page` or `close_page`) and also checks its target URL. `new_page` checks the requested URL, and the final URL after redirects even when loading fails or times out. `list_pages` and `select_page` show a disallowed tab only as blocked (id and host, no URL path or title) | All browser tools (the selftest fails if a page tool is not wrapped); skill `baseUrl`; bridge jobs; extension jobs (extension list set in its popup) |
| No redirect is followed unless it stays on the skill's origin and an allowed host, and the destination is visible (node transport). In the browser (CDP and extension), redirects are never followed and fail the request (`REDIRECT_BLOCKED`) | Batch read, list, act and verify |
| Same-origin action URLs; item values are URI-encoded into paths | Batch act |
| Harvest, list and verify only send GET requests | Batch |
| Dry run is the default; a live act needs an approval token that is single use, expires after 15 minutes, and is bound to the run, its verdict hash and the dry-run plan. Changing the verdicts voids it | Batch act |
| Staged rollout and batch cap; a batch with an error does not advance the stage | Batch act |
| One live act per skill at a time, across processes (lock file; a stale lock from a dead process is cleared) | Batch act |
| Fresh read before every write: identity guard, stale-content check, precondition | Batch act |
| Escalation verdicts (empty action list) are never acted on | Batch act |
| Rate limit; circuit breaker after N consecutive errors | Batch harvest and act |
| Processed index written before the next item, so a re-run never repeats a write | Batch act |
| Sensitive fields are classified by one function, run in the page before every read, write, target lookup and screenshot, so the read and write rules cannot differ: `type="password"`; `autocomplete` of `cc-*`, `one-time-code`, `current-password` or `new-password`; or a name, id, any of its labels, placeholder or aria-label matching password, PIN, OTP, card number, CVV/CVC/security code, IBAN, account or routing number, SSN, passport, national ID, tax ID, driver's licence and similar | All browser tools |
| Typing into a sensitive field is refused, including single key presses while it has focus | `fill`, `type_text`, `press_key`, `select_option` |
| A sensitive field's value is never returned: it is replaced by `[redacted: sensitive field]` in snapshot text, `extract` results, `query_all` text and attributes, `get_attribute` (every attribute except descriptive ones such as `type`, `name`, `id`, `autocomplete`, `placeholder`), and `get_text` (on the field, and on containers, where sensitive descendants are skipped). `find` and text targets never match a field's value, and a sensitive button's value is shown as the marker | `snapshot`, `run_plan` final snapshot, `extract`, `query_all`, `get_attribute`, `get_text`, `find` |
| Screenshots mask every sensitive field during capture (characters hidden by an injected style, and an opaque box drawn over each field, including selects and textareas); the masking is removed afterwards, also on error | `screenshot`, screenshots inside `run_plan` |
| `evaluate` (arbitrary JavaScript) is not offered unless `BTR_ALLOW_EVALUATE=1` | MCP and `run_plan` |
| Bridge: per-install token on every endpoint except `/health`; requests from web-page origins and CORS preflights refused; no CORS headers; only `fetch`, `navigate` and `closeTab` jobs (no script execution); loopback only | Bridge and extension |
| Extension: refuses a non-GET request not marked as a write by the engine | Extension |
| Audit logs: `logs/<skill>.audit.jsonl` and `logs/browser.audit.jsonl` (typed values logged by length only) | Everything |

The test suite includes a safety matrix (`test/matrix.test.js`) that takes
the tool list from the MCP server's registry and checks every browser tool
on a disallowed page, on a focused sensitive field, and (for tools that can
move the page) after moving off the allow-list. A new tool fails the test
until it is given a row.

### Needs a person to approve

- **Irreversible browser actions** (form submits; clicks whose text reads
  like submit, send, pay, buy, order, delete, publish, post, confirm,
  approve, reject, transfer and similar; Enter inside a form field; Enter or Space on a button or link that looks
  irreversible) and **every `evaluate` call** return `needs_confirmation`. The client must
  show the user what will happen and repeat the call with `confirm: true`
  only after a clear yes. `run_plan` stops at such a step. Detection is by
  pattern, so it errs towards asking; an action that does not look
  irreversible will not be stopped.
- **Live batch runs** need `approve_live`. The client must show the user
  the dry-run plan (`plan_summary`) and call it only after the user agrees.
- **Verdicts** are judgements made by a person or an AI session. The
  engine checks their form, not whether they are right. Read the dry run.

### Known limits

- Rules for "irreversible" and "sensitive field" are heuristics. A
  sensitive value shown as ordinary page text (not in a form field) is
  not recognised: read tools return it and screenshots show it.
- Screenshot masking covers fields in the main document; fields inside
  iframes or closed shadow roots are not masked.
- The extension enforces its own host list but cannot check an approval
  token; it relies on the bridge token so that only the local engine can
  send it work.
- Sites that answer a successful POST with a redirect need
  `"acceptRedirect": true` on that action (the redirect is still not
  followed).
- It does not solve CAPTCHAs or handle logins or MFA; log in yourself.
  It does not store cookies or passwords.

Use it on systems you are authorised to operate, and follow each site's
terms of use.

---

## The optional extension

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`),
   turn on **Developer mode**, click **Load unpacked** and select this
   folder.
2. Start the bridge: `npm run bridge`, then check
   `curl -s http://127.0.0.1:8777/health`. On first run it creates a
   random pairing token in `.btr-token` (gitignored, readable only by
   you) and prints its location.
3. **Pair:** open the extension popup, paste the contents of `.btr-token`
   into "pairing token", add any extra hosts, and click Save. Every
   bridge endpoint except `/health` rejects requests without the token,
   and requests from web pages are refused. The live dashboard is at
   `http://127.0.0.1:8777/#token=<token>` (the popup links to it). To pin
   the bridge to one extension, set
   `BTR_EXTENSION_ORIGIN=chrome-extension://<extension id>`.
4. Add each site you want the extension to work on to `host_permissions`
   in `manifest.json` (for example `"https://admin.example.com/*"`), and
   reload the extension. By default it only has access to the bridge and
   the demo app.

The popup shows bridge status and the latest activity, and links to the
live dashboard. To start the bridge automatically at login, see
`bridge/autostart/` (a launchd template for macOS and a scheduled-task
script for Windows).

---

## Write your own skill

A skill is one folder and one line:

```
src/skills/<your-skill>/skill.json    what to read, what to send, per verdict
src/skills/<your-skill>/ruleset.md    how to decide verdicts (for the reviewer)
src/skills/<your-skill>/NOTES.md      what you confirmed about the site
src/skills/registry.json              add "<your-skill>"
```

The engine never changes. See **[SKILL-AUTHORING.md](SKILL-AUTHORING.md)**
for the full format and a checklist, and `src/skills/demo-review-queue/`
for a working example. Add the site's host to `BTR_ALLOW_HOSTS`, run
`node bridge/selftest.js` to validate the skill, and always start with a
dry run.

---

## Project layout

```
engine/        shared engine: skills.js, index.js (runs), browser.js (browser tools),
               transports.js, cdp.js
mcp/           MCP server (stdio)
bridge/        local bridge server, dashboard, command-line tools, selftest
src/           extension service worker and popup; skills/
demo/          demo admin app, sample ids and verdicts
test/          engine, browser and MCP tests
```

See `SCOPE.md` for the design and `NOTICE.md` for third-party notices.
The browser connection and tool set are adapted from
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(Apache-2.0); it is not a runtime dependency.
