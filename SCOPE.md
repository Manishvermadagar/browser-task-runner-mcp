# Browser Task Runner: design

## Purpose

Two jobs, one engine:

1. **Batch admin work with a human review step.** Many back-office tasks
   are a queue of items, each read, judged against written rules and then
   approved, rejected or updated. Doing this by hand is slow; letting a
   script loose on it is risky. This tool splits the work so that reading
   is automated and harmless, deciding is done by a person or an AI
   session against an explicit ruleset, and acting is automated but held
   to its own safety controls: dry runs, staged rollout, rate limits, a
   circuit breaker, an audit log and verification.
2. **General browser control for AI clients.** An MCP server that lets an
   assistant navigate, read and operate web pages in the user's own
   browser, quickly (many steps per call) and within enforced limits
   (allowed hosts, confirmation for irreversible actions, no typing into
   sensitive fields).

## Non-goals

- Not a scraper for sites the user is not authorised to operate.
- No CAPTCHA solving, no login or MFA automation, no credential storage.
  The user logs in; the tool uses that session.
- Not multi-user or hosted. One machine, one browser profile, loopback
  only.
- No model calls from inside the tool. Judgement comes from the person or
  the AI session that is using it.

## Architecture

```
engine/skills.js      skill loading and validation, templating, extraction
engine/index.js       run life cycle: harvest, verdicts, act, verify; all
                      batch safety controls; audit log; on-disk state
engine/browser.js     primitive browser tools, run_plan, browser safety rules
engine/transports.js  how a request reaches the site: node | cdp | bridge
engine/cdp.js         one shared Chrome DevTools Protocol connection
mcp/server.mjs        MCP front end (stdio)
bridge/server.js      job queue and dashboard for the extension front end
bridge/*.js           command-line front end
src/background.js     extension: runs fetch and page-script jobs
```

Every front end calls the same engine functions, so a safety control
cannot exist in one front end and be missing from another.

### Transports

The engine only calls `transport.request({url, method, headers, body,
allowRedirect})`, always through one `send()` function that applies the
redirect policy for read, list, act and verify.

- **cdp**: `fetch()` executed inside a tab on the target origin, through
  puppeteer-core. The browser attaches its own cookies; the tool never
  sees them.
- **bridge**: the same request handed to the extension through the local
  job queue, authenticated with the per-install token in `.btr-token`.
- **node**: Node's own `fetch`, no browser. For sites without login (the
  demo) and for tests.

### State

- `exchange/runs/<run_id>/run.json`: ids, harvested fields, verdicts,
  verdict hash, dry-run record, results. Written atomically (temp file and
  rename) after every item.
- `logs/<skill>.audit.jsonl`: append-only, one line per event.
- `logs/<skill>.processed.json`: items acted on live. Written before the
  next item starts. An item in this index is never acted on again.
- `logs/<skill>.rollout.json`: how many clean live batches have run.
- `logs/browser.audit.jsonl`: every browser-control action.

## Batch life cycle

1. **list_queue** (optional) reads ids from the skill's list endpoint.
2. **harvest** reads each item, applies the extract rules, and records a
   content hash of the reviewed field. Read-only.
3. **submit_verdicts** checks each verdict is one the skill defines, that
   the id belongs to the run, and that its harvest succeeded. It stores a
   hash of the whole verdict set.
4. **act (dry run)** does a fresh read of each item and builds the exact
   requests it would send, without sending them. On completion the verdict
   hash is marked as dry-run.
5. **approve_live** issues a single-use token, valid 15 minutes, bound to
   the run, the verdict hash and a hash of the dry-run plan. The client
   calls it only after the user has seen the plan and agreed.
6. **act (live)** requires and consumes that token, takes the skill's
   lock file (one live act per skill across processes), then for each item: fresh read,
   identity guard, stale-content check, precondition, requests in
   `actionOrder`, processed-index write, immediate verify.
7. **verify** re-reads every acted item and checks the skill's expected
   result.

## Batch safety controls

