// General browser control over CDP: the primitive tools (navigate, snapshot,
// click, fill, ...) and run_plan, which executes many of them in one call.
//
// The tool set is modelled on chrome-devtools-mcp (Apache-2.0, see
// NOTICE.md). The safety rules below are enforced here, in code, for every
// caller; they are not left to the AI client's judgement:
//
//   1. Host allow-list. Navigation, and any action on a page, is refused
//      unless the page's host is allowed (default: localhost only).
//   2. Confirmation for irreversible actions. A click or key press that
//      would submit a form, or whose target reads like submit / send / pay /
//      buy / delete / publish / confirm / place order (and similar), and any
//      evaluate() call, returns { needs_confirmation } instead of
//      running unless the call passes confirm: true. evaluate() is disabled
//      entirely unless the server runs with BTR_ALLOW_EVALUATE=1. The AI client must show
//      the user what it is about to do and get a yes before passing it.
//   3. Sensitive fields. Typing into password, payment-card or
//      government-ID fields is always refused; the AI must ask the user to
//      enter those values themselves.
//   4. Every action is written to logs/browser.audit.jsonl.

const fs = require("fs");
const path = require("path");

const IRREVERSIBLE = /\b(submit|send|pay|payment|buy|purchase|order|checkout|check out|delete|remove|destroy|erase|publish|post|confirm|approve|reject|transfer|withdraw|deposit|unsubscribe|cancel subscription|sign up|register|create account)\b/i;
const SENSITIVE_NAME = /(passw|passcode|\bpin\b|otp|one.?time|cvv|cvc|\bcsc\b|security.?code|card.?(num|no)|cc.?(num|no)|credit.?card|iban|routing|account.?(num|no)|sort.?code|ssn|social.?sec|passport|national.?id|aadhaa?r|\bpan\b|tax.?id|driver.?licen[cs]e|govt?.?id)/i;
const WRITE_JS = /(\.click\s*\(|\.submit\s*\(|requestSubmit|dispatchEvent|\bfetch\s*\(|XMLHttpRequest|sendBeacon|\.value\s*=|\.checked\s*=|innerHTML\s*=|outerHTML\s*=|textContent\s*=|insertAdjacent|appendChild|removeChild|\.remove\s*\(|setAttribute|localStorage\.(set|remove|clear)|sessionStorage\.(set|remove|clear)|document\.cookie\s*=|location\s*=|location\.(href|assign|replace)|window\.open|history\.(push|replace))/;

function parseAllowHosts(list) {
  const base = ["localhost", "127.0.0.1", "[::1]"];
  const extra = String(list || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...base, ...extra])];
}

function hostAllowed(url, allow) {
  if (!url || url === "about:blank") return true;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!["http:", "https:"].includes(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  return allow.some((a) => a === "*" || h === a || (a.startsWith("*.") && (h.endsWith(a.slice(1)) || h === a.slice(2))));
}

// ---- code that runs inside the page ---------------------------------------
// Builds a compact, text-only outline of the page: headings, links, buttons,
// form fields and short text blocks, each interactive one tagged with a uid
// that stays on the element until the page reloads.
const REDACTED = "[redacted: sensitive field]";
// Attributes that describe a field rather than carry its value; everything
// else on a sensitive field is redacted by the read tools.
const SAFE_ATTRS = ["type", "name", "id", "autocomplete", "class", "aria-label", "placeholder", "required", "disabled", "maxlength", "inputmode", "for", "role", "title"];
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|current-password|new-password)/i;

// Runs in the page before every read: classifies form fields with the same
// rules that make fill/type_text refuse them, and marks the sensitive ones
// with data-btr-sensitive so each read tool can redact them.
function markSensitiveInPage(nameSrc, acSrc) {
  const nameRe = new RegExp(nameSrc, "i");
  const acRe = new RegExp(acSrc, "i");
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const labels = el.labels ? [...el.labels].map((l) => l.innerText).join(" ") : "";
    const type = (el.getAttribute("type") || "").toLowerCase();
    const ac = el.getAttribute("autocomplete") || "";
    const hay = [el.getAttribute("name"), el.id, labels, el.getAttribute("placeholder"), ac, el.getAttribute("aria-label")].join(" ");
    if (type === "password" || acRe.test(ac) || nameRe.test(hay)) el.setAttribute("data-btr-sensitive", "1");
  }
}

function snapshotInPage(maxLines, marker) {
  const isSens = (el) => el.getAttribute("data-btr-sensitive") === "1" || el.type === "password";
  let n = Number(document.documentElement.getAttribute("data-btr-n") || 0);
  const lines = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const labelOf = (el) => {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText; }
    const pl = el.closest("label"); if (pl) return pl.innerText;
    return el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "";
  };
  const uid = (el) => {
    let u = el.getAttribute("data-btr-uid");
    if (!u) { u = "e" + (++n); el.setAttribute("data-btr-uid", u); }
    return u;
  };
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode; el && lines.length < maxLines; el = walker.nextNode()) {
    if (!(el instanceof HTMLElement) || !vis(el)) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (/^h[1-6]$/.test(tag)) lines.push(`heading${tag[1]} "${clean(el.innerText)}"`);
    else if (tag === "a" && el.href) lines.push(`[${uid(el)}] link "${clean(el.innerText || el.getAttribute("aria-label"))}" -> ${el.getAttribute("href")}`);
    else if (tag === "button" || role === "button" || (tag === "input" && ["submit", "button", "reset"].includes(el.type))) lines.push(`[${uid(el)}] button "${isSens(el) ? marker : clean(el.innerText || el.value || el.getAttribute("aria-label"))}"${el.disabled ? " disabled" : ""}`);
    else if (tag === "input" && el.type !== "hidden") {
      const v = isSens(el) ? (el.value ? marker : "") : el.value;
      lines.push(`[${uid(el)}] ${["checkbox", "radio"].includes(el.type) ? el.type + (el.checked ? " checked" : "") : "textbox type=" + el.type} "${clean(labelOf(el))}"${v ? ` value="${clean(v)}"` : ""}`);
    } else if (tag === "textarea") lines.push(`[${uid(el)}] textarea "${clean(labelOf(el))}"${el.value ? ` value="${isSens(el) ? marker : clean(el.value)}"` : ""}`);
    else if (tag === "select") lines.push(`[${uid(el)}] select "${clean(labelOf(el))}" options=${isSens(el) ? marker : "[" + [...el.options].map((o) => (o.selected ? "*" : "") + clean(o.value) + ":" + clean(o.text)).join(", ") + "]"}`);
    else if (["p", "li", "td", "th", "blockquote", "label", "dd", "dt", "figcaption", "caption", "pre", "code"].includes(tag) && !el.querySelector("p,li,td,blockquote,div")) {
      const t = clean(el.innerText);
      if (t && tag !== "label") lines.push(`text "${t}"`);
    }
  }
  document.documentElement.setAttribute("data-btr-n", String(n));
  return { url: location.href, title: document.title, lines };
}

