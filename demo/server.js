#!/usr/bin/env node
// Demo admin app: a fake review-moderation queue that the demo skill and the
// tests run against. Dependency-free (Node http only). All state is in memory
// and resets when the process restarts; nothing leaves this machine.
//
//   node demo/server.js            # http://127.0.0.1:8790
//   DEMO_PORT=9000 node demo/server.js
//
// Pages
//   GET  /                     queue list (HTML)
//   GET  /items/:id            one review, with Approve / Reject forms
//   POST /items/:id/approve    form: csrf, note
//   POST /items/:id/reject     form: csrf, note
//   GET  /api/items?status=    JSON list
//   GET  /contact              a contact form (used by the browser-control tests)
//   POST /contact              records the message in memory
//   GET  /api/messages         messages received by /contact
//   GET  /payment              a form prefilled with FAKE card and ID values (tests redaction)
//   POST /reset                restore the seed data
//   GET  /items/r1, /redirect-offsite   redirect off-host (to test redirect handling)
//   GET  /items/r2             redirects to /items/101 on the same host
//   GET  /leave, /leave-later, /redirect-local, /arrived   pages that move the
//        browser from 127.0.0.1 to localhost (tests the after-call host check)

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.DEMO_PORT || 8790);
const CSRF = crypto.randomBytes(12).toString("hex");