| Control | Where | Default |
|---|---|---|
| Dry run first | `act()` | `dryRun = true` |
| Live approval | `approveLive()` | single use, 15 min, bound to run + verdicts + dry-run plan |
| Serialised live acts | lock file per skill | lock cleared only if its owning process is dead; removed only by its owner |
| Redirects | `send()` | only same-origin, allowed-host, visible destinations followed; else REDIRECT_BLOCKED |
| Staged rollout | `safety.stagedRollout` | `[1, 5, 20]`, then `maxBatch` |
| Batch cap | `safety.maxBatch` | 50 |
| Rate limit | `safety.rateLimitMs` | 800 ms between items |
| Circuit breaker | `safety.maxConsecutiveErrors` | 3 |
| Escalation | empty `actionOrder` list | never acted on |
| Identity guard | `read.identityGuard` | page must show the requested id |
| Stale content | `read.contentField` | hash must match the harvest |
| Precondition | `read.actOnlyWhen` | e.g. only act while `status = pending` |
| Same origin | `buildRequest()` | always |
| Allowed hosts | `BTR_ALLOW_HOSTS` | localhost only |
| Audit log | every event | always |
| Verification | `verify` rules | per verdict |

A live batch that has any error, including a failed verification, does
not advance the rollout stage.

## Browser control

Elements are identified by uids (`e1`, `e2`, ...) that `snapshot` writes
onto the page as a data attribute, so a uid stays valid until the page
reloads. Tools also accept a CSS selector or visible text.

`run_plan` executes up to 50 steps in one call and returns each step's
result and a short final snapshot. It stops at the first error (unless
`stop_on_error` is false) and always stops at a step that needs
confirmation.

### Browser safety rules

Every tool that acts on the current page is registered with `def()` and
called through `withPage()`, which always checks the host, runs the
sensitive-field check (the tool does not run if it fails), runs the tool
and re-checks the host even if the tool threw (blanking, or else closing,
a tab that moved off the allow-list). `navigate` is not exempt: on a
disallowed tab the way out is `new_page` or `close_page`. Tools that do
not act on the current page (`list_pages`, `new_page`, `select_page`,
`close_page`, `run_plan`) are registered separately with the reason
recorded; the selftest compares this against the MCP tool list.

- **Allowed hosts.** Checked before navigation, before acting on the
  current page, for link targets, and after every click (a redirect to
  another host is undone).
- **Confirmation.** A click on a form-submit control or on an element
  whose text matches the irreversible-action pattern (submit, send, pay,
  buy, order, checkout, delete, remove, publish, post, confirm, approve,
  reject, transfer and similar), Enter inside a form field, and every
  `evaluate` call return `needs_confirmation`. The client must show the
  user and receive a yes before calling again with `confirm: true`.
- **evaluate is off by default.** Arbitrary JavaScript cannot be proven
  read-only, so the tool is only registered with `BTR_ALLOW_EVALUATE=1`.
  `get_text`, `get_attribute`, `query_all` and `extract` cover reading.
- **Sensitive fields.** One classification function (`markSensitiveInPage`), shared by reads, writes, masking and target matching, (password type; `autocomplete`
  `cc-*`, `one-time-code`, `current-password`, `new-password`; or a name,
  id, label, placeholder or aria-label referring to card numbers, CVV,
  bank account numbers, passports, national IDs, tax IDs and similar) is
  applied in the page before every read and before typing. `fill` and
  `type_text` refuse those fields. Every read path (snapshot, extract,
  query_all, get_attribute, get_text) goes through one in-page reader that
  returns `[redacted: sensitive field]` for their values and for any
  non-descriptive attribute, and skips them inside container text. Text
  targets never match a field's value. Screenshots mask the same fields
  (injected style plus an opaque overlay) for the capture and remove the
  masking in a finally block. Fields in iframes are not covered.
- **Audit.** Every call is logged with its outcome; typed values are
  recorded only as a length.

These rules are heuristics. They are deliberately broad (some harmless
clicks will ask for confirmation), and they are not a substitute for the
user reading what the assistant proposes.

## Extension front end

The extension holds no task logic. It long-polls `GET /jobs/next` on the
bridge with its pairing token, runs `fetch`, `navigate` or `closeTab` jobs
(there is no script-execution job), and posts
results to `POST /result/<id>`. An MV3 service worker is stopped when idle
and loses timers, so polling is driven by `chrome.alarms`. Its
`host_permissions` cover only the bridge and the demo app by default;
users add their own hosts.

## Testing

- `bridge/selftest.js`: static checks (skills validate, templating and
  extraction contracts, safety defaults, safety patterns, ports and
  permissions, source hygiene).
- `test/engine.test.js`: full batch life cycle against the demo app over
  the node transport, and again through the real bridge with a stand-in
  for the extension.
- `test/browser.test.js`: browser tools and the CDP batch transport in a
  real headless browser; skipped if none is installed.
- `test/mcp.test.mjs`: the MCP server over stdio, as a client sees it.
