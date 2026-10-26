// One shared Chrome DevTools Protocol connection, used by both the batch
// transport (engine/transports.js) and the general browser tools
// (engine/browser.js).
//
// The connection options mirror chrome-devtools-mcp (Apache-2.0, see
// NOTICE.md): attach with browserURL (http://127.0.0.1:9222), a WebSocket
// endpoint, or the DevToolsActivePort file in a profile directory; or launch
// a browser from an executable path.

const fs = require("fs");
const path = require("path");

function readDevToolsActivePort(userDataDir) {
  const txt = fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8");
  const [port, wsPath] = txt.split("\n").map((l) => l.trim()).filter(Boolean);
  const n = parseInt(port, 10);
  if (!wsPath || !(n > 0 && n < 65536)) throw new Error(`invalid DevToolsActivePort in ${userDataDir}`);
  return `ws://127.0.0.1:${n}${wsPath}`;
}

// Common install locations, used only when a launch is requested without an
// explicit path (and by the tests to find a browser).
function findChromium() {
  const c = process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ] : process.platform === "win32" ? [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave-browser", "/snap/bin/chromium"];
  return c.find((p) => fs.existsSync(p)) || null;
}

function connectBrowser(opts = {}) {
  let browser = null;
  let launched = false;
  let pending = null;

  async function open() {
    const puppeteer = require("puppeteer-core");
    const base = { defaultViewport: null };
    if (opts.launch) {
      const executablePath = opts.executablePath || findChromium();
      if (!executablePath) throw new Error("no Chromium-based browser found; set BTR_CHROME_PATH");
      const args = ["--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble"];
      browser = await puppeteer.launch({ ...base, executablePath, userDataDir: opts.userDataDir, headless: !!opts.headless, args });
      launched = true;
    } else if (opts.wsEndpoint) {
      browser = await puppeteer.connect({ ...base, browserWSEndpoint: opts.wsEndpoint });
    } else if (opts.browserUrl) {
      browser = await puppeteer.connect({ ...base, browserURL: opts.browserUrl });
    } else if (opts.userDataDir) {
      browser = await puppeteer.connect({ ...base, browserWSEndpoint: readDevToolsActivePort(opts.userDataDir) });
    } else {
      throw new Error("no browser configured: set BTR_BROWSER_URL (e.g. http://127.0.0.1:9222), BTR_WS_ENDPOINT, BTR_USER_DATA_DIR or BTR_CHROME_PATH");
    }
    return browser;
  }

  return {
    async get() {
      if (browser && browser.connected) return browser;
      if (!pending) pending = open().finally(() => { pending = null; });
      return pending;
    },
    async close() {
      if (!browser) return;
      const b = browser; browser = null;
      if (launched) await b.close(); else await b.disconnect();
    },
  };
}

module.exports = { connectBrowser, readDevToolsActivePort, findChromium };
