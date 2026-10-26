// Skill loading, validation, templating and field extraction.
//
// A skill is pure data: src/skills/<id>/skill.json plus a line in
// src/skills/registry.json. Nothing in the engine knows what any skill's
// fields or actions mean.

const fs = require("fs");
const path = require("path");

const SAFETY_DEFAULTS = {
  rateLimitMs: 800,
  maxConsecutiveErrors: 3,
  maxBatch: 50,
  stagedRollout: [1, 5, 20],
};

function skillsDir(root) {
  return path.join(root, "src", "skills");
}

function loadRegistry(root) {
  return JSON.parse(fs.readFileSync(path.join(skillsDir(root), "registry.json"), "utf8"));
}

function loadSkill(root, id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id))) throw new Error(`invalid skill id "${id}"`);
  if (!loadRegistry(root).includes(id)) throw new Error(`skill "${id}" is not listed in src/skills/registry.json`);
  const skill = JSON.parse(fs.readFileSync(path.join(skillsDir(root), id, "skill.json"), "utf8"));
  const errors = validateSkill(skill);
  if (errors.length) throw new Error(`skill "${id}" is invalid:\n  - ${errors.join("\n  - ")}`);
  skill.safety = { ...SAFETY_DEFAULTS, ...(skill.safety || {}) };
  return skill;
}

function validateSkill(skill) {
  const e = [];
  if (!skill || typeof skill !== "object") return ["skill.json is not an object"];
  if (!skill.id) e.push("missing id");
  if (!/^https?:\/\/[^/]+$/.test(skill.baseUrl || "")) e.push("baseUrl must be an origin like https://admin.example.com (no trailing slash or path)");
  if (!skill.read || !skill.read.urlTemplate) e.push("missing read.urlTemplate");
  if (!Array.isArray(skill.read && skill.read.extract)) e.push("read.extract must be an array");
  // Reads, lists and verification are read-only by construction: the engine
  // always sends GET for them, and a skill that asks for anything else is
  // rejected rather than silently changed.
  if (skill.read && skill.read.method !== undefined && String(skill.read.method).toUpperCase() !== "GET") e.push(`read.method must be GET (got "${skill.read.method}"); reads never change anything. Put writes in actions.`);
  if (skill.list && skill.list.method !== undefined && String(skill.list.method).toUpperCase() !== "GET") e.push(`list.method must be GET (got "${skill.list.method}")`);
  for (const [v, rule] of Object.entries(skill.verify || {})) if (rule && rule.method !== undefined && String(rule.method).toUpperCase() !== "GET") e.push(`verify.${v}.method must be GET`);
  const names = new Set(((skill.read && skill.read.extract) || []).map((r) => r.name));
  for (const r of (skill.read && skill.read.extract) || []) {
    if (!r.name) e.push("an extract rule has no name");
    if (!["regex", "regexAttr", "jsonPath"].includes(r.type)) e.push(`extract "${r.name}": unknown type "${r.type}"`);
  }
  for (const n of (skill.read && skill.read.requiredExtract) || []) if (!names.has(n)) e.push(`requiredExtract "${n}" has no extract rule`);
  const g = skill.read && skill.read.identityGuard;
  if (g && !names.has(g.mustEqualExtract)) e.push(`identityGuard.mustEqualExtract "${g.mustEqualExtract}" has no extract rule`);
  if (!skill.actions || typeof skill.actions !== "object") e.push("missing actions");
  if (!skill.actionOrder || typeof skill.actionOrder !== "object") e.push("missing actionOrder");
  for (const [verdict, order] of Object.entries(skill.actionOrder || {})) {
    if (!Array.isArray(order)) { e.push(`actionOrder.${verdict} must be an array`); continue; }
    for (const a of order) if (!(skill.actions || {})[a]) e.push(`actionOrder.${verdict} names unknown action "${a}"`);
  }
  for (const [name, a] of Object.entries(skill.actions || {})) {
    if (!a.urlTemplate) e.push(`action "${name}": missing urlTemplate`);
    if (!["form", "json", "none"].includes(a.bodyType || "none")) e.push(`action "${name}": bodyType must be form, json or none`);
  }
  for (const [verdict, rule] of Object.entries(skill.verify || {})) {
    if (!(skill.actionOrder || {})[verdict]) e.push(`verify.${verdict} refers to a verdict not in actionOrder`);
    if (!rule.expectStatus && !names.has(rule.extract)) e.push(`verify.${verdict}.extract "${rule.extract}" has no extract rule`);
  }
  return e;
}

