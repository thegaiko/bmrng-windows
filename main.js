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

// На Windows для связи с iPhone нужен драйвер Apple Mobile Device Support
// (ставится с iTunes / «Apple Devices»). Без него usbmuxd нет — устройство не видно.
function iTunesInstalled() {
  if (process.platform !== "win32") return true; // macOS — не нужен
  const dirs = [
    path.join(process.env["CommonProgramFiles"] || "", "Apple", "Mobile Device Support"),
    path.join(process.env["CommonProgramFiles(x86)"] || "", "Apple", "Mobile Device Support"),
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Common Files", "Apple", "Mobile Device Support"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Common Files", "Apple", "Mobile Device Support"),
  ];
  for (const d of dirs) { try { if (d && fs.existsSync(d)) return true; } catch {} }
  // запасной способ — служба Apple Mobile Device Service
  try {
    const out = execSync('sc query "Apple Mobile Device Service"', { encoding: "utf8", timeout: 4000 });
    if (/STATE/i.test(out)) return true;
  } catch {}
  return false;
}
ipcMain.handle("check-itunes", async () => ({ needed: process.platform === "win32", installed: iTunesInstalled() }));

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

function run(cmd, args, { env = {}, onData, timeoutMs, track, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env } }); }
    catch (e) { return resolve({ code: -1, out: String(e) }); }
    // Если нужно передать данные (например сессию для set-session) — пишем в stdin.
    // Иначе закрываем stdin: инструмент, ждущий интерактивный ввод (2FA/пароль),
    // получит EOF и завершится с ошибкой, а не зависнет навсегда.
    try { if (input != null) { child.stdin.write(input); child.stdin.end(); } else { child.stdin.end(); } } catch {}
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
let _lastUsbmuxRaw = "";
ipcMain.handle("devices", async () => {
  const py = pythonBase();
  let arr = [];
  // 2 попытки: устройство может появиться через мгновение после подключения/доверия
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await run(py.cmd, [...py.pre, "usbmux", "list"], { timeoutMs: 15000 });
    _lastUsbmuxRaw = (r.out || "").trim().slice(0, 400);
    try { arr = JSON.parse((r.out || "").trim()); } catch { arr = []; }
    if (Array.isArray(arr) && arr.length) break;
    if (attempt < 2) await new Promise((res) => setTimeout(res, 800));
  }
  const seen = new Set(); const list = [];
  for (const d of (Array.isArray(arr) ? arr : [])) {
    // берём всё, что НЕ Wi-Fi (USB и любые нестандартные метки ConnectionType)
    const ct = String(d.ConnectionType || "").toLowerCase();
    if (ct.includes("network") || ct.includes("wifi") || ct.includes("wi-fi")) continue;
    const udid = d.Identifier || d.SerialNumber || d.UniqueDeviceID;
    if (udid && !seen.has(udid)) { seen.add(udid); list.push({ udid, name: d.DeviceName || "iPhone" }); }
  }
  return list;
});
// сырой ответ usbmuxd для диагностики (кнопка/журнал)
ipcMain.handle("usbmux-raw", async () => _lastUsbmuxRaw || "(пусто)");

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
// сетевая ошибка — не дозвонились до серверов Apple (DNS/DPI/обрыв). Не путать с
// неверным паролем/2FA/глюком Apple: только при этом имеет смысл повтор через прокси.
function netFail(out) {
  return /failed to send http request|i\/o timeout|no such host|dial tcp|connection refused|round trip|tls handshake|network is unreachable|context deadline|lookup [^ ]*apple|proxyconnect|connection reset|reset by peer/i.test(out || "");
}

