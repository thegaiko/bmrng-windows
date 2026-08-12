const $ = (s) => document.querySelector(s);
const api = window.bmrng;

const state = {
  cfg: {}, apps: [], selected: new Set(), owned: {}, devices: [], device: null,
  account: null, customId: "", busy: false,
  onb: { mode: "welcome", step: 0, name: "", email: "", password: "", code: "" },
};

// ══ ИНИЦИАЛИЗАЦИЯ ═══════════════════════════════════════════════
(async function init() {
  state.cfg = await api.configGet();
  if (state.cfg.registered) showApp(); else renderOnboarding();
  api.onInstallProgress(onProgress);
})();

function showApp() {
  $("#onboarding").hidden = true;
  $("#app").hidden = false;
  $("#profile-name").textContent = state.cfg.name || "Профиль";
  $("#profile-ava").textContent = (state.cfg.name || "b")[0].toUpperCase();
  loadCatalog();
  refreshAccount();
  refreshDevices();
  setInterval(() => { if (!state.busy) refreshDevices(); }, 3000);
  wireMain();
}

// ══ ОНБОРДИНГ ═══════════════════════════════════════════════════
function renderOnboarding() {
  const o = state.onb;
  const body = $("#onb-body");
  $("#onb-error").textContent = "";
  if (o.mode === "welcome") {
    body.innerHTML = `
      <div class="wm">bmrng</div>
      <h1 style="font-size:20px">Возвращаем приложения на iPhone</h1>
      <p>Восстанавливайте удалённые из App Store приложения из истории покупок Apple ID.</p>
      <div class="step-actions">
        <button class="btn-primary" id="o-reg">Создать аккаунт</button>
        <button class="link" id="o-login">Уже есть аккаунт — войти</button>
      </div>`;
    $("#o-reg").onclick = () => { o.mode = "register"; o.step = 1; renderOnboarding(); };
    $("#o-login").onclick = () => { o.mode = "login"; renderOnboarding(); };
    return;
  }
  if (o.mode === "login") {
    body.innerHTML = `
      <button class="back" id="o-back">← Назад</button>
      <h1>Вход</h1>
      <input class="input" id="f-email" placeholder="Почта" value="${o.email}">
      <input class="input" id="f-pass" type="password" placeholder="Пароль">
      <button class="btn-primary" id="o-do">Войти</button>`;
    $("#o-back").onclick = () => { o.mode = "welcome"; renderOnboarding(); };
    $("#o-do").onclick = doLogin;
    return;
  }
  // register
  const dots = `<div class="dots">${[1,2,3,4].map(i=>`<span class="${i===o.step?'on':''}"></span>`).join("")}</div>`;
  const fields = {
    1: { t: "Как вас зовут?", ph: "Ваше имя", key: "name", type: "text" },
    2: { t: "Ваша почта", ph: "you@example.com", key: "email", type: "text" },
    3: { t: "Придумайте пароль", ph: "Минимум 6 символов", key: "password", type: "password" },
    4: { t: "Код из письма", ph: "6 цифр", key: "code", type: "text" },
  };
  const f = fields[o.step];
  const sub = o.step === 4 ? `<p>Мы отправили код на ${o.email}</p>` : "";
  body.innerHTML = `
    <button class="back" id="o-back">← Назад</button>${dots}
    <h1>${f.t}</h1>${sub}
    <input class="input" id="f-val" type="${f.type}" placeholder="${f.ph}" value="${o[f.key]||""}">
    <button class="btn-primary" id="o-next">${o.step===4?"Подтвердить":o.step===3?"Создать аккаунт":"Далее"}</button>`;
  $("#f-val").focus();
  $("#f-val").onkeydown = (e) => { if (e.key === "Enter") onbNext(); };
  $("#o-next").onclick = onbNext;
  $("#o-back").onclick = () => {
    if (o.step > 1) { o.step--; } else { o.mode = "welcome"; }
    renderOnboarding();
  };
}