// ---- templating ----------------------------------------------------------
// "{name}" alone returns the raw value (keeps its type); "{name}" inside a
// longer string is stringified. Values substituted into URL templates are
// URI-encoded so an item id can never change the path it is sent to.

const VAR = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function resolveTemplate(str, vars, { uri = false } = {}) {
  if (typeof str !== "string") return str;
  const whole = str.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
  if (whole && !uri) return vars[whole[1]] === undefined || vars[whole[1]] === null ? "" : vars[whole[1]];
  return str.replace(VAR, (_, k) => {
    const v = vars[k] === undefined || vars[k] === null ? "" : String(vars[k]);
    return uri ? encodeURIComponent(v) : v;
  });
}

function resolveFields(obj, vars) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = resolveTemplate(v, vars);
  return out;
}

function resolveUrl(skill, tpl, vars) {
  return skill.baseUrl + resolveTemplate(tpl, vars, { uri: true });
}

// Builds the concrete HTTP request for one action without sending it.
// Same-origin is enforced here: an action can only ever target the skill's
// own baseUrl.
function buildRequest(skill, actionName, vars) {
  const a = skill.actions[actionName];
  if (!a) throw new Error(`unknown action "${actionName}"`);
  for (const r of a.requiredVars || []) {
    if (vars[r] === undefined || vars[r] === null || vars[r] === "") {
      throw new Error(`action "${actionName}": required var "${r}" is missing; refusing to send an incomplete request`);
    }
  }
  const url = resolveUrl(skill, a.urlTemplate, vars);
  if (new URL(url).origin !== new URL(skill.baseUrl).origin) throw new Error(`action "${actionName}" resolved outside the skill origin`);
  const fields = resolveFields(a.fields, vars);
  const headers = resolveFields(a.headers, vars);
  let body;
  const type = a.bodyType || "none";
  if (type === "json") { body = JSON.stringify(fields); headers["Content-Type"] = "application/json"; }
  else if (type === "form") { body = new URLSearchParams(fields).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
  return { url, method: a.method || "POST", headers, body };
}

// ---- extraction ----------------------------------------------------------

function decodeEntities(s) {
  return s.replace(/&nbsp;|&#160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
}

function jsonPath(obj, p) {
  return String(p).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Returns { <name>: raw value, <name>Decoded: decoded value (only for rules
// with decodeHtmlEntities) }. Raw is what you write back to a server;
// Decoded is what you read and review. Keeping both, under distinct names,
// stops a caller comparing one form against the other by accident.
// A missing value is null, never "", so "absent" and "empty" stay distinct.
function extractFields(text, skill) {
  const out = {};
  let parsed;
  for (const rule of skill.read.extract) {
    let v = null;
    if (rule.type === "regex") {
      const m = text.match(new RegExp(rule.pattern, rule.flags || "i"));
      v = m ? m[rule.group == null ? 0 : rule.group] : null;
    } else if (rule.type === "regexAttr") {
      const t = text.match(new RegExp(rule.tagPattern, "i"));
      if (t) {
        const a = t[0].match(new RegExp(rule.attr + '="([^"]*)"', "i"));
        v = a ? a[1] : null;
      }
    } else if (rule.type === "jsonPath") {
      if (parsed === undefined) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
      const got = parsed == null ? undefined : jsonPath(parsed, rule.path);
      v = got === undefined ? null : typeof got === "object" ? JSON.stringify(got) : String(got);
    }
    out[rule.name] = v;
    if (rule.decodeHtmlEntities) out[rule.name + "Decoded"] = v == null ? null : decodeEntities(v);
  }
  return out;
}

module.exports = {
  SAFETY_DEFAULTS, loadRegistry, loadSkill, validateSkill,
  resolveTemplate, resolveFields, resolveUrl, buildRequest,
  extractFields, decodeEntities,
};
