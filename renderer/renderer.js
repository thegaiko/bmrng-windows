const $ = (s) => document.querySelector(s);
const api = window.bmrng;

// «глазик» показать/скрыть пароль
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.4M6.6 6.6A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 3.4-.66M14 14.12A3 3 0 0 1 9.88 10M1 1l22 22"/></svg>';
function attachEye(input) {
  if (!input || input.dataset.eye) return;
  input.dataset.eye = "1";
  const wrap = document.createElement("div");
  wrap.className = "pw-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "pw-eye"; btn.tabIndex = -1;
  btn.innerHTML = EYE; btn.title = "Показать пароль";
  btn.onclick = () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.innerHTML = show ? EYE_OFF : EYE;
    btn.title = show ? "Скрыть пароль" : "Показать пароль";
    input.focus();
  };
  wrap.appendChild(btn);
}

const state = {
  cfg: {}, apps: [], selected: new Set(), owned: {}, devices: [], device: null,
  account: null, customId: "", busy: false,
  installed: {}, // ключ приложения → { usedIndex, total, exhausted }
  cancelInstall: false,
  pay: { mode: "yookassa", contact: "https://t.me/metagaiko" },
  balance: 0, tuQty: 0, tuDiscount: 0, tuPromo: "",
  onb: { mode: "welcome", step: 0, name: "", email: "", password: "", code: "" },
};
let PRICE = 50; // цена за установку по умолчанию; актуальную берём с бэкенда (/api/me/)

// ══ ИНИЦИАЛИЗАЦИЯ ═══════════════════════════════════════════════
(async function init() {
  state.cfg = await api.configGet();
  if (state.cfg.registered) showApp(); else renderOnboarding();
  api.onInstallProgress(onProgress);
  checkForUpdate();
  try { const pc = await api.payConfig(); if (pc && pc.mode) state.pay = pc; } catch {}
})();

// ══ ОБНОВЛЕНИЯ ══════════════════════════════════════════════════
let updateInfo = null;
async function checkForUpdate() {
  try {
    const r = await api.checkUpdate();
    if (!r || !r.available) return;
    updateInfo = r;
    $("#upd-ver").textContent = `Версия ${r.version} · у вас ${r.current}`;
    $("#upd-notes").textContent = r.notes || "";
    $("#update-modal").hidden = false;
    wireUpdate();
  } catch (e) { /* тихо: обновление не критично */ }
}
let updateWired = false;
function wireUpdate() {
  if (updateWired) return; updateWired = true;
  $("#upd-later").onclick = () => ($("#update-modal").hidden = true);
  api.onUpdateProgress((p) => {
    $("#upd-progress").hidden = false;
    const fill = $("#upd-fill"), txt = $("#upd-progress-text");
    if (p.phase === "download") {
      const pct = Math.round((p.frac || 0) * 100);
      fill.classList.remove("indeterminate"); fill.style.width = pct + "%";
      txt.textContent = `Загрузка… ${pct}%`;
    } else if (p.phase === "install") {
      fill.classList.add("indeterminate"); txt.textContent = "Установка и перезапуск…";
    }
  });
  $("#upd-apply").onclick = async () => {
    $("#upd-apply").disabled = true; $("#upd-later").disabled = true;
    $("#upd-progress").hidden = false;
    const r = await api.applyUpdate(updateInfo);
    if (r && !r.ok) {
      $("#upd-progress-text").textContent = "Ошибка: " + (r.error || "не удалось обновить");
      $("#upd-apply").disabled = false; $("#upd-later").disabled = false;
    }
    // при успехе приложение само закроется и перезапустится
  };
}

function showApp() {
  $("#onboarding").hidden = true;
  $("#app").hidden = false;
  $("#profile-name").textContent = state.cfg.name || "Профиль";
  $("#profile-ava").textContent = (state.cfg.name || "b")[0].toUpperCase();
  loadCatalog();
  refreshAccount();
  refreshDevices();
  refreshBalance();
  setInterval(() => { if (!state.busy) refreshDevices(); }, 3000);
  wireMain();
}

async function refreshBalance() {
  const r = await api.me();
  if (r.status === 200 && r.data) {
    state.balance = r.data.install_balance ?? 0;
    $("#balance-n").textContent = state.balance;
    if (r.data.price_per_install) PRICE = r.data.price_per_install;
  }
}