// Every read tool (extract, get_text, get_attribute, query_all) goes through
// this one in-page function, so sensitive fields are redacted the same way
// everywhere: their value, their text, and any attribute not in SAFE_ATTRS
// come back as the marker. Text of a container skips sensitive descendants.
function readInPage(mode, a, marker, safeAttrs) {
  const isSens = (el) => !!el && el.nodeType === 1 && (el.getAttribute("data-btr-sensitive") === "1" || el.type === "password");
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => {
    if (isSens(el)) return marker;
    if (!el.querySelector || !el.querySelector('[data-btr-sensitive="1"], input[type=password]')) return norm(el.innerText || el.value || "");
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === 1 && isSens(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeType === 3) out.push(n.nodeValue);
    return norm(out.join(" "));
  };
  const attrOf = (el, name) => {
    const n = String(name).toLowerCase();
    if (isSens(el) && !safeAttrs.includes(n)) return el.hasAttribute(name) || n === "value" ? marker : null;
    return el.getAttribute(name);
  };
  const uidOf = (el) => {
    let u = el.getAttribute("data-btr-uid");
    if (!u) { const k = Number(document.documentElement.getAttribute("data-btr-n") || 0) + 1; document.documentElement.setAttribute("data-btr-n", String(k)); u = "e" + k; el.setAttribute("data-btr-uid", u); }
    return u;
  };
  if (mode === "text") { const el = document.querySelector(a.sel); return el ? textOf(el).slice(0, 100000) : null; }
  if (mode === "attr") { const el = document.querySelector(a.sel); return el ? attrOf(el, a.name) : null; }
  const els = [...document.querySelectorAll(a.sel)].slice(0, a.limit);
  if (mode === "query") {
    return els.map((el) => {
      const o = { uid: uidOf(el), tag: el.tagName.toLowerCase(), text: textOf(el).slice(0, 300) };
      if (isSens(el)) o.sensitive = true;
      for (const at of a.attributes || []) o[at] = attrOf(el, at);
      return o;
    });
  }
  // extract
  return els.map((el) => {
    if (!a.fields) return textOf(el);
    const o = {};
    for (const [k, spec] of Object.entries(a.fields)) {
      const [css, attr] = String(spec).split("@");
      const t = css ? el.querySelector(css) : el;
      o[k] = !t ? null : attr ? attrOf(t, attr) : textOf(t);
    }
    return o;
  });
}

