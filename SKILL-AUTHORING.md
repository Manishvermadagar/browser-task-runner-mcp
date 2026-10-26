# Writing a skill

A skill teaches the engine one admin task on one site: how to read an
item, which verdicts exist, and which HTTP requests each verdict sends.
It is data only. The engine code never changes for a new task.

```
src/skills/<id>/skill.json
src/skills/<id>/ruleset.md
src/skills/<id>/NOTES.md
src/skills/registry.json       add "<id>" to the array
```

The id must be lowercase letters, digits and hyphens.

## Step 1: study the site, by hand, read-only

In your browser's DevTools, with the network panel open, look at:

1. **The item page.** The URL for one item, and where in the response each
   field you need sits (HTML or JSON). Note anything that proves which
   item the page shows (an id in a form action or data attribute).
2. **The list** (optional). An endpoint that returns the pending ids.
3. **The actions.** Do one approve (or equivalent) by hand on a test item
   and record the request: method, URL, body format, field names, and
   where any CSRF token comes from. DevTools request blocking lets you
   capture a request without it reaching the server.
4. **What changes afterwards.** How a decided item looks when read again.
   This becomes your verify rule.

Write all of this into `NOTES.md`, marking what you confirmed and what you
assumed.

## Step 2: skill.json

```json
{
  "id": "my-queue",
  "label": "Human-readable name",
  "baseUrl": "https://admin.example.com",

  "list": { "url": "/api/pending", "itemsPath": "data.items", "idField": "id" },

  "read": {
    "urlTemplate": "/items/{id}",
    "method": "GET",
    "extract": [
      { "name": "itemId", "type": "regex", "pattern": "data-id=\"(\\d+)\"", "group": 1 },
      { "name": "body", "type": "regex", "pattern": "<div id=\"body\">([\\s\\S]*?)</div>", "group": 1, "decodeHtmlEntities": true },
      { "name": "csrfToken", "type": "regexAttr", "tagPattern": "<input\\b[^>]*name=\"_token\"[^>]*>", "attr": "value" },
      { "name": "status", "type": "jsonPath", "path": "item.status" }
    ],
    "requiredExtract": ["itemId", "body"],
    "identityGuard": { "requestedIdVar": "id", "mustEqualExtract": "itemId" },
    "contentField": "body",
    "actOnlyWhen": { "field": "status", "equals": "pending" }
  },

  "actions": {
    "approve": {
      "urlTemplate": "/items/{id}/approve",
      "method": "POST",
      "bodyType": "form",
      "requiredVars": ["csrfToken"],
      "headers": { "X-CSRF-Token": "{csrfToken}" },
      "fields": { "_token": "{csrfToken}", "comment": "{note}" }
    }
  },

  "actionOrder": {
    "APPROVE": ["approve"],
    "ESCALATE": []
  },

  "verify": {
    "APPROVE": { "extract": "status", "equals": "approved" }
  },

  "safety": {
    "rateLimitMs": 800,
    "maxConsecutiveErrors": 3,
    "maxBatch": 50,
    "stagedRollout": [1, 5, 20]
  }
}
```

### Fields

| Key | Required | Meaning |
|---|---|---|
| `baseUrl` | yes | Origin only, no path. Every request goes here. Its host must be in `BTR_ALLOW_HOSTS`. |
| `list` | no | JSON endpoint for pending ids. `itemsPath` is a dot path to the array; `idField` names the id. |
| `read.urlTemplate` | yes | Path of one item. `{id}` and other item fields are substituted, URI-encoded. |
| `read.extract` | yes | Rules, see below. |
| `read.requiredExtract` | no | Fields that must be present, or the item errors. |
| `read.identityGuard` | recommended | The extracted field must equal the requested id. Protects against sites that serve another item's page. |
| `read.contentField` | recommended | Field hashed at harvest; if it differs at act time the item is skipped as STALE. |
| `read.actOnlyWhen` | no | `{field, equals}`; otherwise the item is skipped as STALE. |
| `actions` | yes | Named requests. `bodyType` is `form`, `json` or `none`. Add `"acceptRedirect": true` only if the site answers a successful POST with a redirect; the redirect is still not followed. |
| `actionOrder` | yes | Verdict name to list of actions, run in order. **An empty list means a person decides**; include one. |
| `verify` | recommended | Per verdict: re-read the item and compare an extracted field (`extract`, `equals`), or check `expectStatus` on `urlTemplate`. |
| `safety` | no | Overrides the defaults shown. |

### Extract rules

| `type` | Keys | Returns |
|---|---|---|
| `regex` | `pattern`, `group`, `flags` (default `i`) | The capture group, or null |
| `regexAttr` | `tagPattern`, `attr` | The attribute value of the first matching tag |
| `jsonPath` | `path` (dot path) | The value; objects are JSON-encoded |

Add `"decodeHtmlEntities": true` to get both `<name>` (raw, what you send
back) and `<name>Decoded` (what a reviewer reads). Keep the two apart:
writing the decoded form back would silently change stored text.

A field that is not found is `null`, never an empty string, so "absent"
and "empty" stay distinguishable.

### Template variables

Inside `urlTemplate`, `fields` and `headers`, `{name}` is replaced from,
in order of precedence: the verdict object, the fresh read, then the item
from the id list. So a verdict like `{"verdict": "REJECT", "note": "spam"}`
makes `{note}` available. A field that is exactly `"{name}"` keeps the
value's type (useful for JSON bodies); a missing value becomes an empty
string. Any `requiredVars` that are missing stop the request.

## Step 3: ruleset.md

Written for whoever decides verdicts, person or AI. State each verdict and
when it applies, what is never grounds for a verdict, when to escalate,
and the exact output shape. Prefer escalation over guessing.

## Step 4: test it

```
node bridge/selftest.js                          # validates every skill
BTR_ALLOW_HOSTS=admin.example.com \
BTR_TRANSPORT=cdp BTR_BROWSER_URL=http://127.0.0.1:9222 \
  node bridge/harvest.js my-queue ids.json --limit=3
```

Check every extracted field on a few items against the page. Then write
verdicts for those items, dry-run them and read every planned request.
Only then approve it (`node bridge/approve.js <run_id>`) and run live with
the approval: the first live batch is one item. Read it back on the
site yourself before letting the rollout continue.

## Checklist

- [ ] `baseUrl` is the origin only, and its host is allowed
- [ ] identity guard set, and tested with an id that is no longer pending
- [ ] `contentField` set to the field the reviewer judges
- [ ] an escalation verdict with an empty action list
- [ ] every action's fields confirmed from a real captured request
- [ ] a verify rule for every verdict that acts
- [ ] `NOTES.md` says what was confirmed and what was assumed
- [ ] dry run read in full before the first live item