async function onbNext() {
  const o = state.onb;
  const err = (m) => { $("#onb-error").textContent = m; };
  const val = $("#f-val").value.trim();
  if (o.step === 1) { if (!val) return err("Введите имя"); o.name = val; o.step = 2; return renderOnboarding(); }
  if (o.step === 2) { if (!val.includes("@") || !val.includes(".")) return err("Введите корректную почту"); o.email = val.toLowerCase(); o.step = 3; return renderOnboarding(); }
  if (o.step === 3) {
    if (val.length < 6) return err("Минимум 6 символов");
    o.password = val; setBusy(true);
    const r = await api.register({ name: o.name, email: o.email, password: o.password });
    setBusy(false);
    if (r.status === 201) { o.step = 4; return renderOnboarding(); }
    return err(firstErr(r.data));
  }
  if (o.step === 4) {
    if (!val) return err("Введите код"); o.code = val; setBusy(true);
    const r = await api.verify({ email: o.email, code: o.code });
    setBusy(false);
    if (r.status === 200) return finishAuth(r.data);
    return err(r.data.detail || "Неверный код");
  }
}
async function doLogin() {
  const email = $("#f-email").value.trim().toLowerCase();
  const password = $("#f-pass").value;
  if (!email || !password) return ($("#onb-error").textContent = "Введите почту и пароль");
  setBusy(true);
  const r = await api.login({ email, password });
  setBusy(false);
  if (r.status === 200) return finishAuth(r.data);
  $("#onb-error").textContent = r.data.detail || "Неверная почта или пароль";
}
async function finishAuth(data) {
  const name = (data.user && data.user.name) || state.onb.name;
  state.cfg = await api.configSet({ registered: true, token: data.token, name, email: (data.user && data.user.email) || state.onb.email });
  showApp();
}
function firstErr(d) {
  return (d.email && d.email[0]) || (d.password && d.password[0]) || (d.name && d.name[0]) || d.detail || "Ошибка";
}
function setBusy(b) { state.busy = b; document.querySelectorAll(".btn-primary").forEach((x) => (x.disabled = b)); }

// ══ ОСНОВНОЙ ЭКРАН ══════════════════════════════════════════════
async function loadCatalog() {
  state.apps = await api.catalog();
  renderApps();
}
function logoSrc(app) { return app.logo ? `../assets/logos/${app.logo}.png` : null; }
function renderApps() {
  const grid = $("#apps-grid");
  grid.innerHTML = "";
  for (const app of state.apps) {
    const on = state.selected.has(app.key);
    const st = state.owned[app.key];
    const stLabel = { owned: "в покупках", notOwned: "нет в покупках", unavailable: "недоступно", needID: "нужен ID" }[st] || "";
    const div = document.createElement("div");
    div.className = "chip" + (on ? " on" : "");
    const src = logoSrc(app);
    div.innerHTML =
      (src ? `<img class="logo" src="${src}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'logo placeholder',textContent:'${app.name[0]}'}))">`
           : `<div class="logo placeholder">${app.name[0]}</div>`) +
      `<div><div class="nm">${app.name}</div>${stLabel ? `<div class="st ${st}">${stLabel}</div>` : ""}</div>`;
    div.onclick = () => { on ? state.selected.delete(app.key) : state.selected.add(app.key); renderApps(); updateInstallBtn(); };
    grid.appendChild(div);
  }
}
function updateInstallBtn() {
  $("#install").disabled = state.busy || !state.account || !state.device || (state.selected.size === 0 && !state.customId);
}

async function refreshAccount() {
  state.account = await api.accountInfo();
  const dot = $("#ac-dot"), nm = $("#ac-name"), act = $("#ac-actions");
  if (state.account) {
    dot.className = "dot"; nm.textContent = state.account;
    act.innerHTML = `<button class="btn-ghost" id="ac-switch">Сменить</button><button class="btn-ghost" id="ac-out">Выйти</button>`;
    $("#ac-switch").onclick = loginAppleId; $("#ac-out").onclick = async () => { await api.accountLogout(); refreshAccount(); };
  } else {
    dot.className = "dot off"; nm.textContent = "Не подключён";
    act.innerHTML = `<button class="btn-primary" id="ac-in" style="flex:1">Войти в Apple ID</button>`;
    $("#ac-in").onclick = loginAppleId;
  }
  updateInstallBtn();
}

async function refreshDevices() {
  state.devices = await api.devices();
  const prev = state.device;
  if (!state.device || !state.devices.find((d) => d.udid === state.device.udid))
    state.device = state.devices[0] || null;
  const phone = $("#phone"), status = $("#dev-status"), scr = $("#phone-screen"), sel = $("#dev-select");
  if (state.device) {
    phone.className = "phone on"; status.textContent = state.device.name + " · подключён";
    if (!state.busy) scr.innerHTML = `<div>✓<br>${state.device.name}<br><span style="opacity:.7">готов</span></div>`;
  } else {
    phone.className = "phone off"; status.textContent = "iPhone не подключён";
    if (!state.busy) scr.innerHTML = "Подключите<br>iPhone по USB";
  }
  if (state.devices.length > 1) {
    sel.hidden = false; sel.innerHTML = state.devices.map((d) => `<option value="${d.udid}">${d.name}</option>`).join("");
    sel.value = state.device.udid;
    sel.onchange = () => { state.device = state.devices.find((d) => d.udid === sel.value); };
  } else sel.hidden = true;
  updateInstallBtn();
}

