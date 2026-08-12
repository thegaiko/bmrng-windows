const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const isWin = process.platform === "win32";
const API = "https://bmrng.app";

// ── расположение вшитых инструментов ────────────────────────────
function resDir() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}
function firstExisting(paths) {
  return paths.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}
function ipatoolPath() {
  return firstExisting([
    path.join(resDir(), "vendor", isWin ? "ipatool.exe" : "ipatool"),
    "/opt/homebrew/bin/ipatool", "/usr/local/bin/ipatool",
  ]) || (isWin ? "ipatool.exe" : "ipatool");
}
function pythonBase() {
  const bundled = path.join(resDir(), "vendor", "python", isWin ? "python.exe" : "bin/python3");
  const cmd = firstExisting([
    bundled,
    path.join(os.homedir(), ".local/python-3.12.13/bin/python3"),
    "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3",
  ]) || (isWin ? "python" : "python3");
  return { cmd, pre: ["-m", "pymobiledevice3"] };
}

// ── запуск процессов ────────────────────────────────────────────
function run(cmd, args, { env = {}, onData } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env } }); }
    catch (e) { return resolve({ code: -1, out: String(e) }); }
    let out = "";
    const cap = (d) => { const s = d.toString(); out += s; if (onData) onData(s); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (e) => resolve({ code: -1, out: String(e) }));
  });
}
function lastJSON(text) {
  let obj = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("{")) { try { obj = JSON.parse(t); } catch {} }
  }
  return obj;
}

// ── конфиг (токен bmrng) ────────────────────────────────────────
function cfgPath() { return path.join(app.getPath("userData"), "config.json"); }
function cfgGet() { try { return JSON.parse(fs.readFileSync(cfgPath(), "utf8")); } catch { return {}; } }
function cfgSet(patch) { const c = { ...cfgGet(), ...patch }; fs.writeFileSync(cfgPath(), JSON.stringify(c)); return c; }

// ── каталог ─────────────────────────────────────────────────────
function catalog() {
  // apps.json упакован в app.asar → читаем от __dirname, не из resourcesPath
  const p = path.join(__dirname, "apps.json");
  try {
    const apps = JSON.parse(fs.readFileSync(p, "utf8")).apps || [];
    return apps.map((a) => ({
      key: a.key, name: a.name, logo: a.logo || null, note: a.note || "",
      appIDs: a.app_ids || (a.app_id ? [a.app_id] : []),
      bundleID: a.bundle_id || null,
    }));
  } catch { return []; }
}
function selectors(app) {
  if (app.appIDs && app.appIDs.length) return app.appIDs.map((id) => ["-i", String(id)]);
  if (app.bundleID) return [["-b", app.bundleID]];
  return [];
}

// ── IPC: устройства / Apple ID ──────────────────────────────────
ipcMain.handle("devices", async () => {
  const py = pythonBase();
  const r = await run(py.cmd, [...py.pre, "usbmux", "list"]);
  try {
    const arr = JSON.parse(r.out.trim());
    const seen = new Set(); const list = [];
    for (const d of arr) {
      if (d.ConnectionType !== "USB") continue;
      const udid = d.Identifier || d.SerialNumber;
      if (udid && !seen.has(udid)) { seen.add(udid); list.push({ udid, name: d.DeviceName || "iPhone" }); }
    }
    return list;
  } catch { return []; }
});

ipcMain.handle("account-info", async () => {
  const r = await run(ipatoolPath(), ["auth", "info", "--format", "json", "--non-interactive"]);
  const o = lastJSON(r.out);
  if (o && o.success && (o.name || o.email)) return o.name || o.email;
  return null;
});

ipcMain.handle("account-login", async (_e, { email, password, code }) => {
  const args = ["auth", "login", "-e", email, "-p", password, "--format", "json", "--non-interactive"];
  if (code) args.push("--auth-code", code);
  const r = await run(ipatoolPath(), args);
  const low = r.out.toLowerCase();
  if (r.code === 0 || (lastJSON(r.out) || {}).success) return { ok: true };
  if (low.includes("code is required") || low.includes("2fa") || low.includes("auth-code"))
    return { ok: false, needCode: true };
  return { ok: false, error: (lastJSON(r.out) || {}).error || "Не удалось войти" };
});

ipcMain.handle("account-logout", async () => { await run(ipatoolPath(), ["auth", "revoke"]); return true; });

ipcMain.handle("catalog", async () => catalog());

