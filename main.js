const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// Стабильный отпечаток компьютера (хэш аппаратного ID) — для защиты от накрутки
// бесплатных установок через новые аккаунты. Сырой ID не передаём, только хэш.
let _machineId = null;
function machineId() {
  if (_machineId) return _machineId;
  let raw = "";
  try {
    if (process.platform === "win32") {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: "utf8", timeout: 4000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
      raw = m ? m[1] : "";
    } else {
      const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", { encoding: "utf8", timeout: 4000 });
      const m = out.match(/IOPlatformUUID"\s*=\s*"([\w-]+)"/);
      raw = m ? m[1] : "";
    }
  } catch { /* фолбэк ниже */ }
  if (!raw) raw = `${os.hostname()}|${os.platform()}|${os.arch()}`;
  _machineId = crypto.createHash("sha256").update("bmrng:" + raw).digest("hex").slice(0, 32);
  return _machineId;
}

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
// Файловый keyring ipatool (обходит лимит Windows Credential Manager ~2.5КБ)
const IPA_PASS = "bmrng-local-keychain";
function ipa(args) { return [...args, "--keychain-passphrase", IPA_PASS]; }

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
// отмена установки: помеченные процессы можно разом убить
let cancelRequested = false;
const installChildren = new Set();

function run(cmd, args, { env = {}, onData, timeoutMs, track } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env } }); }
    catch (e) { return resolve({ code: -1, out: String(e) }); }
    // Закрываем stdin: если инструмент вдруг ждёт интерактивный ввод (2FA/пароль) —
    // получит EOF и завершится с ошибкой, а не зависнет навсегда (частая причина «вход… и ничего»).
    try { child.stdin.end(); } catch {}
    if (track) installChildren.add(child);
    let out = ""; let done = false; let timer = null;
    const finish = (res) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (track) installChildren.delete(child); resolve(res); };
    const cap = (d) => { const s = d.toString(); out += s; if (onData) onData(s); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("close", (code) => finish({ code, out }));
    child.on("error", (e) => finish({ code: -1, out: String(e) }));
    if (timeoutMs) timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ code: -1, out: out + "\n[timeout]", timedOut: true });
    }, timeoutMs);
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

// Свободное место в каталоге (байт). ipatool при вшивании лицензии копирует IPA,
// поэтому места нужно ~вдвое больше размера приложения.
function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

// Проверка, что скачанный файл — валидный zip/ipa (сигнатура "PK").
// Обрезанная загрузка большого приложения даёт битый файл → ipatool не может вшить лицензию.
function isValidZip(p) {
  try {
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return n >= 2 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  } catch { return false; }
}

// Ошибка «приложения не было в истории покупок этого Apple ID»
// (лицензии нет, и купить/получить её не удалось).
function notOwnedError(text, needLicense) {
  const t = (text || "").toLowerCase();
  const patterns = [
    "not purchased", "previously purchased", "has not purchased", "not been purchased",
    "obtain a license", "no longer available", "is not available", "isn't available",
    "not eligible", "purchase it from", "account does not have", "failed to obtain",
  ];
  if (patterns.some((p) => t.includes(p))) return true;
  return !!needLicense; // потребовалась лицензия, но получить не удалось
}

// ── конфиг (токен bmrng) ────────────────────────────────────────
function cfgPath() { return path.join(app.getPath("userData"), "config.json"); }
function cfgGet() { try { return JSON.parse(fs.readFileSync(cfgPath(), "utf8")); } catch { return {}; } }
function cfgSet(patch) { const c = { ...cfgGet(), ...patch }; fs.writeFileSync(cfgPath(), JSON.stringify(c)); return c; }

// ── каталог ─────────────────────────────────────────────────────
function catalogFromLocal() {
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
async function catalog() {
  // основной источник — бэкенд (управляется в Django); фолбэк — вшитый apps.json
  try {
    const res = await fetch(API + "/api/catalog/", { cache: "no-store" });
    if (res.ok) {
      const apps = await res.json();
      if (Array.isArray(apps) && apps.length) {
        return apps.map((a) => ({
          key: a.key, name: a.name, icon: a.icon || null,
          appIDs: (a.app_ids || []).map(String),
          bundleID: a.bundle_id || null,
        }));
      }
    }
  } catch { /* оффлайн — уходим в фолбэк */ }
  return catalogFromLocal();
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
  const r = await run(ipatoolPath(), ipa(["auth", "info", "--format", "json", "--non-interactive"]));
  const o = lastJSON(r.out);
  if (o && o.success && (o.name || o.email)) return o.name || o.email;
  return null;
});