const SEED = [
  { id: "101", author: "Asha", rating: 5, text: "Arrived quickly and works exactly as described." },
  { id: "102", author: "Ben", rating: 1, text: "BUY CHEAP FOLLOWERS at spam-example.test !!!" },
  { id: "103", author: "Chen", rating: 4, text: "Good value. The strap feels a little thin." },
  { id: "104", author: "Dana", rating: 2, text: "Stopped charging after a week & support was slow." },
  { id: "105", author: "Eli", rating: 3, text: "My order number is 55-1234, please call me on 555 0100." },
  { id: "106", author: "Femi", rating: 5, text: "Second one I have bought. Still great." },
];
let items, messages;
function reset() {
  items = new Map(SEED.map((s) => [s.id, { ...s, status: "pending", note: "", decidedAt: null }]));
  messages = [];
}
reset();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}
.s-approved{color:#1a7f37}.s-rejected{color:#cf222e}.s-pending{color:#9a6700}
blockquote{background:#f6f8fa;padding:12px;margin:12px 0}form{display:inline-block;margin-right:8px}
label{display:block;margin-top:10px}input,textarea{width:100%;padding:6px}</style></head>
<body><nav><a href="/">Review queue</a> | <a href="/contact">Contact</a></nav>${body}</body></html>`;

function send(res, code, body, type = "text/html; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function readForm(req) {
  return new Promise((ok) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) { try { return ok(JSON.parse(d)); } catch { return ok({}); } }
      ok(Object.fromEntries(new URLSearchParams(d)));
    });
  });
}

function listPage() {
  const rows = [...items.values()].map((i) => `<tr><td><a href="/items/${i.id}">#${i.id}</a></td><td>${esc(i.author)}</td>
<td>${i.rating}/5</td><td class="s-${i.status}">${i.status}</td></tr>`).join("");
  return page("Review queue", `<h1>Review queue</h1><table><tr><th>ID</th><th>Author</th><th>Rating</th><th>Status</th></tr>${rows}</table>`);
}

function itemPage(i) {
  const forms = i.status === "pending"
    ? `<form method="post" action="/items/${i.id}/approve"><input type="hidden" name="csrf" value="${CSRF}">
<input type="hidden" name="note" value=""><button type="submit">Approve</button></form>
<form method="post" action="/items/${i.id}/reject"><input type="hidden" name="csrf" value="${CSRF}">
<input type="hidden" name="note" value=""><button type="submit">Reject</button></form>`
    : `<p>Decided ${esc(i.decidedAt)}${i.note ? " - note: " + esc(i.note) : ""}</p>`;
  return page(`Review ${i.id}`, `<main data-item-id="${i.id}" data-status="${i.status}">
<h1>Review #${i.id}</h1><p>Author: <span id="author">${esc(i.author)}</span> | Rating: <span id="rating">${i.rating}</span>/5 |
Status: <b class="s-${i.status}">${i.status}</b></p>
<blockquote id="review-body">${esc(i.text)}</blockquote>${forms}</main>`);
}

const contactPage = (sent) => page("Contact", `<h1>Contact support</h1>${sent ? '<p id="sent">Thanks, your message was received.</p>' : ""}
<form method="post" action="/contact" id="contact">
<label for="name">Your name</label><input id="name" name="name">
<label for="email">Email</label><input id="email" name="email" type="email">
<label for="password">Account password</label><input id="password" name="password" type="password" autocomplete="current-password">
<label for="topic">Topic</label><select id="topic" name="topic"><option value="general">General</option><option value="billing">Billing</option><option value="bug">Bug report</option></select>
<label for="message">Message</label><textarea id="message" name="message"></textarea>
<p><button type="submit">Send message</button></p></form>`);

// Fake values only (a published test card number and made-up IDs). The read
// tools must never return them.
const paymentPage = () => page("Payment", `<h1>Payment details</h1>
<form method="post" action="/payment" id="payment">
<label for="ref">Order reference</label><input id="ref" name="ref" value="ORD-2026-0042">
<label for="ccname">Name on card</label><input id="ccname" name="ccname" autocomplete="cc-name" value="Test Holder">
<label for="cardnumber">Card number</label><input id="cardnumber" name="cardnumber" autocomplete="cc-number" inputmode="numeric" value="4111 1111 1111 1111">
<label for="cvc">CVC</label><input id="cvc" name="cvc" value="737">
<label for="natid">National ID number</label><input id="natid" name="national_id" value="ZZ-998877-Q">
<label for="pw">Password</label><input id="pw" name="pw" type="password" value="demo-secret-pw">
<label for="notes">Card notes</label><textarea id="notes" name="card_number_notes">card-note-5555</textarea>
<p>Saved card (no visible label): <input id="ariacard" aria-label="Card number" value="5500 0000 0000 0004"></p>
<p><input type="button" id="cardbtn" aria-label="Card number" value="4111 1111 1111 1111"></p>
<p><button type="submit">Pay now</button></p></form>`);

const stats = { posts: 0 }; // counts every POST received (tests use it to prove reads never POST)

const server = http.createServer(async (req, res) => {
  if (req.method === "POST") stats.posts++;
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  let m;
  if (req.method === "GET" && p === "/") return send(res, 200, listPage());
  if (req.method === "GET" && p === "/health") return send(res, 200, JSON.stringify({ ok: true, app: "demo" }), "application/json");
  if (req.method === "GET" && p === "/api/items") {
    const st = u.searchParams.get("status");
    const list = [...items.values()].filter((i) => !st || i.status === st);
    return send(res, 200, JSON.stringify({ items: list }), "application/json");
  }
  if (req.method === "GET" && (p === "/items/r1" || p === "/redirect-offsite")) {
    res.writeHead(302, { Location: "https://example.com/stolen" }); return res.end();
  }
  // 127.0.0.1 and localhost are the same server but different hosts, which
  // lets the tests move a page off an allow-list containing only 127.0.0.1.
  const localhost = `http://localhost:${(req.headers.host || "").split(":")[1] || PORT}`;
  if (req.method === "GET" && p === "/redirect-local") { res.writeHead(302, { Location: localhost + "/arrived" }); return res.end(); }
  if (req.method === "GET" && p === "/arrived") return send(res, 200, page("Arrived", "<h1>Arrived here</h1><p>private-page-text-77</p>"));
  if (req.method === "GET" && p === "/leave") return send(res, 200, page("Leave", `<h1>Leave</h1>
<p><a id="leave-link" href="/redirect-local">Next page</a></p>
<p><button id="leave-btn" type="button" onclick="location.href='${localhost}/arrived'">Show more</button></p>`));
  if (req.method === "GET" && p === "/leave-later") return send(res, 200, page("Leave later", `<h1>Wait</h1><script>setTimeout(()=>{location.href='${localhost}/arrived'},300)</script>`));
  if (req.method === "GET" && p === "/sensitive-submit") return send(res, 200, page("Confirm", `<h1>Confirm</h1>
<form method="post" action="/contact"><input type="submit" name="card_number_confirm" value="Pay with 4111 1111 1111 1111"></form>`));
  if (req.method === "GET" && p === "/redirect-slow") { res.writeHead(302, { Location: localhost + "/slow" }); return res.end(); }
  // Commits a page on localhost, then never finishes loading.
  if (req.method === "GET" && p === "/slow") { res.writeHead(200, { "Content-Type": "text/html" }); res.write("<!doctype html><html><head><title>Slow</title></head><body><p>slow-private-text"); return; }
  // A page whose script breaks the DOM API the sensitive-field check uses.
  if (req.method === "GET" && p === "/hostile-dom") return send(res, 200, page("Hostile", `<h1>Hostile</h1>
<label for="card">Card number</label><input id="card" name="cardnumber" value="4111 1111 1111 1111">
<script>Document.prototype.querySelectorAll = function () { throw new Error("querySelectorAll disabled by page"); };</script>`));
  if (req.method === "GET" && p === "/items/r2") { res.writeHead(302, { Location: "/items/101" }); return res.end(); }
  if (req.method === "POST" && (m = p.match(/^\/items\/(\w+)\/redirect-offsite$/))) {
    res.writeHead(303, { Location: "https://example.com/after-post" }); return res.end();
  }
  if (req.method === "GET" && (m = p.match(/^\/items\/(\w+)$/))) {
    const i = items.get(m[1]);
    return i ? send(res, 200, itemPage(i)) : send(res, 404, page("Not found", "<h1>No such item</h1>"));
  }
  if (req.method === "POST" && (m = p.match(/^\/items\/(\w+)\/(approve|reject)$/))) {
    const i = items.get(m[1]);
    if (!i) return send(res, 404, page("Not found", "<h1>No such item</h1>"));
    const f = await readForm(req);
    if (f.csrf !== CSRF) return send(res, 403, page("Forbidden", "<h1>Bad or missing CSRF token</h1>"));
    if (i.status !== "pending") return send(res, 409, page("Conflict", `<h1>Item ${i.id} is already ${i.status}</h1>`));
    i.status = m[2] === "approve" ? "approved" : "rejected";
    i.note = String(f.note || "").slice(0, 500);
    i.decidedAt = new Date().toISOString();
    console.log(`[demo] item ${i.id} -> ${i.status}${i.note ? " (" + i.note + ")" : ""}`);
    return send(res, 200, itemPage(i));
  }
  if (req.method === "GET" && p === "/contact") return send(res, 200, contactPage(false));
  if (req.method === "GET" && p === "/payment") return send(res, 200, paymentPage());
  if (req.method === "POST" && p === "/contact") {
    const f = await readForm(req);
    delete f.password; // never stored
    messages.push({ ...f, at: new Date().toISOString() });
    return send(res, 200, contactPage(true));
  }
  if (req.method === "GET" && p === "/api/messages") return send(res, 200, JSON.stringify({ messages }), "application/json");
  if (req.method === "POST" && p === "/reset") { reset(); return send(res, 200, JSON.stringify({ ok: true }), "application/json"); }
  send(res, 404, page("Not found", "<h1>Not found</h1>"));
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => console.log(`[demo] review queue on http://127.0.0.1:${PORT}`));
}
module.exports = { server, reset, PORT, stats };