// ── IPC: проверка покупок ───────────────────────────────────────
async function probeOne(key, selector) {
  const tool = ipatoolPath();
  const tmp = path.join(os.tmpdir(), `.probe_${key}.ipa`);
  const tmp2 = tmp + ".tmp";
  [tmp, tmp2].forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  return new Promise((resolve) => {
    const child = spawn(tool, ["download", ...selector, "-o", tmp, "--format", "json", "--non-interactive"],
      { env: { ...process.env } });
    let out = ""; let started = false;
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const t0 = Date.now();
    const iv = setInterval(() => {
      let sz = 0;
      for (const f of [tmp, tmp2]) { try { sz += fs.statSync(f).size; } catch {} }
      if (sz > 200000) { started = true; try { child.kill(); } catch {} }
      if (Date.now() - t0 > 30000) { try { child.kill(); } catch {} }
    }, 250);
    child.on("close", () => {
      clearInterval(iv);
      [tmp, tmp2].forEach((f) => { try { fs.unlinkSync(f); } catch {} });
      const low = out.toLowerCase();
      if (started || low.replace(/\s/g, "").includes('"success":true')) return resolve("owned");
      if (low.includes("license is required")) return resolve("notOwned");
      if (low.includes("temporarily unavailable") || low.includes("not available") || low.includes("not found"))
        return resolve("unavailable");
      resolve("unknown");
    });
    child.on("error", () => { clearInterval(iv); resolve("unknown"); });
  });
}
ipcMain.handle("check-owned", async (_e, app) => {
  const sels = selectors(app);
  if (!sels.length) return "unknown";
  let worst = app.appIDs && app.appIDs.length ? "notOwned" : "needID";
  for (const s of sels) {
    const st = await probeOne(app.key, s);
    if (st === "owned") return "owned";
    if (st === "notOwned") worst = "notOwned";
    else if (st === "unavailable" && worst !== "notOwned") worst = "unavailable";
  }
  return worst;
});

// ── IPC: установка (с прогрессом) ───────────────────────────────
ipcMain.handle("install", async (e, { app, udid }) => {
  const tool = ipatoolPath(); const py = pythonBase();
  const send = (m) => e.sender.send("install-progress", m);
  const ipa = path.join(os.tmpdir(), `${app.key}.ipa`);
  try { fs.unlinkSync(ipa); } catch {}

  send({ phase: "download", app: app.name, line: `Скачивание «${app.name}»…` });
  const sels = selectors(app); let ok = false; let lastOut = "";
  for (let i = 0; i < sels.length; i++) {
    const sel = sels[i];
    if (sels.length > 1) send({ line: `Вариант ${i + 1}/${sels.length}…` });
    let r = await run(tool, ["download", ...sel, "-o", ipa, "--format", "json", "--non-interactive"]);
    lastOut = r.out;
    if (fs.existsSync(ipa) && (lastJSON(r.out) || {}).success) { ok = true; break; }
    if (r.out.toLowerCase().includes("license is required")) {
      send({ line: "Приобретаю лицензию…" });
      r = await run(tool, ["download", ...sel, "-o", ipa, "--purchase", "--format", "json", "--non-interactive"]);
      lastOut = r.out;
      if (fs.existsSync(ipa) && (lastJSON(r.out) || {}).success) { ok = true; break; }
    }
    try { fs.unlinkSync(ipa); } catch {}
  }
  if (!ok) {
    const err = (lastJSON(lastOut) || {}).error || "не удалось скачать";
    send({ phase: "error", line: `✗ ${err}` });
    return { ok: false, error: err };
  }
  send({ phase: "install", progress: 0, line: "Устанавливаю на iPhone…" });
  const ir = await run(py.cmd, [...py.pre, "apps", "install", ipa], {
    env: { PYMOBILEDEVICE3_UDID: udid },
    onData: (s) => {
      const m = s.match(/(\d{1,3})%\s*Complete/);
      if (m) send({ phase: "install", progress: Number(m[1]) / 100, line: `${m[1]}% — установка` });
    },
  });
  try { fs.unlinkSync(ipa); } catch {}
  if (ir.code === 0 || ir.out.includes("Installation succeed")) { send({ phase: "done", progress: 1, line: "✓ Установлено" }); return { ok: true }; }
  send({ phase: "error", line: "✗ ошибка установки" });
  return { ok: false, error: "install failed" };
});

// ── IPC: аккаунт bmrng (тот же бэкенд) ──────────────────────────
async function apiPost(pathname, body) {
  try {
    const res = await fetch(API + pathname, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: { detail: "Ошибка сети" } }; }
}
ipcMain.handle("bmrng-register", async (_e, b) => apiPost("/api/register/", b));
ipcMain.handle("bmrng-verify", async (_e, b) => apiPost("/api/verify-email/", b));
ipcMain.handle("bmrng-login", async (_e, b) => apiPost("/api/login/", b));
ipcMain.handle("config-get", async () => cfgGet());
ipcMain.handle("config-set", async (_e, patch) => cfgSet(patch));
ipcMain.handle("tools-ready", async () => ({
  ipatool: fs.existsSync(ipatoolPath()) || !ipatoolPath().includes("/"),
  python: true,
}));

// ── окно ────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 980, height: 720, minWidth: 900, minHeight: 640,
    backgroundColor: "#F7F5F4", title: "bmrng",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}
app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