// Временные сбои серверов авторизации Apple (Apple перекраивает эндпоинты / отдаёт мусор)
function appleAuthGlitch(out) {
  return /unexpected response from apple|non-plist|empty body|http 204|http 404|http 5\d\d|502 bad gateway|service unavailable/i.test(out || "");
}

ipcMain.handle("account-login", async (_e, { email, password, code }) => {
  const tool = ipatoolPath();
  const args = ["auth", "login", "-e", email, "-p", password, "--format", "json", "--non-interactive"];
  if (code) args.push("--auth-code", code);
  // до 3 попыток на временные глюки auth-серверов Apple (204/404/5xx)
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise((res) => setTimeout(res, 1500));
    r = await run(tool, ipa(args), { timeoutMs: 90000 });
    if (!appleAuthGlitch(r.out) || r.timedOut) break;
  }
  const low = r.out.toLowerCase();
  const raw = (r.out || "").toString().trim().replace(/\s+/g, " ").slice(-360);
  if (r.timedOut) return { ok: false, error: "Превышено время ожидания входа. Проверьте интернет и попробуйте снова.", raw };

  // достоверная проверка: реально ли вошли (сессия в keyring)
  const info = await run(tool, ipa(["auth", "info", "--format", "json", "--non-interactive"]), { timeoutMs: 30000 });
  const ij = lastJSON(info.out) || {};
  if (ij.success && (ij.name || ij.email)) return { ok: true, raw };

  // ipatool иногда паникует (Go-стектрейс) на приглашении ввести 2FA-код —
  // в спавненном окне на Windows нет консоли. С кодом (--auth-code) приглашения нет.
  const crashed = /panic:|goroutine\s+\d+|runtime error|\.go:\d+|cobra/i.test(r.out);
  // не вошли — нужен ли 2FA-код?
  const needs = low.includes("code") || low.includes("2fa") || low.includes("two-factor") ||
                low.includes("verification") || low.includes("configurator") || low.includes("otp");
  // без кода и есть признаки 2FA (или краш на приглашении) → показываем поле для кода
  if (!code && (needs || crashed)) return { ok: false, needCode: true, raw };

  // Чистое сообщение — без Go-стектрейса / сырых HTTP-кодов в интерфейсе
  let err = (lastJSON(r.out) || {}).error;
  if (appleAuthGlitch(r.out)) {
    err = "Серверы Apple сейчас не отвечают на вход (временная проблема на стороне Apple). Попробуйте через несколько минут, смените сеть или VPN-сервер.";
  } else if (!err || crashed) {
    err = crashed
      ? "Не удалось войти. Если включена двухфакторная аутентификация — введите код с ваших устройств Apple. Иначе проверьте Apple ID и пароль."
      : (raw || "Не удалось войти");
  }
  return { ok: false, error: String(err).slice(0, 220), raw };
});

ipcMain.handle("account-logout", async () => { await run(ipatoolPath(), ipa(["auth", "revoke"])); return true; });

ipcMain.handle("catalog", async () => catalog());