// ── пополнение ──────────────────────────────────────────────────
function openTopup() {
  state.tuQty = 0; state.tuDiscount = 0; state.tuPromo = "";
  $("#tu-custom").value = ""; $("#tu-promo").value = ""; $("#tu-promo-msg").textContent = "";
  $("#tu-error").textContent = "";
  document.querySelectorAll(".tu-opt").forEach((b) => b.classList.remove("on"));
  const note = $("#tu-price-note");
  if (note) note.textContent = `${PRICE} ₽ за 1 установку. Выберите количество:`;
  updateTuPrice();
  const manual = state.pay && state.pay.mode === "manual";
  $("#tu-manual-note").hidden = !manual;
  $("#tu-pay").textContent = manual ? "Написать в Telegram" : "Оформить";
  $("#topup-modal").hidden = false;
}
function setTuQty(q, fromCustom) {
  state.tuQty = q;
  document.querySelectorAll(".tu-opt").forEach((b) => b.classList.toggle("on", !fromCustom && Number(b.dataset.q) === q));
  if (!fromCustom) $("#tu-custom").value = "";
  updateTuPrice();
}
function updateTuPrice() {
  const q = state.tuQty;
  const el = $("#tu-price"), pay = $("#tu-pay");
  const manual = state.pay && state.pay.mode === "manual";
  if (!q || q < 1) { el.textContent = "Итого: —"; pay.disabled = manual ? false : true; return; }
  const full = PRICE * q;
  const total = Math.round(full * (100 - state.tuDiscount) / 100);
  el.innerHTML = state.tuDiscount
    ? `Итого: <s>${full} ₽</s> ${total} ₽`
    : `Итого: ${total} ₽`;
  pay.disabled = false;
}
async function applyPromo() {
  const code = $("#tu-promo").value.trim();
  if (!code) { state.tuDiscount = 0; state.tuPromo = ""; $("#tu-promo-msg").textContent = ""; updateTuPrice(); return; }
  const r = await api.promoValidate({ code });
  if (r.status === 200) {
    state.tuDiscount = r.data.discount_percent; state.tuPromo = r.data.code;
    $("#tu-promo-msg").style.color = "var(--good)";
    $("#tu-promo-msg").textContent = `Промокод применён: −${r.data.discount_percent}%`;
  } else {
    state.tuDiscount = 0; state.tuPromo = "";
    $("#tu-promo-msg").style.color = "var(--danger)";
    $("#tu-promo-msg").textContent = r.data.detail || "Промокод недоступен";
  }
  updateTuPrice();
}
async function submitTopup() {
  // временный режим: онлайн-оплата отключена → открываем Telegram
  if (state.pay && state.pay.mode === "manual") {
    api.openExternal(state.pay.contact || "https://t.me/metagaiko");
    $("#topup-modal").hidden = true;
    return;
  }
  if (!state.tuQty) return;
  $("#tu-pay").disabled = true; $("#tu-error").textContent = "";
  const r = await api.topup({ quantity: state.tuQty, code: state.tuPromo || undefined });
  $("#tu-pay").disabled = false;
  if (r.status === 201 && r.data.confirmation_url) {
    $("#topup-modal").hidden = true;
    log(`Заказ №${r.data.order_id}: ${r.data.quantity} установок за ${r.data.total_price} ₽ — открываю оплату в браузере…`);
    api.openExternal(r.data.confirmation_url);
    pollBalanceAfterPayment();
  } else if (r.status === 201 && (r.data.free || r.data.status === "paid")) {
    // 100% промокод — оплата не нужна, баланс уже начислен
    $("#topup-modal").hidden = true;
    log(`Промокод −100%: начислено ${r.data.quantity} установок бесплатно.`);
    refreshBalance();
  } else if (r.status === 201) {
    $("#tu-error").textContent = "Платёж создан, но ссылка на оплату не получена";
  } else {
    $("#tu-error").textContent = r.data.detail || "Не удалось оформить";
  }
}
// После оплаты вебхук начислит баланс на сервере — периодически обновляем.
function pollBalanceAfterPayment() {
  let ticks = 0;
  const t = setInterval(() => { ticks++; refreshBalance(); if (ticks >= 24) clearInterval(t); }, 5000);
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
    attachEye($("#f-pass"));
    $("#f-pass").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
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
  if (f.type === "password") attachEye($("#f-val"));
  if (o.step === 4) { $("#f-val").inputMode = "numeric"; $("#f-val").autocomplete = "one-time-code"; }
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
    const codeVal = val.replace(/\D/g, "");           // только цифры — убирает пробелы/вставленный мусор
    if (!codeVal) return err("Введите код"); o.code = codeVal; setBusy(true);
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
function logoSrc(app) { return app.icon || (app.logo ? `../assets/logos/${app.logo}.png` : null); }
function usedAppId(app, idx) { return (app.appIDs && idx >= 0 && app.appIDs[idx] != null) ? String(app.appIDs[idx]) : ""; }
// зафиксировать установку в журнале на бэкенде (для админки: кто/когда/что/куда)
function logInstall(app, usedIndex) {
  try {
    api.installLog({
      app_key: app.key, app_name: app.name, app_id: usedAppId(app, usedIndex),
      device_name: (state.device && state.device.name) || "", device_udid: (state.device && state.device.udid) || "",
    });
  } catch { /* журнал не критичен */ }
}
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
    const inst = state.installed[app.key];
    let retryHtml = "";
    if (inst) {
      const hasMore = !inst.exhausted && inst.usedIndex + 1 < inst.total;
      retryHtml = hasMore
        ? `<button class="retry-ver" data-key="${app.key}">↻ Не работает? Другая версия</button>`
        : `<div class="retry-done">Все версии перепробованы</div>`;
    }
    div.innerHTML =
      (src ? `<img class="logo" src="${src}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'logo placeholder',textContent:'${app.name[0]}'}))">`
           : `<div class="logo placeholder">${app.name[0]}</div>`) +
      `<div style="flex:1"><div class="nm">${app.name}</div>${stLabel ? `<div class="st ${st}">${stLabel}</div>` : ""}${retryHtml}</div>`;
    div.onclick = () => { on ? state.selected.delete(app.key) : state.selected.add(app.key); renderApps(); updateInstallBtn(); };
    const rb = div.querySelector(".retry-ver");
    if (rb) rb.onclick = (ev) => { ev.stopPropagation(); tryNextVersion(app); };
    grid.appendChild(div);
  }
}