// Masks (on=true) or unmasks (on=false) every field marked sensitive, for the
// duration of a screenshot: a style hides the characters, and an opaque box
// covers each field (needed for selects and textareas, harmless for inputs).
function maskInPage(on) {
  document.getElementById("btr-mask-style")?.remove();
  document.querySelectorAll(".btr-mask-overlay").forEach((n) => n.remove());
  if (!on) return 0;
  const st = document.createElement("style");
  st.id = "btr-mask-style";
  st.textContent = '[data-btr-sensitive="1"]{-webkit-text-security:disc!important;color:transparent!important;text-shadow:none!important;caret-color:transparent!important}';
  document.documentElement.appendChild(st);
  const els = [...document.querySelectorAll('[data-btr-sensitive="1"]')];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const box = document.createElement("div");
    box.className = "btr-mask-overlay";
    box.style.cssText = `position:absolute;left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px;background:#888;z-index:2147483647;pointer-events:none`;
    document.body.appendChild(box);
  }
  return els.length;
}

// Describes an element for the safety checks.
function describeInPage(el) {
  const form = el.form || el.closest("form");
  const label = el.labels ? [...el.labels].map((label) => label.innerText).join(" ") : "";
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const isSubmit = !!form && ((tag === "button" && (type === "" || type === "submit")) || (tag === "input" && ["submit", "image"].includes(type)));
  return {
    tag, type,
    text: String((["input", "textarea", "select"].includes(tag) ? "" : el.innerText) || (tag === "input" && ["submit", "button", "reset", "image"].includes(type) ? el.value : "") || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 100),
    name: el.getAttribute("name") || "", id: el.id || "", autocomplete: el.getAttribute("autocomplete") || "",
    ariaLabel: el.getAttribute("aria-label") || "",
    // Set by markSensitiveInPage, the single sensitive-field check for reads and writes.
    marked: el.getAttribute("data-btr-sensitive") === "1" || type === "password",
    label: String(label).replace(/\s+/g, " ").trim().slice(0, 100), placeholder: el.getAttribute("placeholder") || "",
    href: el.getAttribute("href") || "", isSubmit, formAction: form ? form.action : "", formMethod: form ? (form.method || "get") : "",
    inForm: !!form,
  };
}