// ── IPC: проверка покупок ───────────────────────────────────────
async function probeOne(key, selector) {
  const tool = ipatoolPath();
  const tmp = path.join(os.tmpdir(), `.probe_${key}.ipa`);
  const tmp2 = tmp + ".tmp";
  [tmp, tmp2].forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  return new Promise((resolve) => {
    const child = spawn(tool, ipa(["download", ...selector, "-o", tmp, "--format", "json", "--non-interactive"]),
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
ipcMain.handle("install", async (e, { app, udid, fromIndex }) => {
  const tool = ipatoolPath(); const py = pythonBase();
  const send = (m) => e.sender.send("install-progress", m);
  const ipaFile = path.join(os.tmpdir(), `${app.key}.ipa`);
  try { fs.unlinkSync(ipaFile); } catch {}
  cancelRequested = false;
  const cancelled = () => { try { fs.unlinkSync(ipaFile); } catch {} send({ phase: "error", line: "⏹ Отменено" }); return { ok: false, cancelled: true }; };

  const sels = selectors(app);
  const start = Math.max(0, fromIndex || 0);
  if (start >= sels.length) {
    send({ phase: "error", line: "✗ Больше версий нет" });
    return { ok: false, error: "Все доступные версии этого приложения уже перепробованы", exhausted: true, total: sels.length };
  }

  send({ phase: "download", app: app.name, line: `Скачивание «${app.name}»…` });
  // предупреждение о нехватке места (частая причина «not a valid zip» на больших приложениях)
  const freeAtStart = freeBytes(os.tmpdir());
  if (freeAtStart != null && freeAtStart < 2 * 1024 ** 3) {
    send({ line: `⚠ Мало места на диске (~${(freeAtStart / 1024 ** 3).toFixed(1)} ГБ). Для установки нужно 1–2 ГБ свободно.` });
  }
  // поллинг размера скачиваемого файла → прогресс в МБ
  const dlPoll = setInterval(() => {
    let sz = 0;
    for (const f of [ipaFile, ipaFile + ".tmp"]) { try { sz += fs.statSync(f).size; } catch {} }
    if (sz > 0) send({ phase: "download", app: app.name, bytes: sz });
  }, 400);
  let ok = false; let lastOut = ""; let allOut = ""; let usedIndex = -1; let needLicense = false; let lastBadSize = null;
  // Проход 1: ТОЛЬКО download (без --purchase). Скачивает уже купленное приложение
  // через существующую сессию и НЕ вызывает подтверждений входа в Apple ID.
  for (let i = start; i < sels.length; i++) {
    const sel = sels[i];
    if (sels.length > 1) send({ line: `Вариант ${i + 1}/${sels.length}…` });
    let r = null; let good = false;
    // до 3 попыток: большие приложения (Сбер ~300 МБ) часто докачиваются не полностью
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) send({ line: `Файл повреждён, повтор загрузки (${attempt}/3)…` });
      try { fs.unlinkSync(ipaFile); } catch {}
      r = await run(tool, ipa(["download", ...sel, "-o", ipaFile, "--format", "json", "--non-interactive"]), { track: true });
      if (cancelRequested) { clearInterval(dlPoll); return cancelled(); }
      if (fs.existsSync(ipaFile) && (lastJSON(r.out) || {}).success && isValidZip(ipaFile)) { good = true; break; }
      // диагностика: размер битого файла (обрыв → маленький, подмена контента → полный размер)
      try { const sz = fs.statSync(ipaFile).size; if (sz) lastBadSize = sz; } catch {}
      // повторяем только повреждённую/оборванную загрузку; на «license required» и др. — сразу дальше
      const corrupt = /not a valid zip|apply patches|zip reader|unexpected eof|connection reset|reset by peer|timeout|eof/i.test(r.out)
                      || (fs.existsSync(ipaFile) && (lastJSON(r.out) || {}).success && !isValidZip(ipaFile));
      if (!corrupt) break;
    }
    lastOut = r.out; allOut += "\n" + r.out;
    if (good) { ok = true; usedIndex = i; break; }
    if (r.out.toLowerCase().includes("license is required")) needLicense = true;
    try { fs.unlinkSync(ipaFile); } catch {}
  }
  // Проход 2: если ничего не скачалось и это ОДИНОЧНОЕ приложение с «license required» —
  // один раз получаем лицензию (может запросить подтверждение Apple ID, но всего одно).
  // Для приложений с несколькими ID покупку НЕ делаем: иначе Apple засыпает
  // подтверждениями по каждому чужому ID (и можно случайно получить не то приложение).
  if (!ok && needLicense && sels.length === 1) {
    send({ line: "Получаю лицензию…" });
    const r = await run(tool, ipa(["download", ...sels[start], "-o", ipaFile, "--purchase", "--format", "json", "--non-interactive"]), { track: true });
    if (cancelRequested) { clearInterval(dlPoll); return cancelled(); }
    lastOut = r.out; allOut += "\n" + r.out;
    if (fs.existsSync(ipaFile) && (lastJSON(r.out) || {}).success && isValidZip(ipaFile)) { ok = true; usedIndex = start; }
    else { try { fs.unlinkSync(ipaFile); } catch {} }
  }
  clearInterval(dlPoll);
  if (cancelRequested) return cancelled();
  if (!ok) {
    const err = (lastJSON(lastOut) || {}).error || (lastOut || "").toString().trim().replace(/\s+/g, " ").slice(-300) || "не удалось скачать";
    // Приложение не в истории покупок Apple ID (лицензии нет и купить/получить не удалось)
    const notOwned = notOwnedError(allOut, needLicense);
    // Нет связи с серверами загрузки Apple (DNS-таймаут / обрыв) — сеть/VPN/DNS у пользователя
    const netError = !notOwned && /failed to send http request|i\/o timeout|no such host|dial tcp|connection refused|round trip|tls handshake|network is unreachable|context deadline|lookup [^ ]*apple/i.test(allOut);
    // Файл стабильно повреждается (обычно нестабильный интернет или мало места)
    const corrupt = !notOwned && !netError && /not a valid zip|replicate|apply patches|zip reader|unexpected eof/i.test(allOut);
    const fb = freeBytes(os.tmpdir());
    const freeGB = fb != null ? +(fb / 1024 ** 3).toFixed(1) : null;
    const badMB = lastBadSize != null ? Math.round(lastBadSize / 1048576) : null;
    if (corrupt && badMB != null) send({ line: `диагностика: скачалось ${badMB} МБ, файл невалиден` });
    send({ phase: "error", line: notOwned ? `✗ «${app.name}» не в покупках этого Apple ID`
      : netError ? `✗ «${app.name}»: нет связи с серверами Apple`
      : corrupt ? `✗ «${app.name}»: файл повреждается при загрузке` : `✗ ${err}` });
    return { ok: false, error: err, notOwned, corrupt, netError, freeGB, badMB, total: sels.length, triedFrom: start };
  }
  send({ phase: "install", progress: 0, line: "Устанавливаю на iPhone…" });
  const ir = await run(py.cmd, [...py.pre, "apps", "install", ipaFile], {
    env: { PYMOBILEDEVICE3_UDID: udid },
    track: true,
    onData: (s) => {
      const m = s.match(/(\d{1,3})%\s*Complete/);
      if (m) send({ phase: "install", progress: Number(m[1]) / 100, line: `${m[1]}% — установка` });
    },
  });
  try { fs.unlinkSync(ipaFile); } catch {}
  if (cancelRequested) return cancelled();
  if (ir.code === 0 || ir.out.includes("Installation succeed")) {
    send({ phase: "done", progress: 1, line: "✓ Установлено" });
    return { ok: true, usedIndex, total: sels.length };
  }
  send({ phase: "error", line: "✗ ошибка установки" });
  return { ok: false, error: "install failed", total: sels.length };
});

ipcMain.handle("cancel-install", async () => {
  cancelRequested = true;
  for (const c of installChildren) { try { c.kill("SIGKILL"); } catch {} }
  installChildren.clear();
  return true;
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
async function apiAuth(pathname, method, body) {
  const token = cfgGet().token;
  try {
    const res = await fetch(API + pathname, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Token " + token } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch (e) { return { status: 0, data: { detail: "Ошибка сети" } }; }
}
ipcMain.handle("bmrng-register", async (_e, b) => apiPost("/api/register/", { ...b, platform: isWin ? "win" : "mac", device_id: machineId() }));
ipcMain.handle("bmrng-verify", async (_e, b) => apiPost("/api/verify-email/", b));
ipcMain.handle("bmrng-login", async (_e, b) => apiPost("/api/login/", b));
ipcMain.handle("bmrng-me", async () => apiAuth("/api/me/", "GET"));
ipcMain.handle("bmrng-consume", async () => apiAuth("/api/consume/", "POST", {}));
ipcMain.handle("bmrng-topup", async (_e, b) => apiAuth("/api/topup/", "POST", b));
ipcMain.handle("bmrng-promo", async (_e, b) => apiAuth("/api/promo/validate/", "POST", b));
ipcMain.handle("install-log", async (_e, b) => apiAuth("/api/install-log/", "POST", { ...b, platform: isWin ? "win" : "mac" }));
ipcMain.handle("open-external", async (_e, url) => { try { await shell.openExternal(url); return true; } catch { return false; } });
ipcMain.handle("config-get", async () => cfgGet());
ipcMain.handle("config-set", async (_e, patch) => cfgSet(patch));
ipcMain.handle("tools-ready", async () => ({
  ipatool: fs.existsSync(ipatoolPath()) || !ipatoolPath().includes("/"),
  python: true,
}));

// ── обновления ──────────────────────────────────────────────────
const UPDATE_URL = "https://bmrng.app/download/version.json";

function cmpVersions(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

ipcMain.handle("app-version", async () => app.getVersion());

// режим оплаты (управляется с сервера через version.json → payments)
ipcMain.handle("pay-config", async () => {
  try {
    const res = await fetch(UPDATE_URL, { cache: "no-store" });
    if (!res.ok) return { mode: "yookassa" };
    const d = await res.json();
    return d.payments || { mode: "yookassa" };
  } catch {
    return { mode: "yookassa" };
  }
});

ipcMain.handle("check-update", async () => {
  try {
    const res = await fetch(UPDATE_URL, { cache: "no-store" });
    if (!res.ok) return { available: false };
    const data = await res.json();
    const cur = app.getVersion();
    const latest = data.version;
    // выбираем нужную сборку под платформу и архитектуру (Intel-Mac → mac_x64)
    let asset;
    if (isWin) asset = data.win || {};
    else if (process.arch === "x64" && data.mac_x64) asset = data.mac_x64;
    else asset = data.mac || {};
    if (latest && cmpVersions(latest, cur) > 0 && asset.url) {
      return {
        available: true, version: latest, current: cur,
        notes: data.notes || "", url: asset.url,
        type: asset.type || (isWin ? "nsis" : "zip"),
      };
    }
    return { available: false, current: cur, version: latest };
  } catch (e) {
    return { available: false, error: String(e) };
  }
});

async function downloadFile(url, dest, onProgress) {
  const res = await fetch(url, { redirect: "follow", cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const total = Number(res.headers.get("content-length") || 0);
  const file = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    file.write(Buffer.from(value));
    if (onProgress) onProgress(total ? received / total : 0, received, total);
  }
  await new Promise((r) => file.end(r));
}

// bash-скрипт, который ждёт закрытия приложения, подменяет .app и перезапускает
function macUpdaterScript() {
  return [
    "#!/bin/bash",
    'APP_BUNDLE="$1"; ZIP="$2"',
    'for i in $(seq 1 120); do pgrep -f "$APP_BUNDLE/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 0.5; done',
    "sleep 0.5",
    'TMP="$(mktemp -d)"',
    'ditto -x -k "$ZIP" "$TMP"',
    'NEW="$(/usr/bin/find "$TMP" -maxdepth 1 -name "*.app" | head -1)"',
    'if [ -d "$NEW" ]; then',
    '  rm -rf "$APP_BUNDLE"',
    '  ditto "$NEW" "$APP_BUNDLE"',
    '  xattr -dr com.apple.quarantine "$APP_BUNDLE" 2>/dev/null',
    '  open "$APP_BUNDLE"',
    "fi",
    'rm -rf "$TMP" "$ZIP"',
  ].join("\n");
}

ipcMain.handle("apply-update", async (_e, info) => {
  const win = BrowserWindow.getAllWindows()[0];
  const send = (p) => { try { win && win.webContents.send("update-progress", p); } catch {} };
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bmrng-upd-"));
    if (isWin) {
      const exe = path.join(tmpDir, "bmrng-setup.exe");
      await downloadFile(info.url, exe, (f) => send({ phase: "download", frac: f }));
      send({ phase: "install" });
      spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
      setTimeout(() => app.quit(), 800);
      return { ok: true };
    } else {
      const zip = path.join(tmpDir, "update.zip");
      await downloadFile(info.url, zip, (f) => send({ phase: "download", frac: f }));
      send({ phase: "install" });
      const appBundle = path.resolve(process.execPath, "..", "..", ".."); // …/bmrng.app
      const script = path.join(tmpDir, "apply.sh");
      fs.writeFileSync(script, macUpdaterScript(), { mode: 0o755 });
      spawn("/bin/bash", [script, appBundle, zip], { detached: true, stdio: "ignore" }).unref();
      setTimeout(() => app.quit(), 500);
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

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