// Попробовать следующий App Store ID того же приложения (бесплатно — это повтор той же установки).
async function tryNextVersion(app) {
  const info = state.installed[app.key];
  if (!info || state.busy) return;
  const next = info.usedIndex + 1;
  if (next >= info.total) return;
  if (!state.device) return alert("Подключите iPhone");
  if (!state.account) return alert("Войдите в Apple ID");
  state.cancelInstall = false;
  setBusyMain(true); showCancel(true); showProgress(true); setBar(null, "Другая версия…");
  log(`\n↻ ${app.name}: пробую другую версию (вариант ${next + 1}/${info.total})…`);
  const r = await api.install({ app, udid: state.device.udid, fromIndex: next });
  showCancel(false);
  if (r.cancelled || state.cancelInstall) {
    log("⏹ Отменено"); setBar(0, "Отменено");
    setBusyMain(false); renderApps(); updateInstallBtn();
    setTimeout(() => showProgress(false), 3000);
    return;
  }
  if (r.ok) {
    state.installed[app.key] = { usedIndex: r.usedIndex, total: r.total };
    logInstall(app, r.usedIndex);
    log(`✓ Установлена версия ${r.usedIndex + 1}/${r.total}. Проверьте — если снова не работает, жмите ещё раз.`);
    setBar(1, `Готово: вариант ${r.usedIndex + 1}/${r.total}`);
  } else {
    if (r.exhausted) { state.installed[app.key].exhausted = true; log("✗ Больше версий для этого приложения нет."); }
    else log(`✗ ${r.error || "не удалось установить эту версию"}`);
    setBar(0, "Не удалось");
    if (r.notOwned) showNotOwnedModal([app.name]);
    else if (r.corrupt || r.netError) showCorruptModal([{ name: app.name, freeGB: r.freeGB, badMB: r.badMB, netError: r.netError }]);
  }
  setBusyMain(false); renderApps(); updateInstallBtn();
  setTimeout(() => showProgress(false), 3000);
  setTimeout(refreshDevices, 2500);
}

function showNotOwnedModal(names) {
  const list = $("#notowned-list");
  list.textContent = names.length === 1 ? `«${names[0]}»` : names.map((n) => `«${n}»`).join(", ");
  $("#notowned-modal").hidden = false;
}