function createBrowserController({ connection, allowHosts = parseAllowHosts(process.env.BTR_ALLOW_HOSTS), logDir, timeoutMs = 15000, allowEvaluate = process.env.BTR_ALLOW_EVALUATE === "1", maskScreenshots = true, onCapture = null } = {}) {
  if (!connection) throw new Error("createBrowserController needs a CDP connection");
  const pages = new Map(); // id -> page
  const ids = new WeakMap(); // page -> id
  const netLog = new WeakMap();
  const conLog = new WeakMap();
  let nextId = 1;
  let selected = null;
  const auditFile = logDir ? path.join(logDir, "browser.audit.jsonl") : null;
  if (logDir) fs.mkdirSync(logDir, { recursive: true });

  function audit(tool, args, result) {
    if (!auditFile) return;
    const redactArgs = (name, input) => {
      const a = { ...(input || {}) };
      if (a.value !== undefined) a.value = `(${String(a.value).length} chars)`;
      if (a.text !== undefined && name === "type_text") a.text = `(${String(a.text).length} chars)`;
      return a;
    };
    const a = redactArgs(tool, args);
    if (tool === "run_plan" && Array.isArray(a.steps)) {
      a.steps = a.steps.map((step) => ({
        ...step,
        args: redactArgs(step.tool, step.args),
      }));
    }
    fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), tool, args: a, outcome: result && (result.needs_confirmation ? "needs_confirmation" : result.refused ? "refused" : result.error ? "error" : "ok"), detail: result && (result.reason || result.error) }) + "\n");
  }

  function track(page) {
    if (ids.has(page)) return ids.get(page);
    const id = nextId++;
    ids.set(page, id); pages.set(id, page);
    const net = []; const con = [];
    netLog.set(page, net); conLog.set(page, con);
    page.on("response", (r) => { net.push({ method: r.request().method(), url: r.url(), status: r.status(), type: r.request().resourceType() }); if (net.length > 300) net.shift(); });
    page.on("requestfailed", (r) => { net.push({ method: r.method(), url: r.url(), status: 0, failed: r.failure() && r.failure().errorText }); if (net.length > 300) net.shift(); });
    page.on("console", (m) => { con.push({ type: m.type(), text: m.text().slice(0, 500) }); if (con.length > 300) con.shift(); });
    page.on("pageerror", (e) => { con.push({ type: "pageerror", text: String(e.message || e).slice(0, 500) }); });
    page.on("close", () => { pages.delete(id); if (selected === page) selected = null; });
    return id;
  }

  async function syncPages() {
    const b = await connection.get();
    for (const p of await b.pages()) track(p);
  }

  async function current() {
    if (selected && !selected.isClosed()) return selected;
    await syncPages();
    const open = [...pages.values()].filter((p) => !p.isClosed());
    if (open.length) { selected = open[open.length - 1]; return selected; }
    const b = await connection.get();
    selected = await b.newPage();
    track(selected);
    return selected;
  }

  const refuse = (reason) => ({ refused: true, reason });
  const confirmNeeded = (description) => ({ needs_confirmation: true, description,
    instruction: "Show the user exactly what this will do and ask for a yes. Only then repeat the call with confirm: true." });

  function checkHost(url) {
    return hostAllowed(url, allowHosts) ? null
      : refuse(`host not allowed: ${(() => { try { return new URL(url).host; } catch { return url; } })()}. Allowed: ${allowHosts.join(", ")}. The user can add hosts with BTR_ALLOW_HOSTS.`);
  }

  // target: { uid } | { selector } | { text, role? }
  async function resolve(page, t) {
    await markSensitive(page); // classify first, so matching and the write checks see the marks
    let handle = null;
    if (t.uid) handle = await page.$(`[data-btr-uid="${String(t.uid).replace(/"/g, "")}"]`);
    else if (t.selector) handle = await page.$(t.selector);
    else if (t.text) {
      handle = await page.evaluateHandle((text, role) => {
        const want = text.toLowerCase();
        const sel = role === "button" ? "button,input[type=submit],input[type=button],[role=button]"
          : role === "link" ? "a[href]"
          : role === "textbox" ? "input,textarea"
          : "button,input[type=submit],input[type=button],[role=button],a[href],input,textarea,select,label,summary";
        const cands = [...document.querySelectorAll(sel)];
        const textOf = (el) => {
          // A field's typed value is never matched, so text search cannot be
          // used to probe what a field contains; only button values count.
          const btnVal = el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type) && el.getAttribute("data-btr-sensitive") !== "1" ? el.value : "";
          let t = (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" ? "" : el.innerText) || btnVal || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
          if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t += " " + l.innerText; }
          return t.replace(/\s+/g, " ").trim().toLowerCase();
        };
        let el = cands.find((c) => textOf(c) === want) || cands.find((c) => textOf(c).includes(want));
        if (el && el.tagName === "LABEL" && el.control) el = el.control;
        return el || null;
      }, String(t.text), t.role || "");
      if (handle && !(await handle.evaluate((x) => !!x))) handle = null;
    }
    if (!handle) throw new Error(`element not found (${JSON.stringify(t)}); take a fresh snapshot`);
    const uid = await handle.evaluate((el) => {
      let u = el.getAttribute("data-btr-uid");
      if (!u) { const n = Number(document.documentElement.getAttribute("data-btr-n") || 0) + 1; document.documentElement.setAttribute("data-btr-n", String(n)); u = "e" + n; el.setAttribute("data-btr-uid", u); }
      return u;
    });
    return { handle, uid, info: await handle.evaluate(describeInPage) };
  }

  // ONE sensitive-field check: markSensitiveInPage decides, in the page, for reads,
  // writes, masking and matching alike. Writes only read its verdict.
  const sensitive = (info) => !!info && info.marked === true;

  const irreversibleClick = (info) => {
    const shown = sensitive(info) ? REDACTED : info.text; // a sensitive control's value never goes into a message
    if (info.isSubmit) return `submits a form (${info.formMethod.toUpperCase()} ${info.formAction}) via "${shown}"`;
    if (IRREVERSIBLE.test(info.text) || IRREVERSIBLE.test(info.label)) return `clicks "${shown || info.label}", which looks irreversible`;
    return null;
  };

  async function settle(page) {
    try { await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }); } catch { /* best effort */ }
  }

  const markSensitive = (page) => page.evaluate(markSensitiveInPage, SENSITIVE_NAME.source, SENSITIVE_AUTOCOMPLETE.source);

  async function snapshotText(page, maxLines = 400) {
    await markSensitive(page);
    const s = await page.evaluate(snapshotInPage, maxLines, REDACTED);
    return { url: s.url, title: s.title, snapshot: s.lines.join("\n"), lines: s.lines.length };
  }

  // ---- the one wrapper every page-touching tool goes through ----------------
  //
  // def(name, opts, fn) registers a tool that works on the current page.
  // withPage() then, for EVERY such tool, in this order:
  //   1. refuses if the current page's host is not allowed (no exceptions);
  //   2. runs the shared sensitive-field check (markSensitiveInPage); if it
  //      throws, the tool does not run (fail closed);
  //   3. runs the tool;
  //   4. re-checks the host afterwards, EVEN IF 2 or 3 threw, and if the page
  //      moved off the allow-list, sends it to about:blank (or closes it if
  //      that fails) and returns the refusal instead of the result or error.
  // A tool cannot opt out of 2 to 4. Tools that do not act on the current
  // page are registered with defOther(name, reason, fn) and listed in
  // toolMeta with that reason.
  const PAGE_TOOLS = {};
  const OTHER_TOOLS = {};
  const def = (name, opts, fn) => { PAGE_TOOLS[name] = { opts: opts || {}, fn }; };
  const defOther = (name, reason, fn) => { OTHER_TOOLS[name] = { reason, fn }; };

  async function withPage(name, args) {
    const { opts, fn } = PAGE_TOOLS[name];
    const page = await current();
    const before = checkHost(page.url());
    if (before) return before;
    let out, error;
    try {
      await markSensitive(page);
      out = await fn(page, args || {});
    } catch (e) {
      error = e;
    }
    const after = checkHost(page.url());
    if (after) {
      await page.goto("about:blank").catch(async () => {
        await page.close().catch(() => {});
      });
      return { ...after, reason: after.reason + " (the page moved there during this call; it was sent to about:blank and nothing from it is returned)" };
    }
    if (error) throw error;
    return out;
  }

  const blockedEntry = (id, p) => ({ id, blocked: true, host_not_allowed: (() => { try { return new URL(p.url()).host; } catch { return ""; } })(), selected: p === selected });

  defOther("list_pages", "lists tabs; for a tab on a disallowed host it returns only the id and host, never its URL path or title", async () => {
    await syncPages();
    const out = [];
    for (const [id, p] of pages) {
      if (p.isClosed()) continue;
      out.push(checkHost(p.url()) ? blockedEntry(id, p) : { id, url: p.url(), title: await p.title().catch(() => ""), selected: p === selected });
    }
    return { pages: out };
  });
  defOther("new_page", "opens a new tab; checks the requested URL before and the final URL after redirects", async ({ url }) => {
    const r = checkHost(url); if (r) return r;
    const b = await connection.get();
    const p = await b.newPage();
    const id = track(p);
    selected = p;
    let error;
    try {
      if (url) await p.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs * 2 });
    } catch (e) {
      error = e;
    }
    const after = checkHost(p.url());
    if (after) {
      await p.goto("about:blank").catch(async () => {
        await p.close().catch(() => {});
      });
      return after;
    }
    if (error) throw error;
    return { id, url: p.url() };
  });
  defOther("select_page", "only changes which tab is current; a disallowed tab can be selected (to navigate away or close it) but its URL is not returned, and every page tool refuses it", async ({ id }) => {
    await syncPages();
    const p = pages.get(Number(id));
    if (!p) return { error: `no page ${id}` };
    selected = p;
    await p.bringToFront().catch(() => {});
    return checkHost(p.url()) ? blockedEntry(Number(id), p) : { id: Number(id), url: p.url() };
  });
  defOther("close_page", "closes a tab and returns nothing from it", async ({ id }) => {
    const p = pages.get(Number(id));
    if (!p) return { error: `no page ${id}` };
    await p.close();
    return { closed: Number(id) };
  });

  // navigate gets the normal before-check, so it cannot reload, go back or
  // go forward on a disallowed page, and cannot navigate away from one
  // either: the way out of a disallowed tab is new_page or close_page.
  def("navigate", {}, async (page, { url, action }) => {
    if (action === "back") await page.goBack({ waitUntil: "domcontentloaded" });
    else if (action === "forward") await page.goForward({ waitUntil: "domcontentloaded" });
    else if (action === "reload") await page.reload({ waitUntil: "domcontentloaded" });
    else {
      const r = checkHost(url); if (r) return r;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs * 2 });
    }
    return { url: page.url(), title: await page.title() };
  });
  def("snapshot", {}, (page, { max_lines }) => snapshotText(page, Math.min(Number(max_lines) || 400, 2000)));
  def("screenshot", {}, async (page, { full_page }) => {
    // Sensitive fields are masked for the capture and unmasked afterwards.
    let masked = 0;
    try {
      if (maskScreenshots) masked = await page.evaluate(maskInPage, true);
      if (onCapture) await onCapture(page); // test hook: inspect the page at capture time
      const data = await page.screenshot({ fullPage: !!full_page, encoding: "base64", type: "png" });
      return { image_base64: data, mimeType: "image/png", masked_fields: masked };
    } finally {
      if (maskScreenshots) await page.evaluate(maskInPage, false).catch(() => {});
    }
  });
  def("find", {}, async (page, { text, role }) => {
    const { uid, info } = await resolve(page, { text, role });
    return { uid, ...info, text: sensitive(info) ? REDACTED : info.text };
  });
  def("click", {}, async (page, { uid, selector, text, role, confirm }) => {
    const { handle, uid: u, info } = await resolve(page, { uid, selector, text, role });
    const why = irreversibleClick(info);
    if (why && confirm !== true) return { uid: u, ...confirmNeeded(`This click ${why} on ${page.url()}.`) };
    if (info.href && !info.href.startsWith("#") && !info.href.startsWith("javascript:")) {
      const h = checkHost(new URL(info.href, page.url()).toString()); if (h) return h;
    }
    await handle.click();
    await settle(page);
    return { clicked: u, url: page.url(), title: await page.title() };
  });
  def("fill", {}, async (page, { uid, selector, text, role, value }) => {
    const { handle, uid: u, info } = await resolve(page, { uid, selector, text, role: role || "textbox" });
    if (sensitive(info)) return refuse(`"${info.label || info.ariaLabel || info.name || info.id}" is a password, payment or ID field. Ask the user to type it themselves.`);
    if (info.tag === "select") return { error: "this is a select; use select_option" };
    await handle.evaluate((el) => { el.focus(); if ("value" in el) el.value = ""; });
    await handle.type(String(value ?? ""));
    await handle.evaluate((el) => { el.dispatchEvent(new Event("change", { bubbles: true })); });
    return { filled: u, chars: String(value ?? "").length };
  });
  async function focusedInfo(page) {
    const h = await page.evaluateHandle(() => document.activeElement);
    const isNone = await h.evaluate((el) => !el || el === document.body || el === document.documentElement);
    return isNone ? null : h.asElement().evaluate(describeInPage);
  }
  def("type_text", {}, async (page, { text }) => {
    const info = await focusedInfo(page);
    if (sensitive(info)) return refuse("the focused field is a password, payment or ID field. Ask the user to type it themselves.");
    await page.keyboard.type(String(text));
    return { typed: String(text).length };
  });
  def("press_key", {}, async (page, { key, confirm }) => {
    const info = await focusedInfo(page);
    if (sensitive(info)) return refuse("the focused field is a password, payment or ID field. Ask the user to type it themselves.");
    if (/^(enter|numpadenter|space|spacebar| )$/i.test(key) && info && confirm !== true) {
      if (/^(enter|numpadenter)$/i.test(key) && info.inForm && info.tag !== "textarea")
        return confirmNeeded(`Pressing ${key} here may submit a form on ${page.url()}.`);
      const why = irreversibleClick(info);
      if (why) return confirmNeeded(`Pressing ${key} ${why} on ${page.url()}.`);
    }
    await page.keyboard.press(key);
    await settle(page);
    return { pressed: key, url: page.url() };
  });
  def("select_option", {}, async (page, { uid, selector, text, value }) => {
    const { handle, uid: u, info } = await resolve(page, { uid, selector, text });
    if (info.tag !== "select") return { error: "element is not a select" };
    if (sensitive(info)) return refuse("this is a sensitive field. Ask the user to choose it themselves.");
    const chosen = await handle.evaluate((el, v) => {
      const o = [...el.options].find((x) => x.value === v) || [...el.options].find((x) => x.text.trim().toLowerCase() === String(v).toLowerCase());
      if (!o) return null;
      el.value = o.value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      return o.value;
    }, String(value));
    return chosen == null ? { error: `no option "${value}"` } : { selected: chosen, uid: u };
  });
  def("hover", {}, async (page, { uid, selector, text }) => {
    const { handle, uid: u } = await resolve(page, { uid, selector, text });
    await handle.hover();
    return { hovered: u };
  });
  def("wait_for", {}, async (page, { text, selector, timeout }) => {
    const t = Math.min(Number(timeout) || timeoutMs, 60000);
    if (selector) await page.waitForSelector(selector, { timeout: t });
    else if (text) await page.waitForFunction((s) => document.body && document.body.innerText.includes(s), { timeout: t }, String(text));
    else return { error: "give text or selector" };
    return { found: true, url: page.url() };
  });
  // fields: { name: "css selector" | "css selector@attribute" }, applied
  // within each match of selector/uid. Without fields, returns the text of
  // each match. Sensitive fields are redacted (see readInPage).
  def("extract", {}, async (page, { selector, uid, fields, limit }) => {
    const sel = uid ? `[data-btr-uid="${String(uid).replace(/"/g, "")}"]` : selector;
    if (!sel) return { error: "give selector or uid" };
    const rows = await page.evaluate(readInPage, "extract", { sel, fields: fields || null, limit: Math.min(Number(limit) || 100, 1000) }, REDACTED, SAFE_ATTRS);
    return { count: rows.length, rows };
  });
  // Arbitrary JavaScript can do anything the page can, including typing
  // into fields the other tools refuse, and no pattern check can prove a
  // script read-only. So evaluate is OFF unless the server was started with
  // BTR_ALLOW_EVALUATE=1, and when on, EVERY call needs confirm: true.
  def("evaluate", {}, async (page, { js, confirm }) => {
    if (!allowEvaluate) return refuse("evaluate is disabled. Use get_text, get_attribute, query_all or extract. The user can enable it by starting the server with BTR_ALLOW_EVALUATE=1.");
    if (confirm !== true) {
      const hint = WRITE_JS.test(String(js)) ? " It appears to click, submit, send requests or change values." : "";
      return confirmNeeded(`Run this script on ${page.url()}; a script can read or change anything the page can.${hint} Script: ${String(js).slice(0, 300)}`);
    }
    const value = await page.evaluate(async (code) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const v = await new AsyncFunction(code)();
      try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch { return String(v); }
    }, String(js));
    return { value };
  });
  def("get_text", {}, async (page, { uid, selector, text, role }) => {
    if (!uid && !selector && !text) return { text: await page.evaluate(readInPage, "text", { sel: "body" }, REDACTED, SAFE_ATTRS) };
    const { uid: u } = await resolve(page, { uid, selector, text, role });
    return { uid: u, text: await page.evaluate(readInPage, "text", { sel: `[data-btr-uid="${u}"]` }, REDACTED, SAFE_ATTRS) };
  });
  def("get_attribute", {}, async (page, { uid, selector, text, role, name }) => {
    if (!name) return { error: "give the attribute name" };
    const { uid: u } = await resolve(page, { uid, selector, text, role });
    return { uid: u, name, value: await page.evaluate(readInPage, "attr", { sel: `[data-btr-uid="${u}"]`, name: String(name) }, REDACTED, SAFE_ATTRS) };
  });
  def("query_all", {}, async (page, { selector, limit, attributes }) => {
    if (!selector) return { error: "give a selector" };
    const rows = await page.evaluate(readInPage, "query", { sel: String(selector), limit: Math.min(Number(limit) || 100, 1000), attributes: Array.isArray(attributes) ? attributes : [] }, REDACTED, SAFE_ATTRS);
    return { count: rows.length, rows };
  });
  def("upload_file", {}, async (page, { uid, selector, path: file }) => {
    if (!file || !fs.existsSync(file)) return { error: `file not found: ${file}` };
    const { handle, uid: u, info } = await resolve(page, { uid, selector });
    if (!(info.tag === "input" && info.type === "file")) return { error: "element is not a file input" };
    await handle.uploadFile(path.resolve(file));
    return { uploaded: path.basename(file), uid: u };
  });
  def("get_network", {}, async (page, { filter, limit }) => {
    let rows = netLog.get(page) || [];
    if (filter) rows = rows.filter((x) => x.url.includes(filter));
    return { requests: rows.slice(-(Math.min(Number(limit) || 50, 300))) };
  });
  def("get_console", {}, async (page, { limit }) => ({ messages: (conLog.get(page) || []).slice(-(Math.min(Number(limit) || 50, 300))) }));

  // Public API: every tool, wrapped with error handling and audit logging.
  const api = {};
  const wrapAudit = (name, run) => async (args = {}) => {
    let result;
    try { result = await run(args || {}); } catch (e) { result = { error: String((e && e.message) || e) }; }
    audit(name, args, result);
    return result;
  };
  for (const name of Object.keys(PAGE_TOOLS)) api[name] = wrapAudit(name, (args) => withPage(name, args));
  for (const [name, t] of Object.entries(OTHER_TOOLS)) api[name] = wrapAudit(name, t.fn);

  // Steps: [{ tool: "navigate", args: {...} }, ...]. An argument may be
  // { "use": "step2.uid" } to take a value from an earlier step's result
  // (steps are numbered from 1). A step that needs confirmation always stops
  // the plan, whatever stop_on_error says.
  const runPlan = async ({ steps, stop_on_error = true, snapshot_lines = 60 } = {}) => {
    if (!Array.isArray(steps) || !steps.length) return { error: "steps must be a non-empty array" };
    if (steps.length > 50) return { error: "at most 50 steps per plan" };
    const results = [];
    const lookup = (ref) => {
      const m = String(ref).match(/^step(\d+)\.(.+)$/);
      if (!m) throw new Error(`bad reference "${ref}"`);
      const r = results[Number(m[1]) - 1];
      if (!r) throw new Error(`reference to step ${m[1]}, which has not run`);
      return m[2].split(".").reduce((o, k) => (o == null ? o : o[k]), r.result);
    };
    const resolveArgs = (a) => {
      const out = {};
      for (const [k, v] of Object.entries(a || {})) out[k] = v && typeof v === "object" && !Array.isArray(v) && "use" in v ? lookup(v.use) : v;
      return out;
    };
    let stopped = null;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {};
      if (s.tool === "run_plan" || !api[s.tool]) { results.push({ step: i + 1, tool: s.tool, result: { error: `unknown tool "${s.tool}"` } }); if (stop_on_error) { stopped = "error"; break; } continue; }
      let result;
      try { result = await api[s.tool](resolveArgs(s.args)); } catch (e) { result = { error: e.message }; }
      if (result && result.image_base64) result = { ...result, image_base64: `(${result.image_base64.length} base64 chars omitted in plans)` };
      results.push({ step: i + 1, tool: s.tool, result });
      if (result && result.needs_confirmation) { stopped = "needs_confirmation"; break; }
      if (result && (result.error || result.refused) && stop_on_error) { stopped = result.refused ? "refused" : "error"; break; }
    }
    let final = null;
    try { const page = await current(); if (!checkHost(page.url())) final = await snapshotText(page, snapshot_lines); } catch { /* no page */ }
    return { completed: results.length === steps.length && !stopped, stopped_at: stopped ? results.length : null, stop_reason: stopped, steps: results, final_snapshot: final };
  };

  // run_plan is audited as a whole (its fill/type_text values redacted per step), and each step is audited again by its own tool.
  api.run_plan = wrapAudit("run_plan", runPlan);

  api.toolMeta = {
    ...Object.fromEntries(Object.keys(PAGE_TOOLS).map((n) => [n, { via: "withPage" }])),
    ...Object.fromEntries(Object.entries(OTHER_TOOLS).map(([n, t]) => [n, { via: "other", reason: t.reason }])),
    run_plan: { via: "other", reason: "runs other tools through this API, so each step goes through withPage; its final snapshot is taken only on an allowed host" },
  };
  api.allowHosts = allowHosts;
  api.evaluateEnabled = allowEvaluate;
  return api;
}

module.exports = { createBrowserController, parseAllowHosts, hostAllowed, IRREVERSIBLE, SENSITIVE_NAME, SENSITIVE_AUTOCOMPLETE, REDACTED, WRITE_JS };