function parseId(s) { const d = (s.match(/\d/g) || []).join(""); return d.length >= 5 ? Number(d) : null; }

function wireMain() {
  $("#select-all").onclick = () => {
    if (state.selected.size === state.apps.length) state.selected.clear();
    else state.apps.forEach((a) => state.selected.add(a.key));
    renderApps(); updateInstallBtn();
  };
  $("#check-owned").onclick = checkOwned;
  $("#install").onclick = () => installList(state.apps.filter((a) => state.selected.has(a.key)));
  $("#btn-log").onclick = () => ($("#log-modal").hidden = false);
  $("#log-close").onclick = () => ($("#log-modal").hidden = true);
  $("#add-id").onclick = () => { $("#id-input").value = ""; $("#id-modal").hidden = false; };
  $("#id-close").onclick = () => ($("#id-modal").hidden = true);
  $("#id-install").onclick = () => {
    const id = parseId($("#id-input").value);
    if (!id) return;
    $("#id-modal").hidden = true;
    installList([{ key: "id" + id, name: "App Store ID " + id, appIDs: [id] }]);
  };
  $("#profile").onclick = () => {
    $("#profile-big-ava").textContent = (state.cfg.name || "b")[0].toUpperCase();
    $("#profile-big-name").textContent = state.cfg.name || "Профиль";
    $("#profile-big-email").textContent = state.cfg.email || "";
    $("#profile-modal").hidden = false;
  };
  $("#profile-close").onclick = () => ($("#profile-modal").hidden = true);
  $("#logout-bmrng").onclick = async () => {
    await api.configSet({ registered: false, token: "" });
    location.reload();
  };
}

async function loginAppleId() {
  const email = prompt("Apple ID (email):"); if (!email) return;
  const password = prompt("Пароль Apple ID:"); if (!password) return;
  log(`Вход в Apple ID ${email}…`);
  let r = await api.accountLogin({ email, password });
  if (r.needCode) {
    const code = prompt("Код двухфакторной аутентификации (6 цифр):"); if (!code) return;
    r = await api.accountLogin({ email, password, code });
  }
  if (r.ok) { log("✓ Вход выполнен"); refreshAccount(); }
  else { log("✗ " + (r.error || "не удалось войти")); alert(r.error || "Не удалось войти"); }
}

async function checkOwned() {
  if (!state.account) return alert("Сначала войдите в Apple ID");
  setBusyMain(true); log("Проверка покупок…");
  for (const app of state.apps) {
    state.owned[app.key] = "checking"; renderApps();
    state.owned[app.key] = await api.checkOwned(app); renderApps();
  }
  log("Проверка завершена."); setBusyMain(false);
}

async function installList(list) {
  if (!state.device) return alert("Подключите iPhone");
  if (!state.account) return alert("Войдите в Apple ID");
  if (!list.length) return;
  setBusyMain(true);
  log(`\n── Установка ${list.length} приложени(й) на ${state.device.name} ──`);
  let done = 0;
  for (let i = 0; i < list.length; i++) {
    log(`\n[${i + 1}/${list.length}] ${list[i].name}`);
    const r = await api.install({ app: list[i], udid: state.device.udid });
    if (r.ok) done++;
  }
  log(`\nГотово: ${done} из ${list.length} установлено.`);
  $("#phone-screen").innerHTML = done ? "<div>✓<br>Готово</div>" : "<div>✗<br>Ошибка</div>";
  setBusyMain(false);
  setTimeout(refreshDevices, 2500);
}

function onProgress(m) {
  if (m.line) log("  " + m.line);
  const scr = $("#phone-screen");
  if (m.phase === "download") scr.innerHTML = `<div>↓<br>${m.app || ""}</div>`;
  if (m.phase === "install") scr.innerHTML = `<div style="font-size:22px;font-weight:700">${Math.round((m.progress || 0) * 100)}%</div><div style="opacity:.7">установка</div>`;
}

function setBusyMain(b) { state.busy = b; $("#install").disabled = b; $("#check-owned").disabled = b; }
function log(s) { const el = $("#log"); el.textContent += s + "\n"; el.scrollTop = el.scrollHeight; }
