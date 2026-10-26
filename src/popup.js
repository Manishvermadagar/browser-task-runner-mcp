// Status-only popup: is the bridge up, and what is happening right now.
// Runs are started by the bridge command-line tools or an MCP client.

const BRIDGE = "http://127.0.0.1:8777";
const $ = (id) => document.getElementById(id);
let TOKEN = "";

chrome.storage.local.get(["bridgeToken", "allowHosts"]).then(({ bridgeToken, allowHosts }) => {
  TOKEN = bridgeToken || "";
  $("token").value = TOKEN;
  $("hosts").value = (allowHosts || []).join(", ");
  $("dash").href = BRIDGE + "/#token=" + encodeURIComponent(TOKEN);
});

$("save").addEventListener("click", async (e) => {
  e.preventDefault();
  TOKEN = $("token").value.trim();
  const hosts = $("hosts").value.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  await chrome.storage.local.set({ bridgeToken: TOKEN, allowHosts: hosts });
  $("dash").href = BRIDGE + "/#token=" + encodeURIComponent(TOKEN);
  $("save").textContent = "Saved";
});

async function tick() {
  try {
    const h = await (await fetch(BRIDGE + "/health", { cache: "no-store" })).json();
    $("bridge").textContent = "up :" + h.port;
    $("bridge").className = "ok";
  } catch {
    $("bridge").textContent = "offline";
    $("bridge").className = "bad";
    $("now").textContent = "bridge not running - start it with: npm run bridge";
    return;
  }
  try {
    if (!TOKEN) { $("now").textContent = "not paired - paste the bridge token above"; return; }
    const r = await fetch(BRIDGE + "/activity", { cache: "no-store", headers: { "X-BTR-Token": TOKEN } });
    if (r.status === 401) { $("now").textContent = "token rejected - check it against .btr-token"; return; }
    const a = await r.json();
    $("count").textContent = a.total;
    const last = a.entries[a.entries.length - 1];
    $("now").textContent = "";
    if (!last) { $("now").textContent = "idle - no activity yet"; return; }
    const head = document.createElement("span");
    head.className = "acc";
    head.textContent = `${last.phase || ""} ${last.id || ""} ${last.status || ""}`;
    const det = document.createElement("div");
    det.className = "k";
    det.textContent = (last.detail || "").slice(0, 110);
    $("now").append(head, det);
  } catch {}
}
tick();
setInterval(tick, 1500);