function showCorruptModal(items) {
  const names = items.map((x) => x.name);
  const net = items.some((x) => x.netError);
  const lowDisk = items.some((x) => x.freeGB != null && x.freeGB < 2);
  const freeGB = items.map((x) => x.freeGB).find((g) => g != null);
  const badMB = items.map((x) => x.badMB).find((m) => m != null);
  $("#corrupt-list").textContent = names.length === 1 ? `«${names[0]}»` : names.map((n) => `«${n}»`).join(", ");
  const diskEl = $("#corrupt-disk");
  if (net) {
    $("#corrupt-title").textContent = "Нет связи с серверами Apple";
    $("#corrupt-msg").textContent = "Приложение не может связаться с серверами загрузки Apple (iTunes). Проверьте интернет. Если вы в России — включите или смените VPN (серверы Apple часто недоступны без него). Можно также сменить DNS на 1.1.1.1 или 8.8.8.8. Затем повторите.";
    diskEl.textContent = ""; diskEl.style.color = "var(--dim)";
  } else if (lowDisk) {
    $("#corrupt-title").textContent = "Файл повреждается при загрузке";
    $("#corrupt-msg").textContent = "На диске мало места — приложению нужно 1–2 ГБ свободно (при установке файл копируется). Освободите место и попробуйте снова.";
    diskEl.textContent = freeGB != null ? `Сейчас свободно: ${freeGB} ГБ.` : "";
    diskEl.style.color = "var(--danger)";
  } else {
    $("#corrupt-title").textContent = "Файл повреждается при загрузке";
    $("#corrupt-msg").textContent = "Приложение скачивается повреждённым. Место на диске в порядке — чаще всего причина в нестабильном интернете или VPN. Попробуйте сменить сеть (Wi-Fi ↔ моб. интернет), отключить VPN и повторить.";
    diskEl.textContent = (freeGB != null ? `Свободно: ${freeGB} ГБ. ` : "") + (badMB != null ? `Скачалось: ${badMB} МБ.` : "");
    diskEl.style.color = "var(--dim)";
  }
  $("#corrupt-modal").hidden = false;
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
  $("#cancel-install").onclick = async () => {
    state.cancelInstall = true;
    $("#cancel-install").disabled = true;
    log("⏹ Отмена…"); setBar(null, "Отмена…");
    await api.cancelInstall();
  };
  $("#refresh-balance").onclick = async (e) => {
    const b = e.currentTarget; b.classList.remove("spin"); void b.offsetWidth; b.classList.add("spin");
    await refreshBalance();
  };
  $("#btn-support").onclick = () => api.openExternal("https://t.me/metagaiko");
  $("#notowned-ok").onclick = () => ($("#notowned-modal").hidden = true);
  $("#corrupt-ok").onclick = () => ($("#corrupt-modal").hidden = true);
  $("#foot-site").onclick = () => api.openExternal("https://bmrng.app");
  $("#foot-tg").onclick = () => api.openExternal("https://t.me/thegaiko");
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
  $("#topup").onclick = openTopup;
  $("#tu-close").onclick = () => ($("#topup-modal").hidden = true);
  document.querySelectorAll(".tu-opt").forEach((b) => (b.onclick = () => setTuQty(Number(b.dataset.q), false)));
  $("#tu-custom").oninput = () => setTuQty(Number($("#tu-custom").value) || 0, true);
  $("#tu-promo-apply").onclick = applyPromo;
  $("#tu-pay").onclick = submitTopup;
  $("#ai-close").onclick = () => ($("#appleid-modal").hidden = true);
  $("#ai-login").onclick = doAppleLogin;
  attachEye($("#ai-pass"));
  $("#ai-pass").onkeydown = (e) => { if (e.key === "Enter") doAppleLogin(); };
  $("#ai-code").onkeydown = (e) => { if (e.key === "Enter") doAppleLogin(); };
  $("#logout-bmrng").onclick = async () => {
    await api.configSet({ registered: false, token: "" });
    location.reload();
  };
}