// GUID из MAC-адреса (как ipatool: первый непустой, uppercase, без двоеточий).
function appleGuid() {
  const ifs = os.networkInterfaces();
  for (const n of Object.keys(ifs)) for (const a of ifs[n] || []) {
    if (a.mac && a.mac !== "00:00:00:00:00:00") return a.mac.toUpperCase().replace(/:/g, "");
  }
  return "000000000000";
}
function plistStr(xml, key) {
  const m = (xml || "").match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "i"));
  return m ? m[1] : "";
}
// Cookie-jar для входа: Apple на 1-м запросе (пароль) ставит session-cookie (itspod и др.),
// а 2-й запрос (пароль+код 2FA) обязан их нести — иначе Apple не связывает код с сессией
// и отдаёт пустой ответ. Без этого 2FA-вход не проходил (принимали за «троттлинг»).
const _authCookies = {}; // email → { name: value }
function cookieHeader(key) {
  const jar = _authCookies[key] || {};
  return Object.keys(jar).map((k) => `${k}=${jar[k]}`).join("; ");
}
function storeCookies(key, res) {
  const jar = _authCookies[key] || (_authCookies[key] = {});
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list || []) {
    const pair = c.split(";")[0]; const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
// Гейт против ретрай-шторма. Apple лимитирует вход ПО АККАУНТУ, а не по IP: когда юзер
// долбит «Войти» подряд, каждая попытка усиливает троттлинг (пустой 204). Здесь мы после
// отказа на ввод пароля держим кулдаун, растущий с каждым страйком (20с→40→80→160→макс 300),
// и просто НЕ отправляем запрос в Apple, пока он не истёк. Так шторм гасится в зародыше,
// а телеметрия отделяет «мы сами долбим» (rate_self) от реального ответа Apple.
const _loginGate = {}; // email → { until: ms, strikes: n }
function gateState(key) { return _loginGate[key] || (_loginGate[key] = { until: 0, strikes: 0 }); }
function gateBump(key) {
  const g = gateState(key);
  g.strikes = Math.min(g.strikes + 1, 6);
  const wait = Math.min(20000 * Math.pow(2, g.strikes - 1), 300000); // 20с … 5мин
  g.until = Date.now() + wait;
  return Math.ceil(wait / 1000);
}
function gateClear(key) { _loginGate[key] = { until: 0, strikes: 0 }; }
// Нативный вход в Apple ID напрямую (без подпроцесса ipatool) — как в приложении Сбера:
// один HTTPS-запрос authenticate. Быстро и без багов спавна/паники/keyring.
async function appleNativeAuth(email, password, code) {
  const guid = appleGuid();
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pw = String(password) + String(code || "").replace(/\s+/g, "");
  // Тело 1-в-1 как ipatool: attempt начинается с 1 (иначе Apple считает это повторной
  // попыткой и НЕ пушит 2FA-код). Без createSession — ipatool его не шлёт.
  const reqBody = (attempt) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>appleId</key><string>${esc(email)}</string>
<key>attempt</key><string>${attempt}</string>
<key>guid</key><string>${guid}</string>
<key>password</key><string>${esc(pw)}</string>
<key>rmp</key><string>0</string>
<key>why</key><string>signIn</string>
</dict></plist>`;
  const jarKey = String(email).toLowerCase();
  if (!code) _authCookies[jarKey] = {}; // вход без кода = новая сессия → свежие cookie
  const doReq = async (attempt) => {
    const headers = {
      "User-Agent": "Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const ch = cookieHeader(jarKey);
    if (ch) headers["Cookie"] = ch; // 2-й запрос (с кодом) несёт cookie 1-го
    const r = await fetch(`https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=${guid}`, {
      method: "POST", headers, body: reqBody(attempt),
    });
    storeCookies(jarKey, r); // запоминаем session-cookie от Apple
    return r;
  };
  // Вход ТОЛЬКО напрямую (через прокси Apple отдаёт 204 — auth из дата-центра не принимает).
  // Ретраим ТОЛЬКО при обрыве сети (fetch кинул). НЕ долбим при 204/пустом ответе —
  // это троттлинг Apple, и повторы его только усиливают.
  let res, text, netErr = false, throttled = false, httpStatus = 0, emptyBody = false;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    try {
      res = await doReq(1); text = await res.text();
      if (plistStr(text, "failureType") === "-5000") { res = await doReq(2); text = await res.text(); }
    } catch (e) { netErr = true; text = ""; continue; } // обрыв сети → повтор
    netErr = false;
    httpStatus = res.status;
    emptyBody = !String(text).trim();
    // 204/пусто/5xx = Apple ограничил вход (троттлинг) → НЕ повторяем, выходим сразу
    if (res.status === 204 || res.status >= 500 || emptyBody) { throttled = true; }
    break;
  }
  if (netErr) return { netError: true };
  if (throttled) return { throttled: true, httpStatus, emptyBody };

  const failureType = plistStr(text, "failureType");
  const customerMessage = plistStr(text, "customerMessage");
  const passwordToken = plistStr(text, "passwordToken");
  const dsid = plistStr(text, "dsPersonId");
  const needsCode = customerMessage === "MZFinance.BadLogin.Configurator_message";

  if (passwordToken && dsid) {
    const acct = {
      email, passwordToken, directoryServicesIdentifier: dsid,
      name: [plistStr(text, "firstName"), plistStr(text, "lastName")].filter(Boolean).join(" ") || email,
      storeFront: res.headers.get("x-set-apple-store-front") || "",
      password, pod: res.headers.get("pod") || "",
      guid, // тот же guid, что использован при входе → download возьмёт его из сессии
    };
    return { ok: true, account: acct };
  }
  if (!code && needsCode) return { needCode: true };
  if (code && needsCode) return { wrongCode: true };
  if (failureType === "-5000" || /invalid|incorrect|not.*(found|valid)|неверн/i.test(customerMessage)) return { wrongPassword: true };
  if (/disabled|locked|заблок/i.test(customerMessage)) return { disabled: true, message: customerMessage };
  return { glitch: true, failureType, customerMessage, raw: (text || "").slice(0, 200) };
}

ipcMain.handle("account-login", async (_e, { email, password, code }) => {
  const tool = ipatoolPath();
  const gk = String(email || "").toLowerCase();
  // 0) ГЕЙТ против шторма: только для попыток ВВОДА ПАРОЛЯ (шаг с кодом 2FA — это прогресс,
  //    его не блокируем). Если кулдаун не истёк — вообще не трогаем Apple, гасим шторм у себя.
  if (!code) {
    const g = gateState(gk);
    const leftMs = g.until - Date.now();
    if (leftMs > 0) {
      const sec = Math.ceil(leftMs / 1000);
      track("login", "rate_self", `wait=${sec}s;strikes=${g.strikes}`);
      return { ok: false, cooldown: sec, error: `Слишком много попыток входа подряд. Apple временно блокирует вход по этому Apple ID — это защита Apple, а не программы. Подождите ${sec} сек, кнопка станет активной сама. За это время проверьте пароль, чтобы ввести его верно с первого раза.` };
    }
  }
  // 1) НАТИВНЫЙ вход (без подпроцесса ipatool) — быстро и без его багов (паника/спавн/keyring).
  const n = await appleNativeAuth(email, password, code);
  // 2) Сетевой сбой (после ретраев). С кодом в ipatool НЕ уходим — он перезапросит код,
  // и старый станет невалидным. Без кода — ipatool как запасной путь.
  if (n.netError) {
    track("login", "net_error");
    if (code) return { ok: false, needCode: true, error: "Связь с Apple прервалась. Нажмите «Войти» ещё раз — придёт новый код." };
    return await ipatoolLoginFallback(email, password, code);
  }
  if (n.throttled) {
    // Разбиваем бывший общий «throttled» по реальному ответу Apple, чтобы в телеметрии
    // видеть, что это: пустой 204 / серверная 5xx / 200-но-пусто. (Верный пароль Apple
    // тоже иногда прячет за пустым 204 — потому и вводим кулдаун вместо долбёжки.)
    const oc = n.httpStatus === 204 ? "throttled_204"
      : n.httpStatus >= 500 ? "throttled_5xx"
      : n.emptyBody ? "throttled_empty" : "throttled_other";
    const sec = code ? 20 : gateBump(gk); // ввод пароля → включаем/растим кулдаун
    track("login", oc, `http=${n.httpStatus};strikes=${gateState(gk).strikes}`);
    return { ok: false, cooldown: sec, error: `Apple временно ограничил вход с этого Apple ID (слишком много попыток за короткое время) — это ограничение Apple. Подождите ${sec} сек и попробуйте снова. Пока ждёте — проверьте, что пароль верный (раскладка, заглавные буквы).` };
  }
  if (n.needCode) { gateClear(gk); track("login", "need_code"); return { ok: false, needCode: true }; } // пароль принят → страйки сброшены
  if (n.wrongCode) { track("login", "wrong_code"); return { ok: false, needCode: true, error: "Неверный код. Код действует недолго — запросите новый и проверьте пароль (регистр букв, раскладка)." }; }
  if (n.wrongPassword) { const sec = gateBump(gk); track("login", "wrong_password"); return { ok: false, cooldown: sec, error: "Неверный Apple ID или пароль. Проверьте регистр букв и раскладку клавиатуры, попробуйте снова." }; }
  if (n.disabled) { track("login", "disabled"); return { ok: false, error: "Этот Apple ID заблокирован Apple. Разблокируйте его на appleid.apple.com и попробуйте снова." }; }
  // неожиданный ответ Apple → на всякий случай проверенный путь ipatool (страховка)
  if (n.glitch || !n.ok) { track("login", "glitch"); return await ipatoolLoginFallback(email, password, code); }
  // 3) Успех → кладём сессию в keyring ipatool (для последующей загрузки).
  await run(tool, ipa(["auth", "set-session"]), { input: JSON.stringify(n.account), timeoutMs: 15000 });
  const info0 = await run(tool, ipa(["auth", "info", "--format", "json", "--non-interactive"]), { timeoutMs: 20000 });
  const ij0 = lastJSON(info0.out) || {};
  if (ij0.success && (ij0.name || ij0.email)) { gateClear(gk); track("login", "ok"); return { ok: true }; }
  // Мост не сработал (редко) → страховка: обычный вход через ipatool (проверенный путь).
  track("login", "bridge_fail");
  return await ipatoolLoginFallback(email, password, code);
});

// Старый путь входа через ipatool — оставлен как fallback на случай сетевого сбоя
// нативного входа (умеет прокси). Возвращает { ok / needCode / error }.
async function ipatoolLoginFallback(email, password, code) {
  const tool = ipatoolPath();
  const args = ["auth", "login", "-e", email, "-p", password, "--format", "json", "--non-interactive"];
  if (code) args.push("--auth-code", code);
  const proxyEnv = await getProxyEnv();
  const phases = [{ env: {}, proxy: false }];
  if (proxyEnv) phases.push({ env: proxyEnv, proxy: true });
  let r;
  for (const ph of phases) {
    // до 3 попыток на временные глюки auth-серверов Apple (204/404/5xx)
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise((res) => setTimeout(res, 1500));
      r = await run(tool, ipa(args), { timeoutMs: 90000, env: ph.env });
      if (!appleAuthGlitch(r.out) || r.timedOut) break;
    }
    const okNow = (lastJSON(r.out) || {}).success === true;
    // к прокси эскалируем только при сетевом сбое; на успех/неверный пароль/2FA/глюк — нет
    if (okNow || !(r.timedOut || netFail(r.out))) break;
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
  // без кода и есть признаки 2FA (или краш на приглашении) → показываем поле для кода.
  // ВАЖНО: Apple на неверный пароль (при 2FA) отвечает так же, как «нужен код».
  if (!code && (needs || crashed)) return { ok: false, needCode: true, raw };

  const invalidCreds = /-5000|invalid credential|incorrect password|password (is )?(incorrect|invalid)|wrong password/i.test(low);
  const generic = /something went wrong|unknown error|an unknown error|please try again|try again later/i.test(low);

  // Чистое сообщение — без Go-стектрейса / сырых HTTP-кодов в интерфейсе
  let err = (lastJSON(r.out) || {}).error;
  if (netFail(r.out) || r.timedOut) {
    err = "Обрыв связи с серверами Apple при входе. Проверьте интернет и попробуйте войти ещё раз.";
  } else if (appleAuthGlitch(r.out)) {
    err = "Серверы Apple сейчас не отвечают на вход (временная проблема на стороне Apple). Попробуйте через пару минут или смените сеть.";
  } else if (code && (needs || invalidCreds || generic || crashed)) {
    // Код ввели, но вход не прошёл → почти всегда НЕВЕРНЫЙ ПАРОЛЬ (или неверный код).
    err = "Вход не удался. Скорее всего, неверный пароль — проверьте его (регистр букв и раскладка клавиатуры) и введите заново. Если пароль точно верный, запросите новый код и повторите.";
  } else if (invalidCreds) {
    err = "Неверный Apple ID или пароль. Проверьте данные (регистр букв, раскладка) и попробуйте снова.";
  } else if (generic) {
    err = "Apple не пустил с первой попытки. Нажмите «Войти» ещё раз — обычно получается со второго раза. Если не помогает — подождите пару минут.";
  } else if (!err || crashed) {
    err = crashed
      ? "Не удалось войти. Введите код с ваших устройств Apple и проверьте, что пароль верный."
      : (raw || "Не удалось войти");
  }
  return { ok: false, error: String(err).slice(0, 240), raw };
}

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
    send({ line: `⚠ Мало места на диске (~${(freeAtStart / 1024 ** 3).toFixed(1)} ГБ свободно). Для установки нужно 1–2 ГБ. Возможно, файл не докачается.` });
  }
  // поллинг размера скачиваемого файла → прогресс в МБ. Запоминаем ПИКОВЫЙ размер:
  // ipatool при провале удаляет .tmp, и потом узнать, сколько скачалось, уже нельзя.
  let peakBytes = 0;
  const dlPoll = setInterval(() => {
    let sz = 0;
    for (const f of [ipaFile, ipaFile + ".tmp"]) { try { sz += fs.statSync(f).size; } catch {} }
    if (sz > peakBytes) peakBytes = sz;
    if (sz > 0) send({ phase: "download", app: app.name, bytes: sz });
  }, 400);
  let ok = false; let lastOut = ""; let allOut = ""; let usedIndex = -1; let needLicense = false; let lastBadSize = null;
  let usedProxy = false; let usedCache = false;
  // если у пользователя рвётся прямая загрузка — эскалируем на загрузку через наш сервер
  const proxyEnv = await getProxyEnv();
  const cacheManifest = await getCacheManifest();
  const RESET_RX = /not a valid zip|apply patches|zip reader|unexpected eof|connection reset|reset by peer|timeout|eof/i;
  const NET_RX = /failed to send http request|i\/o timeout|no such host|dial tcp|connection refused|round trip|tls handshake|network is unreachable|context deadline|lookup [^ ]*apple|proxyconnect/i;
  // Проход 1: ТОЛЬКО download (без --purchase). Скачивает уже купленное приложение
  // через существующую сессию и НЕ вызывает подтверждений входа в Apple ID.
  for (let i = start; i < sels.length; i++) {
    const sel = sels[i];
    if (sels.length > 1) send({ line: `Вариант ${i + 1}/${sels.length}…` });
    let r = null; let good = false;
    // Фаза КЭША: если приложение есть в нашем кэше — качаем большой файл с нашего
    // сервера (стабильно, минуя падающий CDN Apple) и собираем через --reuse: к Apple
    // идёт только лёгкий запрос за лицензией текущего Apple ID.
    const appId = sel[0] === "-i" ? String(sel[1]) : null;
    const cached = appId && cacheManifest && cacheManifest[appId];
    if (cached && cached.file && cached.evid) {
      const basePath = ipaFile + ".base";
      const cacheUrl = `https://bmrng.app/cache/${cached.file}`;
      const wantSize = Number(cached.size || 0);
      try { fs.unlinkSync(basePath); } catch {} // свежая база, не чужой обрывок
      // Скачиваем базу с ДОКАЧКОЙ: при обрыве продолжаем с места, а не с нуля.
      // Готово только когда размер совпал с ожидаемым (иначе это обрывок). Стоп —
      // при 2 попытках подряд без прогресса (мёртвый канал) → уходим на обычный путь.
      let baseOk = false; let prevGot = -1; let stalls = 0;
      for (let attempt = 1; attempt <= 15 && !cancelRequested; attempt++) {
        send({ line: attempt === 1 ? "Загрузка с нашего сервера…" : "Догружаем с нашего сервера…" });
        try {
          await downloadFile(cacheUrl, basePath, (_f, received) => {
            if (received > 0) send({ phase: "download", app: app.name, bytes: received });
          });
        } catch {}
        if (cancelRequested) break;
        let got = 0; try { got = fs.statSync(basePath).size; } catch {}
        if (wantSize > 0 ? got >= wantSize : isValidZip(basePath)) { baseOk = true; break; }
        if (got <= prevGot) { if (++stalls >= 2) break; } else stalls = 0;
        prevGot = got;
        await new Promise((res) => setTimeout(res, 1500)); // пауза перед докачкой
      }
      if (cancelRequested) { clearInterval(dlPoll); try { fs.unlinkSync(basePath); } catch {} return cancelled(); }
      if (baseOk && isValidZip(basePath)) {
        send({ line: "Готовим установку…" });
        try { fs.unlinkSync(ipaFile); } catch {}
        r = await run(tool, ipa(["download", "-i", appId, "--external-version-id", String(cached.evid), "--reuse", basePath, "-o", ipaFile, "--format", "json", "--non-interactive"]), { track: true });
        allOut += "\n" + (r.out || "");
        if (fs.existsSync(ipaFile) && (lastJSON(r.out) || {}).success && isValidZip(ipaFile)) { good = true; usedIndex = i; usedCache = true; }
      }
      try { fs.unlinkSync(basePath); } catch {}
      if (good) { ok = true; lastOut = r.out; break; }
    }
    // сначала напрямую (3 попытки); при обрыве/повреждении — через наш сервер (2 попытки)
    const phases = [{ env: {}, tries: 3, proxy: false }];
    if (proxyEnv) phases.push({ env: proxyEnv, tries: 2, proxy: true });
    let escalate = !good;
    for (const ph of phases) {
      if (!escalate) break;
      for (let attempt = 1; attempt <= ph.tries; attempt++) {
        if (ph.proxy) send({ line: `Прямая загрузка не удалась — качаем через наш сервер (${attempt}/${ph.tries})…` });
        else if (attempt > 1) send({ line: `Файл повреждён, повтор загрузки (${attempt}/3)…` });
        try { fs.unlinkSync(ipaFile); } catch {}
        r = await run(tool, ipa(["download", ...sel, "-o", ipaFile, "--format", "json", "--non-interactive"]), { track: true, env: ph.env });
        if (cancelRequested) { clearInterval(dlPoll); return cancelled(); }
        if (fs.existsSync(ipaFile) && (lastJSON(r.out) || {}).success && isValidZip(ipaFile)) { good = true; usedProxy = ph.proxy; break; }
        // диагностика: размер битого файла (обрыв → маленький, подмена контента → полный размер)
        try { const sz = fs.statSync(ipaFile).size; if (sz) lastBadSize = sz; } catch {}
        // повторяем/эскалируем только обрыв/повреждение/сеть; на «license required» и др. — сразу дальше
        const corrupt = RESET_RX.test(r.out) || NET_RX.test(r.out)
                        || (fs.existsSync(ipaFile) && (lastJSON(r.out) || {}).success && !isValidZip(ipaFile));
        if (!corrupt) { escalate = false; break; }
      }
      if (good) break;
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
    // напрямую, а при сетевом сбое — через наш сервер
    const p2 = [{ env: {}, proxy: false }];
    if (proxyEnv) p2.push({ env: proxyEnv, proxy: true });
    for (const ph of p2) {
      if (ph.proxy) send({ line: "Прямая загрузка не удалась — качаем через наш сервер…" });
      try { fs.unlinkSync(ipaFile); } catch {}
      const r = await run(tool, ipa(["download", ...sels[start], "-o", ipaFile, "--purchase", "--format", "json", "--non-interactive"]), { track: true, env: ph.env });
      if (cancelRequested) { clearInterval(dlPoll); return cancelled(); }
      lastOut = r.out; allOut += "\n" + r.out;
      if (fs.existsSync(ipaFile) && (lastJSON(r.out) || {}).success && isValidZip(ipaFile)) { ok = true; usedIndex = start; usedProxy = ph.proxy; break; }
      try { fs.unlinkSync(ipaFile); } catch {}
      // на прокси эскалируем только при сетевой ошибке/обрыве
      if (!ph.proxy && !(RESET_RX.test(r.out) || NET_RX.test(r.out))) break;
    }
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
    // сколько РЕАЛЬНО скачалось: пик поллинга (ipatool чистит .tmp при провале, поэтому
    // остаток на диске обманывает — раньше показывал «0 МБ», хотя качалось много).
    const peakMB = Math.round(peakBytes / 1048576);
    const badMB = Math.round(Math.max(lastBadSize || 0, peakBytes) / 1048576) || null;
    // «диск заполнился»: явная ошибка записи, ИЛИ что-то скачалось, но места почти нет.
    // ipatool при вшивании лицензии копирует IPA → нужно ~2× размера приложения.
    const diskErr = /no space left|not enough space|disk full|cannot write|write failed|enospc/i.test(allOut);
    const diskFull = !notOwned && (diskErr || (fb != null && fb < 700 * 1024 ** 2 && peakMB > 50));
    // ДИАГНОСТИКА в журнал: реальный объём загрузки, место, и сырая ошибка ipatool —
    // без этого причину «повреждается» установить нельзя.
    if (!notOwned) {
      send({ line: `диагностика: скачалось ~${peakMB} МБ, свободно ${freeGB != null ? freeGB + " ГБ" : "?"}` });
      const rawErr = String((lastJSON(lastOut) || {}).error || err || "").replace(/\s+/g, " ").slice(0, 160);
      if (rawErr) send({ line: `ipatool: ${rawErr}` });
    }
    send({ phase: "error", line: notOwned ? `✗ «${app.name}» не в покупках этого Apple ID`
      : diskFull ? `✗ «${app.name}»: не хватило места на диске (нужно ~1–2 ГБ свободно)`
      : netError ? `✗ «${app.name}»: нет связи с серверами Apple`
      : corrupt ? `✗ «${app.name}»: файл повреждается при загрузке` : `✗ ${err}` });
    track("install", notOwned ? "not_owned" : diskFull ? "disk_full" : netError ? "net_error" : corrupt ? "corrupt" : "download_failed", app.name);
    return { ok: false, error: err, notOwned, corrupt, netError, diskFull, freeGB, badMB, peakMB, total: sels.length, triedFrom: start };
  }
  // bundle id из IPA — чтобы после установки убедиться, что приложение реально появилось на телефоне
  let bundleId = "";
  try {
    const bp = await run(py.cmd, ["-c",
      "import zipfile,plistlib,sys\n" +
      "z=zipfile.ZipFile(sys.argv[1])\n" +
      "c=[x for x in z.namelist() if x.startswith('Payload/') and x.endswith('.app/Info.plist') and x.count('/')==2]\n" +
      "print(plistlib.loads(z.read(c[0])).get('CFBundleIdentifier','') if c else '')",
      ipaFile], { timeoutMs: 20000 });
    bundleId = ((bp.out || "").trim().split("\n").filter(Boolean).pop() || "").trim();
  } catch {}

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
  const claimedOk = ir.code === 0 || ir.out.includes("Installation succeed");
  if (claimedOk) {
    // ПРОВЕРКА: реально ли приложение появилось на телефоне (защита «списали, а не встало»).
    // Если сам список получить не удалось — не рискуем, доверяем установке (не создаём ложный провал).
    let onDevice = true;
    if (bundleId) {
      const lst = await run(py.cmd, [...py.pre, "apps", "list"], { env: { PYMOBILEDEVICE3_UDID: udid }, timeoutMs: 30000 });
      const listOk = lst.code === 0 && (lst.out || "").length > 20;
      if (listOk) onDevice = lst.out.includes(bundleId);
    }
    if (onDevice) {
      send({ phase: "done", progress: 1, line: "✓ Установлено" });
      track("install", usedCache ? "cache_ok" : "ok", app.name);
      return { ok: true, usedIndex, total: sels.length };
    }
    send({ phase: "error", line: `✗ «${app.name}» не появилось на телефоне (установка не завершилась). Баланс не списан.` });
    track("install", "not_installed", app.name);
    return { ok: false, error: "приложение не появилось на телефоне", notInstalled: true, bundleId, total: sels.length };
  }
  send({ phase: "error", line: "✗ ошибка установки" });
  track("install", "install_failed", app.name);
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
// Телеметрия: отправляем исход входа/установки на сервер (без личных данных).
// fire-and-forget — не влияет на пользователя.
function track(kind, outcome, detail) {
  try {
    apiAuth("/api/event/", "POST", {
      kind, outcome, platform: isWin ? "win" : "mac",
      version: app.getVersion(), detail: (detail || "").slice(0, 120),
    }).catch(() => {});
  } catch {}
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

// Прокси для трафика ipatool через наш сервер: если у пользователя рвётся прямая
// загрузка с CDN Apple, повторяем через сервер (у него чистый маршрут до Apple).
// Управляется с сервера: version.json → proxy {enabled, url}. Кэш 5 минут.
let _proxyCache = { at: 0, env: null };
async function getProxyEnv() {
  if (Date.now() - _proxyCache.at < 300000) return _proxyCache.env;
  let env = null;
  try {
    const res = await fetch(UPDATE_URL, { cache: "no-store" });
    if (res.ok) {
      const d = await res.json();
      if (d.proxy && d.proxy.enabled && d.proxy.url) {
        const u = d.proxy.url;
        env = { HTTPS_PROXY: u, HTTP_PROXY: u, https_proxy: u, http_proxy: u };
      }
    }
  } catch {}
  _proxyCache = { at: Date.now(), env };
  return env;
}

// Манифест кэша: какие приложения раздаём базой с нашего сервера (тяжёлый payload —
// с bmrng.app, к Apple только лёгкий запрос за лицензией). { "<appId>": {file, evid, version} }
const CACHE_MANIFEST_URL = "https://bmrng.app/cache/manifest.json";
let _cacheManifest = { at: 0, apps: null };
async function getCacheManifest() {
  if (Date.now() - _cacheManifest.at < 300000) return _cacheManifest.apps;
  let apps = null;
  try {
    const res = await fetch(CACHE_MANIFEST_URL, { cache: "no-store" });
    if (res.ok) { const d = await res.json(); apps = (d && d.apps) || null; }
  } catch {}
  _cacheManifest = { at: Date.now(), apps };
  return apps;
}

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

// объявление-баннер (управляется из ЛК → Настройки)
ipcMain.handle("announcement", async () => {
  try {
    const res = await fetch("https://bmrng.app/api/announcement/", { cache: "no-store" });
    if (!res.ok) return { active: false };
    return await res.json();
  } catch { return { active: false }; }
});

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

// Загрузка с ДОКАЧКОЙ (HTTP Range): если файл уже частично скачан, продолжаем с места,
// а не с нуля. Критично на нестабильном интернете — иначе большой файл рестартует
// бесконечно и никогда не доходит (жжёт трафик, «1 МБ в час» по факту).
async function downloadFile(url, dest, onProgress) {
  let start = 0;
  try { start = fs.statSync(dest).size; } catch { start = 0; }
  const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
  const res = await fetch(url, { redirect: "follow", cache: "no-store", headers });
  if (res.status === 416) return; // диапазон невалиден — файл уже целиком
  if (!res.ok && res.status !== 206) throw new Error("HTTP " + res.status);
  const resuming = res.status === 206;
  if (!resuming) start = 0; // сервер не поддержал докачку — пишем с нуля
  const total = Number(res.headers.get("content-length") || 0) + start;
  const file = fs.createWriteStream(dest, { flags: resuming ? "a" : "w" });
  const reader = res.body.getReader();
  let received = start;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      file.write(Buffer.from(value));
      if (onProgress) onProgress(total ? received / total : 0, received, total);
    }
  } finally {
    await new Promise((r) => file.end(r)); // частичное сохраняем для докачки
  }
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
