(function () {
  "use strict";
  var C = window.APP_CONFIG, L = window.Logic;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  var HEADERS = {
    Settings: ["key", "value"],
    Items: ["id", "section", "item", "every_km", "every_months", "last_km", "last_date", "notes"],
    Log: ["date", "km", "done", "cost", "place", "notes"]
  };
  var STATUS = {
    overdue: ["متأخر", "bad"], soon: ["قرّب", "warn"], ok: ["تمام", "good"], unset: ["سجّل آخر مرة", "muted-chip"]
  };
  var ORDER = { overdue: 0, soon: 1, unset: 2, ok: 3 };

  var S = { email: null, settings: {}, items: [], log: [], tab: "items", fSection: "", fStatus: "" };

  /* ---------- small utils ---------- */
  function today() { return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }); }
  function fmt(n) { return n === null || n === undefined || n === "" ? "—" : Number(n).toLocaleString("en-US"); }
  function toast(msg, bad) {
    var t = $("#toast");
    t.textContent = msg; t.className = "show" + (bad ? " bad-toast" : "");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = ""; }, 3500);
  }
  function show(id, on) { $(id).hidden = !on; }

  /* ---------- Google sign-in + Sheets API ----------
     The data lives in YOUR private Google Sheet. This page holds no data: Google only lets the
     account(s) the Sheet is shared with read or write it, so the sign-in is real access control. */
  var SCOPE = "https://www.googleapis.com/auth/spreadsheets openid email";
  var BASE = "https://sheets.googleapis.com/v4/spreadsheets/" + C.SHEET_ID;
  var tokenClient = null, accessToken = null, tokenExp = 0;

  function loginMsg(msg) { $("#loginMsg").textContent = msg || ""; }

  function initGoogle() {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: C.GOOGLE_CLIENT_ID, scope: SCOPE, callback: onToken,
      error_callback: function (e) {
        loginMsg(e && e.type === "popup_closed" ? "اتقفل شباك الدخول. جرّب تاني." : "تعذّر الدخول (" + ((e && e.type) || "?") + ").");
      }
    });
    $("#signin").disabled = false;
  }
  function waitForGoogle() {
    if (window.google && google.accounts && google.accounts.oauth2) initGoogle();
    else setTimeout(waitForGoogle, 150);
  }
  function signIn() { loginMsg(""); if (tokenClient) tokenClient.requestAccessToken(); }

  function revoke() {
    try { if (accessToken && window.google) google.accounts.oauth2.revoke(accessToken, function () {}); } catch (_) {}
    accessToken = null; tokenExp = 0;
  }

  async function onToken(resp) {
    if (!resp || resp.error) return loginMsg("تعذّر الدخول: " + ((resp && resp.error) || ""));
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, "https://www.googleapis.com/auth/spreadsheets"))
      return loginMsg("لازم توافق على صلاحية Google Sheets عشان التطبيق يشتغل.");
    accessToken = resp.access_token;
    tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
    try {
      var r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + accessToken } });
      var u = await r.json();
      var email = String(u.email || "").toLowerCase();
      if (!u.email_verified || !/@gmail\.com$/.test(email)) { revoke(); return loginMsg("المسموح بحسابات Gmail بس."); }
      S.email = email;
    } catch (e) { return loginMsg("تعذّر التحقق من الحساب."); }
    enter();
  }

  function logout() {
    revoke();
    location.reload();
  }

  async function api(path, opts) {
    opts = opts || {};
    if (!accessToken || Date.now() > tokenExp) { var x = new Error("expired"); x.status = 401; throw x; }
    var r = await fetch(BASE + path, {
      method: opts.method || "GET", cache: "no-store",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!r.ok) {
      var e = new Error("Sheets " + r.status); e.status = r.status;
      try { e.detail = (await r.json()).error.message; } catch (_) {}
      throw e;
    }
    return r.json();
  }

  function tabRows(vr) {
    var v = (vr && vr.values) || [];
    if (!v.length) return [];
    var h = v[0].map(function (x) { return String(x).trim(); });
    return v.slice(1).filter(function (r) {
      return r.some(function (c) { return c !== "" && c !== null && c !== undefined; });
    }).map(function (r) {
      var o = {};
      h.forEach(function (k, i) { if (k) o[k] = r[i] === undefined ? "" : r[i]; });
      return o;
    });
  }

  async function loadData() {
    var j = await api("/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS&ranges=Settings&ranges=Items&ranges=Log");
    var vr = j.valueRanges || [];
    S.settings = {};
    tabRows(vr[0]).forEach(function (r) { if (r.key) S.settings[String(r.key).trim()] = r.value; });
    S.items = tabRows(vr[1]).map(function (r) {
      return {
        id: L.num(r.id), section: r.section, item: r.item,
        every_km: L.num(r.every_km), every_months: L.num(r.every_months),
        last_km: L.num(r.last_km), last_date: L.normDate(r.last_date), notes: r.notes
      };
    });
    S.log = tabRows(vr[2]).map(function (r) {
      return { date: L.normDate(r.date), km: L.num(r.km), done: r.done, cost: L.num(r.cost), place: r.place, notes: r.notes };
    });
  }

  function cell(v) { return v === null || v === undefined ? "" : v; }
  function toValues(h, rows) {
    return [h].concat(rows.map(function (r) { return h.map(function (k) { return cell(r[k]); }); }));
  }
  function backToLogin(msg) { show("#app", false); show("#login", true); loginMsg(msg); }

  // Writes all three tabs (overwrite first, then clear any leftover rows, so a failure never loses data).
  async function save() {
    var settingsRows = Object.keys(S.settings).map(function (k) { return { key: k, value: S.settings[k] }; });
    var tabs = [["Settings", settingsRows], ["Items", S.items], ["Log", S.log]];
    var data = tabs.map(function (p) {
      return { range: p[0] + "!A1", majorDimension: "ROWS", values: toValues(HEADERS[p[0]], p[1]) };
    });
    try {
      await api("/values:batchUpdate", { method: "POST", body: { valueInputOption: "RAW", data: data } });
      await api("/values:batchClear", { method: "POST", body: { ranges: tabs.map(function (p) { return p[0] + "!A" + (p[1].length + 2) + ":Z2000"; }) } });
      toast("اتحفظ ✔");
      return true;
    } catch (e) {
      if (e.status === 401) { toast("انتهت الجلسة. سجّل دخول تاني وكرّر التعديل.", true); backToLogin("انتهت الجلسة. سجّل دخول تاني."); }
      else if (e.status === 403) toast("الحساب ده مالوش صلاحية تعديل على الشيت.", true);
      else toast("فشل الحفظ: " + e.message, true);
      return false;
    }
  }

  /* ---------- screens ---------- */
  async function enter() {
    show("#login", false);
    $("#whoEmail").textContent = S.email;
    try {
      await loadData();
      show("#app", true);
      render();
    } catch (e) {
      if (e.status === 401) backToLogin("انتهت الجلسة. سجّل دخول تاني.");
      else if (e.status === 403) { var who = S.email; revoke(); backToLogin("الحساب " + who + " مالوش صلاحية على الشيت. شارك الشيت مع الحساب ده أو سجّل بحساب تاني."); }
      else if (e.status === 404) backToLogin("الشيت مش موجود. راجع SHEET_ID في config.js.");
      else if (e.status === 400) backToLogin("الشيت لازم يكون فيه 3 تابات بالأسماء: Settings و Items و Log.");
      else backToLogin("تعذّر تحميل البيانات: " + e.message);
    }
  }

  function computed() {
    var t = today();
    return S.items.map(function (it) { return { it: it, st: L.computeStatus(it, S.settings, t) }; });
  }

  function renderHeader(rows) {
    $("#odoInput").value = S.settings.current_odometer === undefined ? "" : S.settings.current_odometer;
    var c = { overdue: 0, soon: 0, ok: 0, unset: 0 };
    rows.forEach(function (r) { c[r.st.status]++; });
    $("#pills").innerHTML = ["overdue", "soon", "ok", "unset"].map(function (k) {
      return '<span class="pill ' + STATUS[k][1] + '">' + STATUS[k][0] + ": " + c[k] + "</span>";
    }).join("");
  }

  function dueText(st) {
    var out = [];
    if (st.dueKm !== null) {
      var k = st.kmLeft === null ? "عند " + fmt(st.dueKm) + " كم"
        : st.kmLeft < 0 ? "متأخر " + fmt(-st.kmLeft) + " كم" : "باقي " + fmt(st.kmLeft) + " كم";
      out.push(k + '<div class="sub">عند ' + fmt(st.dueKm) + "</div>");
    }
    if (st.dueDate) {
      out.push((st.daysLeft < 0 ? "متأخر " + (-st.daysLeft) + " يوم" : "باقي " + st.daysLeft + " يوم") +
        '<div class="sub">' + st.dueDate + "</div>");
    }
    return out.join("") || '<span class="muted">—</span>';
  }

  function renderItems() {
    var rows = computed();
    var sections = Array.from(new Set(S.items.map(function (i) { return i.section; })));
    var list = rows.filter(function (r) {
      return (!S.fSection || r.it.section === S.fSection) && (!S.fStatus || r.st.status === S.fStatus);
    }).sort(function (a, b) { return ORDER[a.st.status] - ORDER[b.st.status] || a.it.id - b.it.id; });

    var html = '<div class="filters">' +
      '<select id="fSection"><option value="">كل الأقسام</option>' +
      sections.map(function (s) { return '<option ' + (s === S.fSection ? "selected " : "") + 'value="' + esc(s) + '">' + esc(s) + "</option>"; }).join("") +
      "</select>" +
      '<select id="fStatus"><option value="">كل الحالات</option>' +
      Object.keys(STATUS).map(function (k) { return '<option ' + (k === S.fStatus ? "selected " : "") + 'value="' + k + '">' + STATUS[k][0] + "</option>"; }).join("") +
      "</select>" +
      '<button id="addItem" class="primary">+ بند جديد</button></div>' +
      '<div class="tablewrap"><table><thead><tr><th>البند</th><th>كل</th><th>آخر مرة</th><th>الاستحقاق</th><th>الحالة</th><th></th></tr></thead><tbody>' +
      list.map(function (r) {
        var it = r.it, every = [];
        if (it.every_km) every.push(fmt(it.every_km) + " كم");
        if (it.every_months) every.push(it.every_months + " شهر");
        var last = [];
        if (it.last_km !== null) last.push(fmt(it.last_km) + " كم");
        if (it.last_date) last.push(it.last_date);
        return '<tr><td class="ttl"><b>' + esc(it.item) + '</b><div class="sub">' + esc(it.section) + "</div></td>" +
          '<td data-l="كل"><div class="v">' + (every.join("<br>") || "—") + "</div></td>" +
          '<td data-l="آخر مرة"><div class="v">' + (last.join("<br>") || '<span class="muted">—</span>') + "</div></td>" +
          '<td data-l="الاستحقاق"><div class="v">' + dueText(r.st) + "</div></td>" +
          '<td data-l="الحالة"><span class="chip ' + STATUS[r.st.status][1] + '">' + STATUS[r.st.status][0] + "</span></td>" +
          '<td class="actions"><button class="primary" data-act="done" data-id="' + it.id + '">تم الآن</button> ' +
          '<button data-act="edit" data-id="' + it.id + '">تعديل</button></td></tr>';
      }).join("") + "</tbody></table></div>";
    $("#view").innerHTML = html;
    $("#fSection").onchange = function (e) { S.fSection = e.target.value; renderItems(); };
    $("#fStatus").onchange = function (e) { S.fStatus = e.target.value; renderItems(); };
    $("#addItem").onclick = function () { editItem(null); };
    document.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () {
        var it = S.items.find(function (x) { return String(x.id) === b.dataset.id; });
        if (b.dataset.act === "done") markDone(it); else editItem(it);
      };
    });
  }

  function renderLog() {
    var rows = S.log.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.km || 0) - (a.km || 0); });
    var total = S.log.reduce(function (s, r) { return s + (r.cost || 0); }, 0);
    $("#view").innerHTML = '<p class="muted">إجمالي التكلفة المسجّلة: <b>' + fmt(total) + ' ج</b></p>' +
      '<div class="tablewrap"><table><thead><tr><th>اللي اتعمل</th><th>التاريخ</th><th>العداد</th><th>التكلفة</th><th>المكان</th><th>ملاحظات</th></tr></thead><tbody>' +
      (rows.map(function (r) {
        return '<tr><td class="ttl"><b>' + esc(r.done) + '</b></td><td data-l="التاريخ">' + esc(r.date || "—") + '</td><td data-l="العداد">' + fmt(r.km) +
          '</td><td data-l="التكلفة">' + fmt(r.cost) + '</td><td data-l="المكان">' + esc(r.place) + '</td><td data-l="ملاحظات">' + esc(r.notes) + "</td></tr>";
      }).join("") || '<tr><td colspan="6" class="muted">مفيش سجل لسه.</td></tr>') + "</tbody></table></div>";
  }

  function renderSettings() {
    var s = S.settings;
    $("#view").innerHTML = '<div class="card">' +
      '<div class="field"><label>إيميل التنبيهات (اختياري؛ لو الريبو public الأفضل تسيبه فاضي واستخدم secret اسمه REMINDER_TO)</label><input id="sEmail" dir="ltr" value="' + esc(s.owner_email || "") + '"></div>' +
      '<div class="field"><label>نبّهني قبل الاستحقاق بكام كم</label><input id="sKm" type="number" value="' + esc(s.warn_km) + '"></div>' +
      '<div class="field"><label>نبّهني قبل الاستحقاق بكام يوم</label><input id="sDays" type="number" value="' + esc(s.warn_days) + '"></div>' +
      '<div class="field"><label>كرّر التنبيه كل كام يوم (لو مفيش جديد)</label><input id="sEvery" type="number" value="' + esc(s.remind_every_days) + '"></div>' +
      '<button id="sSave" class="primary">حفظ الإعدادات</button></div>';
    $("#sSave").onclick = async function (e) {
      e.target.disabled = true;
      S.settings.owner_email = $("#sEmail").value.trim();
      S.settings.warn_km = L.num($("#sKm").value) === null ? 1000 : L.num($("#sKm").value);
      S.settings.warn_days = L.num($("#sDays").value) === null ? 30 : L.num($("#sDays").value);
      S.settings.remind_every_days = L.num($("#sEvery").value) || 7;
      await save("Update settings via app");
      e.target.disabled = false; render();
    };
  }

  function render() {
    renderHeader(computed());
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === S.tab); });
    if (S.tab === "items") renderItems(); else if (S.tab === "log") renderLog(); else renderSettings();
  }

  /* ---------- dialogs ---------- */
  function openForm(title, fields, onSubmit, extra) {
    var d = $("#dlg");
    d.innerHTML = "<form method=\"dialog\"><h2>" + esc(title) + "</h2>" +
      fields.map(function (f) {
        var input = f.type === "textarea"
          ? '<textarea name="' + f.name + '" rows="3">' + esc(f.value) + "</textarea>"
          : '<input name="' + f.name + '" type="' + (f.type || "text") + '" value="' + esc(f.value) + '"' + (f.type === "number" ? ' inputmode="numeric"' : "") + ">";
        return '<div class="field"><label>' + esc(f.label) + "</label>" + input + "</div>";
      }).join("") +
      '<div class="btns"><button type="submit" value="ok" class="primary">حفظ</button>' +
      '<button type="button" value="cancel" id="dCancel">إلغاء</button>' +
      (extra ? '<button type="button" id="dExtra" class="danger">' + extra.label + "</button>" : "") + "</div></form>";
    d.showModal();
    $("#dCancel").onclick = function () { d.close(); };
    if (extra) $("#dExtra").onclick = function () { d.close(); extra.run(); };
    d.querySelector("form").onsubmit = async function (ev) {
      ev.preventDefault();
      var data = {};
      new FormData(ev.target).forEach(function (v, k) { data[k] = v; });
      var btn = d.querySelector(".primary"); btn.disabled = true;
      await onSubmit(data);
      d.close();
    };
  }

  function markDone(it) {
    openForm("تم: " + it.item, [
      { name: "km", label: "العداد (كم)", type: "number", value: S.settings.current_odometer },
      { name: "date", label: "التاريخ", type: "date", value: today() },
      { name: "cost", label: "التكلفة (ج) - اختياري", type: "number", value: "" },
      { name: "place", label: "المكان / الورشة - اختياري", value: "" },
      { name: "notes", label: "ملاحظات - اختياري", value: "" }
    ], async function (d) {
      var km = L.num(d.km), date = L.normDate(d.date) || today();
      if (km === null) { toast("اكتب العداد.", true); return; }
      it.last_km = km; it.last_date = date;
      S.log.push({ date: date, km: km, done: it.item, cost: L.num(d.cost), place: d.place, notes: d.notes });
      if (km > (L.num(S.settings.current_odometer) || 0)) { S.settings.current_odometer = km; S.settings.odometer_updated = today(); }
      await save("Done: " + it.item); render();
    });
  }

  function editItem(it) {
    var isNew = !it;
    var cur = it || { section: "", item: "", every_km: "", every_months: "", last_km: "", last_date: "", notes: "" };
    openForm(isNew ? "بند جديد" : "تعديل: " + it.item, [
      { name: "section", label: "القسم", value: cur.section },
      { name: "item", label: "البند", value: cur.item },
      { name: "every_km", label: "كل كام كم (اختياري)", type: "number", value: cur.every_km === null ? "" : cur.every_km },
      { name: "every_months", label: "كل كام شهر (اختياري)", type: "number", value: cur.every_months === null ? "" : cur.every_months },
      { name: "last_km", label: "آخر مرة - كم", type: "number", value: cur.last_km === null ? "" : cur.last_km },
      { name: "last_date", label: "آخر مرة - تاريخ", type: "date", value: cur.last_date },
      { name: "notes", label: "ملاحظات", type: "textarea", value: cur.notes }
    ], async function (d) {
      if (!d.item.trim()) { toast("اكتب اسم البند.", true); return; }
      var target = it;
      if (isNew) {
        target = { id: S.items.reduce(function (m, x) { return Math.max(m, x.id || 0); }, 0) + 1 };
        S.items.push(target);
      }
      target.section = d.section.trim(); target.item = d.item.trim();
      target.every_km = L.num(d.every_km); target.every_months = L.num(d.every_months);
      target.last_km = L.num(d.last_km); target.last_date = L.normDate(d.last_date); target.notes = d.notes;
      await save((isNew ? "Add item: " : "Edit item: ") + target.item); render();
    }, isNew ? null : {
      label: "حذف البند",
      run: async function () {
        if (!confirm("متأكد إنك عايز تمسح \"" + it.item + "\"؟")) return;
        S.items = S.items.filter(function (x) { return x !== it; });
        await save("Delete item: " + it.item); render();
      }
    });
  }

  /* ---------- wiring ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    $("#logout").onclick = logout;
    $("#signin").onclick = signIn;
    $("#odoSave").onclick = async function (e) {
      var v = L.num($("#odoInput").value);
      if (v === null || v < 0) { toast("اكتب رقم صح.", true); return; }
      var prev = L.num(S.settings.current_odometer);
      if (prev !== null && v < prev && !confirm("الرقم أقل من المسجّل (" + fmt(prev) + "). متأكد؟")) return;
      e.target.disabled = true;
      S.settings.current_odometer = v; S.settings.odometer_updated = today();
      await save("Update odometer: " + v);
      e.target.disabled = false; render();
    };
    document.querySelectorAll(".tabs button").forEach(function (b) {
      b.onclick = function () { S.tab = b.dataset.tab; render(); };
    });
    waitForGoogle();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
  });
})();