function loginAppleId() {
  $("#ai-email").value = ""; $("#ai-pass").value = ""; $("#ai-code").value = "";
  $("#ai-code").hidden = true; $("#ai-error").textContent = "";
  $("#appleid-modal").hidden = false;
  setTimeout(() => $("#ai-email").focus(), 50);
}
async function doAppleLogin() {
  const email = $("#ai-email").value.trim();
  const password = $("#ai-pass").value;
  const code = $("#ai-code").value.trim();
  if (!email || !password) { $("#ai-error").textContent = "Введите Apple ID и пароль"; return; }
  $("#ai-login").disabled = true; $("#ai-error").textContent = "Вход…";
  log(`Вход в Apple ID ${email}…`);
  const r = await api.accountLogin(code ? { email, password, code } : { email, password });
  $("#ai-login").disabled = false;
  if (r.raw) log("  ipatool: " + r.raw);
  if (r.ok) { $("#appleid-modal").hidden = true; log("✓ Вход выполнен"); refreshAccount(); return; }
  if (r.needCode) {
    $("#ai-code").hidden = false; setTimeout(() => $("#ai-code").focus(), 50);
    $("#ai-error").textContent = "Код отправлен на ваши устройства Apple — введите его сюда";
    log("Требуется код 2FA — показываю поле");
    return;
  }
  $("#ai-error").textContent = r.error || "Не удалось войти";
  log("✗ " + (r.error || "не удалось войти"));
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
  await refreshBalance();
  if (state.balance <= 0) { openTopup(); alert("Закончились установки — пополните баланс."); return; }
  state.cancelInstall = false;
  setBusyMain(true); showCancel(true);
  showProgress(true); setBar(null, "Подготовка…");
  log(`\n── Установка ${list.length} приложени(й) на ${state.device.name} ──`);
  let done = 0;
  const notOwned = [];
  const corrupt = [];
  let cancelled = false;
  for (let i = 0; i < list.length; i++) {
    if (state.cancelInstall) { cancelled = true; break; }
    if (state.balance <= 0) { log("✗ Закончились установки"); setBusyMain(false); openTopup(); break; }
    log(`\n[${i + 1}/${list.length}] ${list[i].name}`);
    const r = await api.install({ app: list[i], udid: state.device.udid });
    if (r.cancelled || state.cancelInstall) { cancelled = true; log("⏹ Установка отменена"); break; }
    if (r.ok) {
      done++;
      if ((r.total || 1) > 1) { state.installed[list[i].key] = { usedIndex: r.usedIndex, total: r.total }; renderApps(); }
      logInstall(list[i], r.usedIndex);
      const c = await api.consume();
      if (c.status === 200) { state.balance = c.data.balance; $("#balance-n").textContent = state.balance; }
    } else if (r.notOwned) {
      notOwned.push(list[i].name);
      log(`  ✗ нет в покупках этого Apple ID`);
    } else if (r.corrupt || r.netError) {
      corrupt.push({ name: list[i].name, freeGB: r.freeGB, badMB: r.badMB, netError: r.netError });
      log(r.netError ? `  ✗ нет связи с серверами Apple` : `  ✗ файл повреждается при загрузке`);
    }
  }
  showCancel(false);
  if (cancelled) {
    log(`\n⏹ Отменено. Установлено: ${done} из ${list.length}.`);
    $("#phone-screen").innerHTML = "<div>⏹<br>Отменено</div>";
    setBar(0, `Отменено · установлено ${done}`);
  } else {
    log(`\nГотово: ${done} из ${list.length} установлено.`);
    $("#phone-screen").innerHTML = done ? "<div>✓<br>Готово</div>" : "<div>✗<br>Ошибка</div>";
    setBar(done ? 1 : 0, done ? `Установлено: ${done} из ${list.length}` : "Не удалось");
  }
  setBusyMain(false);
  if (notOwned.length && !cancelled) showNotOwnedModal(notOwned);
  else if (corrupt.length && !cancelled) showCorruptModal(corrupt);
  setTimeout(() => showProgress(false), 3000);
  setTimeout(refreshDevices, 2500);
}

function onProgress(m) {
  if (m.line) log("  " + m.line);
  const scr = $("#phone-screen");
  showProgress(true);
  if (m.phase === "download") {
    const mb = m.bytes ? (m.bytes / 1048576).toFixed(0) + " МБ" : "";
    setBar(null, `Скачивание${m.app ? " " + m.app : ""}${mb ? " · " + mb : "…"}`);
    scr.innerHTML = `<div>↓<br>${m.app || ""}${mb ? `<br><span style="opacity:.7;font-size:10px">${mb}</span>` : ""}</div>`;
  } else if (m.phase === "install") {
    const p = m.progress || 0;
    setBar(p, `Установка · ${Math.round(p * 100)}%`);
    scr.innerHTML = `<div style="font-size:22px;font-weight:700">${Math.round(p * 100)}%</div><div style="opacity:.7">установка</div>`;
  } else if (m.phase === "done") {
    setBar(1, "Готово");
  } else if (m.phase === "error") {
    setBar(0, "Ошибка");
  }
}
function showProgress(on) { $("#progress").hidden = !on; }
function showCancel(on) {
  $("#cancel-install").hidden = !on;
  $("#cancel-install").disabled = false;
  $("#install").hidden = on;
}
function setBar(p, text) {
  const fill = $("#bar-fill");
  if (p === null || p === undefined) fill.classList.add("indeterminate");
  else { fill.classList.remove("indeterminate"); fill.style.width = Math.round(p * 100) + "%"; }
  $("#progress-text").textContent = text || "";
}

function setBusyMain(b) { state.busy = b; $("#install").disabled = b; $("#check-owned").disabled = b; }
function log(s) { const el = $("#log"); el.textContent += s + "\n"; el.scrollTop = el.scrollHeight; }
