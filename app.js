/* ============================================================
   Telangana Nethra — UI layer
   Binds the page to window.WI (the engine). No frameworks, no
   build step, no fetch — works on file:// and on GitHub Pages.
   ============================================================ */
(function () {
  "use strict";
  var WI = window.WI;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]; }); }
  function fmt(n) { return (Math.round(n) || 0).toLocaleString("en-IN"); }
  function rupee(n) { return "₹" + fmt(n); }

  var DOM_LABEL = { dengue: "Dengue", heat: "Heat illness", ncd: "BP / Sugar (NCD)", vaccine: "Vaccine", maternal: "Maternal", rabies: "Rabies" };
  var districts = WI.districts();
  var domains = WI.domains;

  /* score -> semantic colour (epidemiological state) */
  function scoreColor(s) { return s >= 0.66 ? "#F0654A" : s >= 0.45 ? "#F2B23C" : "#36D6C2"; }
  function pct(x) { return Math.round(x * 100) + "%"; }

  /* ---------- populate selects ---------- */
  function fillDistricts(sel, val) {
    sel.innerHTML = districts.map(function (d) { return '<option value="' + d.id + '">' + esc(d.district) + "</option>"; }).join("");
    if (val) sel.value = val;
  }
  function fillDomains(sel) {
    sel.innerHTML = domains.map(function (d) { return '<option value="' + d + '">' + esc(DOM_LABEL[d]) + "</option>"; }).join("");
  }
  ["wDistrict", "dSeed", "aDistrict", "tDistrict", "oDistrict", "rDistrict", "pDistrict"].forEach(function (id) { if($(id)) fillDistricts($(id)); });
  ["wDomain", "sDomain", "dDomain", "aDomain", "tDomain", "oDomain"].forEach(function (id) { if($(id)) fillDomains($(id)); });
  $("dSeed").value = "TS24";        // Rangareddy
  $("aDistrict").value = "TS24";

  /* ============================================================
     STATE + OVERVIEW
     ============================================================ */
  function refreshState() {
    var o = WI.api("GET", "/overview");
    $("scModel").textContent = o.model_version;
    if ($("scData")) $("scData").textContent = WI.dataSource();
    $("scLrku").textContent = fmt(o.lrku_total);
    $("scCamp").textContent = fmt(o.campaigns);
    $("scBoost").textContent = "+" + o.model_boost;
    $("kLrku").textContent = fmt(o.lrku_total);
    $("kDist").textContent = fmt(o.districts);
    $("kCamp").textContent = fmt(o.campaigns);
    $("kBoost").textContent = "+" + o.model_boost;
    $("ovSignals").innerHTML = o.top_signals.map(function (r) {
      return "<tr><td>" + esc(r.district) + '</td><td class="n"><span class="score-pill"><i class="dotc" style="background:' +
        scoreColor(r.score) + '"></i>' + pct(r.score) + '</span></td><td class="n">' + fmt(r.lrku) + "</td></tr>";
    }).join("");
    renderEvents();
    if ($("todayList")) renderWorklist();
  }
  function renderEvents() {
    var ev = WI.api("GET", "/events");
    if (!ev.length) { $("ovEvents").innerHTML = '<tr><td colspan="3" style="color:var(--faint)">No activity yet — run the cycle or add a report.</td></tr>'; return; }
    $("ovEvents").innerHTML = ev.slice(0, 18).map(function (e) {
      var t = new Date(e.t).toLocaleTimeString("en-IN", { hour12: false });
      return "<tr><td style='color:var(--faint)'>" + t + '</td><td><span class="dom">' + esc(e.type) + "</span></td><td>" + esc(e.detail) + "</td></tr>";
    }).join("");
  }

  /* ============================================================
     01 — WORLD INTELLIGENCE (LRKU intake + bank)
     ============================================================ */
  function renderBank() {
    var rows = WI.api("GET", "/lrkus");
    $("wCount").textContent = rows.length + " units";
    $("wTable").innerHTML = rows.slice().reverse().map(function (l) {
      return "<tr><td style='color:var(--faint);white-space:nowrap'>" + esc(l.id) + "</td><td>" + esc(l.district) +
        '</td><td><span class="dom">' + esc(l.domain) + "</span></td><td>" + esc(l.belief || "—") + "</td></tr>";
    }).join("");
  }
  $("wAdd").addEventListener("click", function () {
    var belief = $("wBelief").value.trim();
    if (!belief) { $("wMsg").textContent = "Add what they believed."; $("wMsg").style.color = "var(--warn)"; return; }
    WI.api("POST", "/lrkus", {
      district: districts.find(function (d) { return d.id === $("wDistrict").value; }).district,
      domain: $("wDomain").value, contributor: $("wContrib").value,
      belief: belief, situation: $("wSituation").value.trim(), verification: "pending", consent: "consented"
    });
    $("wBelief").value = ""; $("wSituation").value = "";
    $("wMsg").style.color = "var(--live)"; $("wMsg").textContent = "Captured — signals updated.";
    setTimeout(function () { $("wMsg").textContent = ""; }, 2600);
    renderBank(); refreshState(); renderSignals(); updateMap($("sDomain").value);
  });

  /* ============================================================
     02 — PRAJA INTELLIGENCE (signals + map)
     ============================================================ */
  function renderSignals() {
    var dom = $("sDomain").value;
    var rows = WI.api("GET", "/signals", { domain: dom });
    $("sTable").innerHTML = rows.map(function (r) {
      return "<tr><td>" + esc(r.district) + '</td><td class="n"><span class="score-pill"><i class="dotc" style="background:' +
        scoreColor(r.score) + '"></i>' + pct(r.score) + '</span></td><td class="n">' + fmt(r.lrku) +
        '</td><td class="n">' + fmt(r.households) + "</td></tr>";
    }).join("");
  }
  var map, markers, tilesOk = false;
  function initMap() {
    if (typeof L === "undefined") { $("mapNote").textContent = "map library unavailable"; return; }
    map = L.map("map", { scrollWheelZoom: false, attributionControl: false }).setView([17.9, 79.2], 7);
    var tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 12, opacity: 0.55 });
    tiles.on("tileload", function () { if (!tilesOk) { tilesOk = true; $("mapNote").textContent = ""; } });
    tiles.on("tileerror", function () { if (!tilesOk) $("mapNote").textContent = "offline — basemap hidden, signals still live"; });
    tiles.addTo(map);
    markers = L.layerGroup().addTo(map);
    updateMap($("sDomain").value);
  }
  function updateMap(domain) {
    if (!map) return;
    markers.clearLayers();
    var rows = WI.api("GET", "/signals", { domain: domain });
    rows.forEach(function (r) {
      var radius = 7 + Math.sqrt(r.households) / 95;
      var c = L.circleMarker([r.lat, r.lon], {
        radius: radius, color: scoreColor(r.score), weight: 1.5,
        fillColor: scoreColor(r.score), fillOpacity: 0.45
      });
      c.bindTooltip("<b>" + esc(r.district) + "</b><br>signal " + pct(r.score) + " · " + fmt(r.lrku) + " units",
        { direction: "top", offset: [0, -4] });
      markers.addLayer(c);
    });
  }
  $("sDomain").addEventListener("change", function () { renderSignals(); updateMap(this.value); });

  /* ============================================================
     03 — PRAJA DARPAN (forecast + ROI decision panel)
     ============================================================ */
  var curIv = "none";
  $("dSeg").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    curIv = b.getAttribute("data-iv");
    [].forEach.call(this.querySelectorAll("button"), function (x) { x.classList.toggle("on", x === b); });
    runForecast();
  });
  $("dDomain").addEventListener("change", runForecast);
  $("dSeed").addEventListener("change", runForecast);

  var IV_NAME = { none: "No action", asha: "ASHA audio", doctor: "Doctor video", shg: "SHG meeting", combined: "Combined" };

  function runForecast() {
    var domain = $("dDomain").value, seed = $("dSeed").value;
    var trans = $("dTrans") ? +$("dTrans").value : 1;
    if ($("dTransV")) $("dTransV").textContent = trans.toFixed(2) + "×";
    var f = WI.api("POST", "/forecast", { domain: domain, seedDistrict: seed, intervention: curIv, days: 30, params: { trans: trans } });
    $("dKeySel").textContent = IV_NAME[curIv];
    drawChart(f.baseline, f.selected);
    drawRoi(f);
    if ($("dProv")) {
      var cf = trans >= 1.4 ? "lower" : (trans <= 0.7 ? "higher" : "moderate");
      $("dProv").innerHTML = '<b style="color:var(--gold)">Prediction · confidence: ' + cf + '</b> — illustrative model. Based on: seed-district population, recent field signals, spread to 8 neighbours, seasonality, transmission ×' + trans.toFixed(2) + '. Not a validated forecast.';
    }
  }

  function drawChart(base, sel) {
    var W = 560, H = 230, pl = 34, pr = 10, pt = 12, pb = 24, n = base.length;
    var x = function (i) { return pl + i / (n - 1) * (W - pl - pr); };
    var y = function (v) { return pt + (1 - v / 100) * (H - pt - pb); };
    var s = "";
    [0, 25, 50, 75, 100].forEach(function (g) {
      s += '<line class="grid-l" x1="' + pl + '" y1="' + y(g) + '" x2="' + (W - pr) + '" y2="' + y(g) + '"></line>';
      if (g % 50 === 0) s += '<text x="' + (pl - 6) + '" y="' + (y(g) + 3) + '" text-anchor="end" font-size="9" fill="#5C757D">' + g + "</text>";
    });
    function path(arr) { return arr.map(function (v, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); }).join(" "); }
    var area = "M" + x(0) + " " + y(sel[0]) + sel.map(function (v, i) { return "L" + x(i).toFixed(1) + " " + y(v).toFixed(1); }).join(" ") +
      "L" + x(n - 1) + " " + y(0) + "L" + x(0) + " " + y(0) + "Z";
    s += '<path class="area" d="' + area + '"></path>';
    s += '<path class="base" d="' + path(base) + '"></path>';
    s += '<path class="sel" d="' + path(sel) + '"></path>';
    s += '<line class="axis" x1="' + pl + '" y1="' + y(0) + '" x2="' + (W - pr) + '" y2="' + y(0) + '"></line>';
    s += '<text x="' + pl + '" y="' + (H - 6) + '" font-size="9" fill="#5C757D">day 0</text>';
    s += '<text x="' + (W - pr) + '" y="' + (H - 6) + '" text-anchor="end" font-size="9" fill="#5C757D">day 30</text>';
    $("dChart").innerHTML = s;
  }

  function drawRoi(f) {
    var r = f.roi;
    var cells = [
      ["households protected", fmt(r.households_protected), "var(--live)"],
      ["care delays averted", fmt(r.care_delays_averted), "var(--text)"],
      ["programme cost", curIv === "none" ? "—" : rupee(r.cost), "var(--text)"],
      ["cost / 1,000 protected", r.households_protected > 0 ? "₹" + (r.cost / r.households_protected * 1000).toFixed(1) : "—", "var(--gold)"]
    ];
    $("dRoi").innerHTML = cells.map(function (c) {
      return '<div class="roi-cell"><div class="roi-v" style="color:' + c[2] + '">' + c[1] + '</div><div class="roi-l">' + c[0] + "</div></div>";
    }).join("");

    var v = $("dVerdict");
    if (curIv === "none") {
      v.style.display = "block"; v.className = "verdict warn";
      v.innerHTML = "Left unchecked, this belief reaches roughly <b>" + fmt(r.reach_no_action) +
        " households</b> across the seed district and its eight neighbours. Pick a response to see what changes.";
      return;
    }
    /* ground the recommendation by comparing the real options */
    var domain = $("dDomain").value, seed = $("dSeed").value, best = null, max = null;
    ["asha", "doctor", "shg", "combined"].forEach(function (iv) {
      var rr = WI.api("POST", "/forecast", { domain: domain, seedDistrict: seed, intervention: iv, days: 30 }).roi;
      var per = rr.households_protected > 0 ? rr.cost / rr.households_protected * 1000 : null;
      if (per != null && (best === null || per < best.per)) best = { iv: iv, per: per };
      if (max === null || rr.households_protected > max.prot) max = { iv: iv, prot: rr.households_protected };
    });
    var selPer = r.households_protected > 0 ? (r.cost / r.households_protected * 1000).toFixed(1) : null;
    v.style.display = "block"; v.className = "verdict go";
    v.innerHTML = "<b>" + IV_NAME[curIv] + "</b> protects ~<b>" + fmt(r.households_protected) + " households</b>" +
      (selPer != null ? " at <b>₹" + selPer + " per 1,000 protected</b>" : "") + ". " +
      "Cheapest unit of protection here is <b>" + IV_NAME[best.iv] + "</b> (₹" + best.per.toFixed(1) + "/1,000); widest reach is <b>" +
      IV_NAME[max.iv] + "</b> (~" + fmt(max.prot) + " households). Fund the cheapest broadcast first, escalate where the signal stays high.";
  }

  /* ============================================================
     04 — INFODEMIC SHIELD (classify + counter + dispatch)
     ============================================================ */
  var lastDomain = "dengue";
  function classify() {
    var text = $("cText").value.trim(); if (!text) return;
    var r = WI.api("POST", "/classify", { text: text });
    lastDomain = r.domain;
    $("cResult").classList.add("show");
    $("cRisk").textContent = r.risk_type;
    $("cDom").textContent = DOM_LABEL[r.domain];
    var conf = $("cConf"); conf.textContent = r.confidence + " confidence"; conf.className = "tg " + r.confidence;
    $("cTe").textContent = r.message ? r.message.telugu : "—";
    $("cEn").textContent = r.message ? r.message.english : "";
    $("cMsgr").textContent = (r.messenger || []).join(" · ");
    $("cDispMsg").textContent = "";
  }
  $("cBtn").addEventListener("click", classify);
  [].forEach.call(document.querySelectorAll("[data-ex]"), function (b) {
    b.addEventListener("click", function () { $("cText").value = this.getAttribute("data-ex"); classify(); });
  });
  $("cDispatch").addEventListener("click", function () {
    var c = WI.api("POST", "/campaign", { domain: lastDomain, districtId: "TS24" });
    $("cDispMsg").textContent = "Sent as " + c.id + " → " + c.district;
    refreshState(); renderCampaigns();
  });

  /* ============================================================
     05 — AAROGYAM 365 (calendar + dispatch + feedback loop)
     ============================================================ */
  function renderCalendar() {
    var acts = WI.actions();
    $("calGrid").innerHTML = acts.map(function (a) {
      return '<div class="mo"><div class="mn">' + esc(a.month) + '</div><div class="mt">' + esc(a.title) +
        '</div><div class="md"><span class="dom">' + esc(a.domain) + '</span></div><div class="te">' + esc(a.telugu) + "</div></div>";
    }).join("");
  }
  function renderCampaigns() {
    var c = WI.api("GET", "/campaigns");
    $("aCount").textContent = c.length + " sent";
    if (!c.length) { $("aTable").innerHTML = '<tr><td colspan="4" style="color:var(--faint)">None dispatched yet.</td></tr>'; return; }
    $("aTable").innerHTML = c.map(function (x) {
      return "<tr><td style='color:var(--faint);white-space:nowrap'>" + esc(x.id) + "</td><td>" + esc(x.district) +
        '</td><td><span class="dom">' + esc(x.domain) + '</span></td><td class="n">' + fmt(x.received) + "</td></tr>";
    }).join("");
  }
  $("aDispatch").addEventListener("click", function () {
    WI.api("POST", "/campaign", { domain: $("aDomain").value, districtId: $("aDistrict").value });
    refreshState(); renderCampaigns();
  });
  $("aFeedback").addEventListener("click", function () {
    var c = WI.api("GET", "/campaigns");
    if (!c.length) { WI.api("POST", "/campaign", { domain: $("aDomain").value, districtId: $("aDistrict").value }); c = WI.api("GET", "/campaigns"); }
    WI.api("POST", "/feedback", { campaignId: c[0].id, responses: 120, received: 96, believed: 18, delayed: 9 });
    refreshState(); renderCampaigns();
  });



  /* ============================================================
     06 — JEEVANA-1 TELUGU VOICE KIOSK
     ============================================================ */
  var lastVoiceAnswer = "";
  function speakTelugu(text) {
    if (!("speechSynthesis" in window)) { return; }
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text || lastVoiceAnswer || "");
    var voices = speechSynthesis.getVoices ? speechSynthesis.getVoices() : [];
    var v = voices.find(function (x) { return (x.lang || "").toLowerCase().indexOf("te") === 0; }) || voices.find(function (x) { return (x.lang || "").toLowerCase().indexOf("in") >= 0; }) || voices[0];
    if (v) u.voice = v;
    u.lang = "te-IN"; u.rate = 0.92; u.pitch = 1;
    speechSynthesis.speak(u);
  }
  function askVoice() {
    var q = $("vQuestion").value.trim();
    if (!q) { $("vStatus").textContent = "Type or speak a Telugu question first."; return; }
    var r = WI.api("POST", "/patient/answer", { text: q, mode: $("vMode").value });
    lastVoiceAnswer = r.answer_telugu;
    $("vAnswer").textContent = r.answer_telugu;
    $("vStatus").textContent = "Domain: " + r.domain + " · Safety: " + r.safety.level + " · Audit: " + r.safety.audit_id;
    renderSafetyAudit(); refreshState();
  }
  $("vAsk").addEventListener("click", askVoice);
  $("vSpeak").addEventListener("click", function () { speakTelugu(lastVoiceAnswer || $("vAnswer").textContent); });
  $("vSave").addEventListener("click", function () {
    var q = $("vQuestion").value.trim();
    if (!q) return;
    var cls = WI.api("POST", "/classify", { text: q });
    WI.api("POST", "/lrkus", { district: "Hyderabad", domain: cls.domain, contributor: "Jeevana-1 kiosk", belief: q, situation: "Patient question at PHC kiosk", action: "Safe Telugu answer given", outcome: lastVoiceAnswer, risk: cls.risk_type, verification: "needs review", consent: "no identifiers" });
    $("vStatus").textContent = "Saved as LRKU from kiosk interaction.";
    renderBank(); refreshState(); renderSignals(); updateMap($("sDomain").value);
  });
  $("vListen").addEventListener("click", function () {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { $("vStatus").textContent = "Speech recognition not supported in this browser. Type Telugu instead."; return; }
    var rec = new SR(); rec.lang = "te-IN"; rec.interimResults = false; rec.continuous = false;
    $("vStatus").textContent = "Listening in Telugu...";
    rec.onresult = function (e) { $("vQuestion").value = e.results[0][0].transcript; $("vStatus").textContent = "Voice captured. Click Answer safely."; };
    rec.onerror = function (e) { $("vStatus").textContent = "Mic error: " + e.error; };
    rec.onend = function () { if ($("vStatus").textContent === "Listening in Telugu...") $("vStatus").textContent = "Voice stopped."; };
    rec.start();
  });

  /* ============================================================
     07 — PRAJA SURAKSHA SAFETY GUARD
     ============================================================ */
  function renderSafetyAudit() {
    var rows = WI.api("GET", "/safety/audits");
    if (!rows.length) { $("gAudit").innerHTML = '<tr><td colspan="4" style="color:var(--faint)">No safety screens yet.</td></tr>'; return; }
    $("gAudit").innerHTML = rows.slice(0, 20).map(function (a) {
      return "<tr><td style='color:var(--faint);white-space:nowrap'>" + esc(a.id) + "</td><td><span class='tg " + (a.level === "RED" ? "high" : a.level === "AMBER" ? "medium" : "low") + "'>" + esc(a.level) + "</span></td><td>" + esc(a.domain) + "</td><td>" + esc(a.route) + "</td></tr>";
    }).join("");
  }
  $("gBtn").addEventListener("click", function () {
    var r = WI.api("POST", "/safety/triage", { text: $("gText").value });
    $("gOut").className = "safe-card " + (r.level === "RED" ? "danger" : r.level === "AMBER" ? "caution" : "good");
    $("gOut").innerHTML = "<b>Safety level: " + esc(r.level) + "</b><br>Domain: " + esc(r.domain) + "<br>Route: " + esc(r.route) + "<br>Red flags: " + esc((r.red_flags || []).join(", ") || "none") + "<br><br><span>" + esc(r.advice_telugu) + "</span>";
    renderSafetyAudit(); refreshState();
  });

  /* ============================================================
     08 — TRUST NETWORK PLANNER
     ============================================================ */
  function renderTrust() {
    var r = WI.api("POST", "/trust/plan", { domain: $("tDomain").value, districtId: $("tDistrict").value });
    $("tVerdict").style.display = "block";
    $("tVerdict").innerHTML = "Use <b>" + esc(r.recommended.key) + "</b> first in <b>" + esc(r.district) + "</b>. Trust-weighted reach: <b>" + Math.round(r.recommended.score * 100) + "%</b>.";
    $("tBars").innerHTML = r.options.map(function (o) {
      return '<div class="rank"><div class="rank-head"><b>' + esc(o.key) + '</b><span>' + Math.round(o.score * 100) + '% trust · ₹' + fmt(o.cost_per_reached) + '/reached</span></div><div class="bar"><i style="width:' + Math.round(o.score * 100) + '%"></i></div><small>' + esc(o.reason) + '</small></div>';
    }).join("");
  }
  $("tBtn").addEventListener("click", renderTrust);

  /* ============================================================
     09 — PHC OPS QUEUE
     ============================================================ */
  function renderOps() {
    var rows = WI.api("GET", "/ops");
    if (!rows.length) { $("oTable").innerHTML = '<tr><td colspan="4" style="color:var(--faint)">No PHC tasks yet.</td></tr>'; return; }
    $("oTable").innerHTML = rows.slice(0, 35).map(function (o) {
      return "<tr><td>" + esc(o.task) + "<br><small style='color:var(--faint)'>" + esc(o.district) + " · " + esc(o.domain) + "</small></td><td>" + esc(o.assigned_to) + "</td><td>" + esc(o.urgency) + "</td><td>" + (o.status === "done" ? "done" : "<button class='btn sm done-op' data-id='" + esc(o.id) + "'>Mark done</button>") + "</td></tr>";
    }).join("");
    [].forEach.call(document.querySelectorAll(".done-op"), function (b) { b.addEventListener("click", function () { WI.api("POST", "/ops/complete", { id: this.getAttribute("data-id") }); renderOps(); refreshState(); }); });
  }
  $("oMake").addEventListener("click", function () {
    var r = WI.api("POST", "/ops/create", { domain: $("oDomain").value, districtId: $("oDistrict").value, urgency: $("oUrgency").value });
    $("oOut").innerHTML = "Created " + r.tasks.length + " tasks. Lead messenger: <b>" + esc(r.plan.recommended.key) + "</b>.";
    renderOps(); refreshState();
  });

  /* ============================================================
     10 — MINISTER BRIEF
     ============================================================ */
  var lastBriefText = "";
  function briefToText(b) {
    return b.title + "\nGenerated: " + new Date(b.generated_at).toLocaleString("en-IN") + "\n\n" +
      "Executive line: " + b.executive_line + "\n\n" +
      "Highest signal district: " + b.highest_signal_district + "\n" +
      "Highest risk domain: " + b.highest_risk_domain + "\n" +
      "LRKUs: " + b.lrkus + " | Campaigns: " + b.campaigns + " | Open PHC tasks: " + b.open_ops + "\n\n" +
      "30-day rehearsal: no action " + b.forecast.no_action_pct + "% vs combined response " + b.forecast.combined_pct + "%\n" +
      "Households protected: " + fmt(b.forecast.households_protected) + " | Cost/household: ₹" + fmt(b.forecast.cost_per_household || 0) + "\n\n" +
      "Recommended messengers: " + b.recommended_messengers.join("; ") + "\n\n" +
      "Next 72 hours:\n- " + b.next_72_hours.join("\n- ") + "\n\n" +
      "Safety position: " + b.safety_position;
  }
  $("bMake").addEventListener("click", function () { var b = WI.api("GET", "/minister/brief"); lastBriefText = briefToText(b); $("bOut").textContent = lastBriefText; });
  $("bCopy").addEventListener("click", function () { if (navigator.clipboard && lastBriefText) navigator.clipboard.writeText(lastBriefText); });
  $("bPrint").addEventListener("click", function () { if (!lastBriefText) { var b = WI.api("GET", "/minister/brief"); lastBriefText = briefToText(b); $("bOut").textContent = lastBriefText; } window.print(); });

  /* ============================================================
     PIPELINE — run the full loop with animation
     ============================================================ */
  var nodes = [].slice.call(document.querySelectorAll(".node"));
  function setStage(i) { nodes.forEach(function (n, k) { n.classList.toggle("on", k <= i); }); }
  $("runLoop").addEventListener("click", function () {
    var btn = this; btn.disabled = true;
    var pipe = $("pipe"); pipe.classList.add("run");
    nodes.forEach(function (n) { n.classList.remove("on"); });
    $("pipeOut").innerHTML = "Listening…";
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var step = reduce ? 1 : 460;
    var labels = ["Listening to a field signal…", "Structuring: classifying domain &amp; risk…", "Forecasting spread across the catchment…", "Choosing the response…", "Delivering Telugu through the trusted voice…"];
    var i = 0;
    var timer = setInterval(function () {
      setStage(i); $("pipeOut").innerHTML = labels[i];
      if (i === 4) {
        clearInterval(timer);
        var run = WI.api("POST", "/loop/run", {});
        $("pipeOut").innerHTML = "<b>Cycle complete.</b> Signal in <b>" + esc(run.seed) + "</b> classified as <span class='tag'>" +
          esc(run.domain) + "</span> → no-action forecast <b>" + run.forecast.no_action_pct + "%</b> vs combined <b>" +
          run.forecast.combined_pct + "%</b>, protecting ~<b>" + fmt(run.forecast.households_protected) +
          " households</b> → dispatched via <b>" + esc(run.act.messenger) + "</b>, reached <b>" + fmt(run.deliver.reached) +
          "</b>, model boost <span class='tag'>+" + run.deliver.model_boost + "</span>.";
        refreshState(); renderBank(); renderSignals(); updateMap($("sDomain").value); renderCampaigns();
        setTimeout(function () { pipe.classList.remove("run"); btn.disabled = false; }, 900);
      }
      i++;
    }, step);
  });

  /* ============================================================
     TABS
     ============================================================ */
  var tabBtns = [].slice.call(document.querySelectorAll(".tab"));
  tabBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      tabBtns.forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      [].forEach.call(document.querySelectorAll(".panel"), function (p) { p.classList.remove("show"); });
      $("p-" + b.getAttribute("data-tab")).classList.add("show");
      if (b.getAttribute("data-tab") === "praja" && map) setTimeout(function () { map.invalidateSize(); updateMap($("sDomain").value); }, 60);
      if (b.getAttribute("data-tab") === "doctors" && doctorMap) setTimeout(function () { doctorMap.invalidateSize(); updateDoctorMap(currentDoctorRows); }, 80);
    });
  });

  /* ============================================================
     API CONSOLE
     ============================================================ */
  $("apiSend").addEventListener("click", function () {
    var m = $("apiMethod").value, route = $("apiRoute").value.trim();
    var body = {};
    if (route.indexOf("/forecast") === 0) body = { domain: $("dDomain").value, seedDistrict: $("dSeed").value, intervention: curIv, days: 30 };
    if (route.indexOf("/classify") === 0) body = { text: $("cText").value };
    if (route.indexOf("/signals") === 0) body = { domain: $("sDomain").value };
    var out;
    try { out = WI.api(m, route, body); } catch (e) { out = { error: e.message }; }
    $("apiOut").textContent = m + " " + route + "\n\n" + JSON.stringify(out, null, 2);
  });
  $("apiReset").addEventListener("click", function () {
    WI.reset();
    refreshState(); renderBank(); renderSignals(); updateMap($("sDomain").value); renderCampaigns(); runForecast();
    if ($("csvReset")) $("csvReset").style.display = "none";
    if ($("csvMsg")) $("csvMsg").textContent = "";
    $("apiOut").textContent = "// session data cleared — seed data restored";
    nodes.forEach(function (n) { n.classList.remove("on"); });
    $("pipeOut").innerHTML = "Press <b>Run the full cycle</b> to send one real field signal through all five stages.";
  });
  $("apiExport").addEventListener("click", function () { WI.export(); });

  /* ============================================================
     REAL DISPATCH — WhatsApp / copy (no backend, works on a phone)
     ============================================================ */
  var TAGLINE = "\n\n— Public health awareness (Telangana). Confirm with PHC staff.";
  function waLink(text) { return "https://wa.me/?text=" + encodeURIComponent(text + TAGLINE); }
  function openWA(text) { if (text) window.open(waLink(text), "_blank"); }
  function copyText(text, statusEl) {
    if (!text) return;
    var done = function () { if (statusEl) { var old = statusEl.textContent; statusEl.textContent = "Copied."; setTimeout(function () { statusEl.textContent = old === "Copied." ? "" : ""; }, 1600); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
    else { try { var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); done(); } catch (e) {} }
  }
  function shieldText() { var t = $("cTe") ? $("cTe").textContent : ""; return (t && t !== "—") ? t : ""; }
  function aarogyamText() { var m = WI.messages()[$("aDomain").value]; return m ? m.telugu : ""; }
  function voiceText() { var t = $("vAnswer") ? $("vAnswer").textContent : ""; return (t && t.indexOf("appear here") < 0) ? t : ""; }
  if ($("cWhats")) $("cWhats").addEventListener("click", function () { var t = shieldText(); t ? openWA(t) : ($("cDispMsg").textContent = "Classify a claim first."); });
  if ($("cCopy")) $("cCopy").addEventListener("click", function () { copyText(shieldText(), $("cDispMsg")); });
  if ($("aWhats")) $("aWhats").addEventListener("click", function () { openWA(aarogyamText()); });
  if ($("vWhats")) $("vWhats").addEventListener("click", function () { openWA(voiceText()); });
  if ($("vCopy")) $("vCopy").addEventListener("click", function () { copyText(voiceText(), $("vStatus")); });

  /* ============================================================
     REAL DATA — CSV import / export (replaces synthetic risk)
     ============================================================ */
  function parseCSV(text) {
    var lines = text.replace(/\r/g, "").split("\n").filter(function (l) { return l.trim().length; });
    if (!lines.length) return { header: [], rows: [] };
    var header = lines[0].split(",").map(function (s) { return s.trim().toLowerCase(); });
    var rows = lines.slice(1).map(function (l) {
      var cells = l.split(","), o = {};
      header.forEach(function (h, i) { o[h] = (cells[i] || "").trim(); });
      return o;
    });
    return { header: header, rows: rows };
  }
  function nameToId(name) {
    name = (name || "").trim().toLowerCase();
    var list = WI.districts();
    for (var i = 0; i < list.length; i++) if (list[i].district.toLowerCase() === name || list[i].id.toLowerCase() === name) return list[i].id;
    return null;
  }
  function importCSV(text) {
    var parsed = parseCSV(text), overrides = {}, matched = 0, fields = 0;
    parsed.rows.forEach(function (r) {
      var id = nameToId(r.district || r.id || r.name); if (!id) return;
      var o = {};
      domains.forEach(function (dom) {
        if (r[dom] !== undefined && r[dom] !== "") { var v = parseFloat(r[dom]); if (!isNaN(v)) { o[dom] = v > 1 ? Math.min(1, v / 100) : v; fields++; } }
      });
      if (Object.keys(o).length) { overrides[id] = o; matched++; }
    });
    if (!matched) { $("csvMsg").style.color = "var(--warn)"; $("csvMsg").textContent = "No districts matched — check the district column spelling."; return; }
    WI.importData(overrides);
    $("csvMsg").style.color = "var(--live)"; $("csvMsg").textContent = matched + " districts, " + fields + " real values imported — map & forecast updated.";
    if ($("csvReset")) $("csvReset").style.display = "inline-block";
    refreshState(); renderSignals(); updateMap($("sDomain").value); runForecast();
  }
  function download(name, text) {
    var blob = new Blob([text], { type: "text/csv" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }
  if ($("csvImport")) $("csvImport").addEventListener("click", function () {
    var f = $("csvFile").files[0];
    if (!f) { $("csvMsg").style.color = "var(--warn)"; $("csvMsg").textContent = "Choose a CSV file first."; return; }
    var rd = new FileReader(); rd.onload = function () { importCSV(String(rd.result)); }; rd.readAsText(f);
  });
  if ($("csvTemplate")) $("csvTemplate").addEventListener("click", function () {
    var head = "district," + domains.join(",");
    var rows = WI.districts().map(function (d) { return d.district + "," + domains.map(function (k) { return d.base_risks[k] != null ? d.base_risks[k] : ""; }).join(","); });
    download("wi_district_data_template.csv", head + "\n" + rows.join("\n"));
  });
  if ($("csvExport")) $("csvExport").addEventListener("click", function () {
    var rows = WI.api("GET", "/signals", { domain: $("sDomain").value });
    var head = "district,signal_score,field_units,base_risk,households,population";
    var body = rows.map(function (r) { return [r.district, r.score.toFixed(3), r.lrku, (r.base != null ? r.base.toFixed(3) : ""), r.households, r.population].join(","); });
    download("wi_signals_" + $("sDomain").value + ".csv", head + "\n" + body.join("\n"));
  });
  if ($("csvReset")) $("csvReset").addEventListener("click", function () {
    WI.importData({});
    $("csvReset").style.display = "none"; $("csvMsg").style.color = "var(--muted)"; $("csvMsg").textContent = "Reverted to synthetic baseline.";
    refreshState(); renderSignals(); updateMap($("sDomain").value); runForecast();
  });

  /* ============================================================
     11 NCD RECALL · 12 PATIENT QUEUE · Today worklist
     ============================================================ */
  function levelClass(l) { return l === "RED" ? "high" : l === "AMBER" ? "medium" : "low"; }

  function renderRecalls() {
    if (!$("rTable")) return;
    var rows = WI.api("GET", "/recalls");
    $("rCount2").textContent = rows.length + " active";
    if (!rows.length) { $("rTable").innerHTML = '<tr><td colspan="4" style="color:var(--faint)">No recalls yet.</td></tr>'; return; }
    $("rTable").innerHTML = rows.map(function (r) {
      return "<tr><td style='color:var(--faint);white-space:nowrap'>" + esc(r.id) + "</td><td>" + esc(r.district) +
        "</td><td class='n'>" + fmt(r.count) + " <small style='color:var(--faint)'>&gt;" + r.missed_days + "d</small></td>" +
        "<td><button class='btn sm wa-recall' data-id='" + esc(r.id) + "'>WhatsApp</button></td></tr>";
    }).join("");
    [].forEach.call(document.querySelectorAll(".wa-recall"), function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-id");
        var rec = WI.api("GET", "/recalls").filter(function (x) { return x.id === id; })[0];
        if (rec) openWA(rec.telugu);
      });
    });
  }

  function renderPatients() {
    if (!$("pTable")) return;
    var rows = WI.api("GET", "/patients");
    var waiting = rows.filter(function (p) { return p.status === "waiting"; }).length;
    $("pCount").textContent = waiting + " waiting · " + rows.length + " total";
    if (!rows.length) { $("pTable").innerHTML = '<tr><td colspan="4" style="color:var(--faint)">No patients registered.</td></tr>'; return; }
    $("pTable").innerHTML = rows.slice(0, 60).map(function (p) {
      return "<tr><td style='white-space:nowrap'>" + esc(p.token) + "</td><td><span class='tg " + levelClass(p.level) + "'>" + p.level + "</span></td><td>" + esc(p.complaint || "—") +
        "<br><small style='color:var(--faint)'>" + esc(p.district) + " · " + esc(p.domain) + "</small></td>" +
        "<td>" + (p.status === "closed" ? "<small style='color:var(--faint)'>closed</small>" : "<button class='btn sm close-pt' data-id='" + esc(p.id) + "'>Close</button>") + "</td></tr>";
    }).join("");
    [].forEach.call(document.querySelectorAll(".close-pt"), function (b) {
      b.addEventListener("click", function () { WI.api("POST", "/patients/close", { id: this.getAttribute("data-id") }); renderPatients(); refreshState(); });
    });
  }

  function renderWorklist() {
    if (!$("todayList")) return;
    var ops = WI.api("GET", "/ops").filter(function (o) { return o.status !== "done"; });
    var pts = WI.api("GET", "/patients").filter(function (p) { return p.status === "waiting"; });
    var recalls = WI.api("GET", "/recalls");
    var sig = WI.api("GET", "/signals", { domain: $("sDomain") ? $("sDomain").value : "dengue" }).slice(0, 3);
    var items = [];
    pts.forEach(function (p) { if (p.level === "RED" || p.level === "AMBER") items.push({ pri: p.level === "RED" ? 0 : 1, tag: p.level, color: p.level === "RED" ? "var(--risk)" : "var(--warn)", text: "Patient " + p.token + " (" + p.domain + ") — " + p.route, where: p.district }); });
    ops.slice(0, 6).forEach(function (o) { items.push({ pri: o.urgency === "now" ? 0 : 2, tag: "task", color: "var(--live)", text: o.task, where: o.district + " · " + o.assigned_to }); });
    recalls.slice(0, 3).forEach(function (r) { items.push({ pri: 3, tag: "recall", color: "var(--gold)", text: fmt(r.count) + " NCD patients to recall", where: r.district }); });
    sig.forEach(function (s) { if (s.score >= 0.66) items.push({ pri: 4, tag: "signal", color: "var(--risk)", text: "High signal — direct attention", where: s.district + " · " + pct(s.score) }); });
    items.sort(function (a, b) { return a.pri - b.pri; });
    if (!items.length) { $("todayList").innerHTML = "<div style='color:var(--faint);font-size:13px'>Nothing outstanding right now. Register a patient, run the cycle, or generate a recall to populate the worklist.</div>"; return; }
    $("todayList").innerHTML = items.slice(0, 10).map(function (it) {
      return "<div class='wl-row'><span class='wl-tag' style='color:" + it.color + ";border-color:" + it.color + "'>" + esc(it.tag) + "</span><span class='wl-text'>" + esc(it.text) + "</span><span class='wl-where'>" + esc(it.where) + "</span></div>";
    }).join("");
  }

  if ($("rMake")) $("rMake").addEventListener("click", function () {
    WI.api("POST", "/recall/ncd", { districtId: $("rDistrict").value, count: $("rCount").value, missedDays: $("rDays").value });
    renderRecalls(); if (typeof renderOps === "function") renderOps(); refreshState();
  });

  var lastPt = null;
  if ($("pMake")) $("pMake").addEventListener("click", function () {
    var complaint = $("pComplaint").value.trim();
    if (!complaint) { return; }
    var t = WI.api("POST", "/patient/create", { complaint: complaint, districtId: $("pDistrict").value, duration_days: $("pDuration").value, age_group: $("pAge").value, gender: $("pGender").value });
    lastPt = t;
    $("pResult").style.display = "block"; $("pResult").classList.add("show");
    $("pToken").textContent = t.token;
    $("pLevel").textContent = t.level; $("pLevel").className = "tg " + levelClass(t.level);
    $("pDom").textContent = DOM_LABEL[t.domain] || t.domain;
    $("pAdvice").textContent = t.advice_telugu;
    $("pRoute").textContent = t.route;
    $("pComplaint").value = "";
    renderPatients(); if (typeof renderOps === "function") renderOps(); refreshState();
  });
  if ($("pWhats")) $("pWhats").addEventListener("click", function () { if (lastPt) openWA((lastPt.advice_telugu || "") + "\n\n" + (lastPt.message_telugu || "")); });

  /* ============================================================
     DEPTH — rumour library · referral guide · bank tools · calendar
     ============================================================ */
  function cpText(t, btn) { try { navigator.clipboard.writeText(t); } catch (e) {} if (btn) { var o = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = o; }, 1100); } }
  function splitCsv(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) { var ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else { if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; } }
    out.push(cur); return out;
  }

  function renderRumours() {
    if (!$("cRumList")) return;
    var rows = WI.api("GET", "/rumours", { q: $("cRumQ") ? $("cRumQ").value : "" });
    if (!rows.length) { $("cRumList").innerHTML = "<div style='color:var(--faint);font-size:13px'>No myths match that search.</div>"; return; }
    $("cRumList").innerHTML = rows.map(function (r, i) {
      return "<div class='rum'><div class='rum-h'><span class='dom'>" + esc(DOM_LABEL[r.domain] || r.domain) + "</span><span class='rum-m'>\u201C" + esc(r.myth) + "\u201D</span></div>" +
        "<div class='rum-t'><b>Reality:</b> " + esc(r.truth) + "</div><div class='te'>" + esc(r.te) + "</div>" +
        "<div class='rum-b'><button class='btn sm wa-rum' data-i='" + i + "'>WhatsApp</button><button class='btn sm cp-rum' data-i='" + i + "'>Copy reply</button></div></div>";
    }).join("");
    function txt(i) { var r = rows[i]; return r.te + "\n\n(" + r.truth + ")"; }
    [].forEach.call(document.querySelectorAll(".wa-rum"), function (b) { b.addEventListener("click", function () { openWA(txt(+this.getAttribute("data-i"))); }); });
    [].forEach.call(document.querySelectorAll(".cp-rum"), function (b) { b.addEventListener("click", function () { cpText(txt(+this.getAttribute("data-i")), this); }); });
  }

  function renderReferral() {
    if (!$("gRefList")) return;
    var rows = WI.api("GET", "/referral", { q: $("gRefQ") ? $("gRefQ").value : "" });
    if (!rows.length) { $("gRefList").innerHTML = "<div style='color:var(--faint);font-size:13px'>No guide matches that search.</div>"; return; }
    $("gRefList").innerHTML = rows.map(function (g, i) {
      return "<div class='ref'><div class='ref-h'><span class='dom'>" + esc(DOM_LABEL[g.domain] || g.domain) + "</span><b>" + esc(g.title) + "</b></div>" +
        "<ul class='ref-l'>" + g.signs.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ul><div class='te'>" + esc(g.te) + "</div>" +
        "<div class='ref-b'><button class='btn sm wa-ref' data-i='" + i + "'>Send Telugu</button></div></div>";
    }).join("");
    [].forEach.call(document.querySelectorAll(".wa-ref"), function (b) { b.addEventListener("click", function () { openWA(rows[+this.getAttribute("data-i")].te); }); });
  }
  if ($("cRumQ")) $("cRumQ").addEventListener("input", renderRumours);
  if ($("gRefQ")) $("gRefQ").addEventListener("input", renderReferral);

  if ($("wSearch")) $("wSearch").addEventListener("input", function () {
    var q = this.value.toLowerCase();
    [].forEach.call($("wTable").querySelectorAll("tr"), function (tr) { tr.style.display = tr.textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none"; });
  });
  if ($("wExport")) $("wExport").addEventListener("click", function () {
    var rows = WI.api("GET", "/lrkus");
    var csv = "district,domain,contributor,belief,situation,risk\n" + rows.map(function (l) {
      return [l.district, l.domain, l.contributor, l.belief, l.situation, l.risk].map(function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\n");
    download("world_intelligence_field_reports.csv", csv);
  });
  if ($("wImportBtn")) $("wImportBtn").addEventListener("click", function () {
    var fi = $("wImport"); if (!fi.files || !fi.files[0]) { $("wImpMsg").textContent = "Choose a CSV file first."; return; }
    var rd = new FileReader();
    rd.onload = function () {
      var lines = String(rd.result).split(/\r?\n/).filter(function (x) { return x.trim(); });
      if (lines.length < 2) { $("wImpMsg").textContent = "CSV looks empty."; return; }
      var head = splitCsv(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
      var rows = lines.slice(1).map(function (ln) { var c = splitCsv(ln), o = {}; head.forEach(function (h, i) { o[h] = (c[i] || "").trim(); }); return o; });
      var n = WI.api("POST", "/lrkus/import", { rows: rows });
      $("wImpMsg").textContent = n + " field reports imported.";
      renderBank(); refreshState();
    };
    rd.readAsText(fi.files[0]);
  });

  if ($("aIcs")) $("aIcs").addEventListener("click", function () {
    var acts = WI.actions();
    var mIx = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
    var yr = new Date().getFullYear(), ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Telangana Nethra//Aarogyam365//EN", "CALSCALE:GREGORIAN"];
    acts.forEach(function (a, i) {
      var m = mIx[a.month] || (i + 1), mm = (m < 10 ? "0" + m : "" + m);
      ics.push("BEGIN:VEVENT", "UID:aarogyam-" + yr + mm + "@worldintelligence", "DTSTART;VALUE=DATE:" + yr + mm + "01",
        "RRULE:FREQ=YEARLY", "SUMMARY:Aarogyam 365 — " + String(a.title).replace(/[\n,;]/g, " "),
        "DESCRIPTION:" + String(a.telugu || "").replace(/[\n,;]/g, " "), "END:VEVENT");
    });
    ics.push("END:VCALENDAR");
    var blob = new Blob([ics.join("\r\n")], { type: "text/calendar" }), el = document.createElement("a");
    el.href = URL.createObjectURL(blob); el.download = "aarogyam_365_calendar.ics"; el.click(); URL.revokeObjectURL(el.href);
  });

  if ($("dTrans")) $("dTrans").addEventListener("input", runForecast);

  /* ============================================================
     13 — AAROGYA DARPAN TELANGANA (verified doctor access network)
     ============================================================ */
  var doctorMap, doctorMarkers, currentDoctorRows = [];
  function gradeClass(g) { return g === 'A+' || g === 'A' ? 'good' : g === 'B' || g === 'C' ? 'caution' : 'danger'; }
  function doctorColor(d) { return !d.verified ? '#F0654A' : d.accessScore100 >= 80 ? '#36D6C2' : '#F2B23C'; }
  function fillDoctorDistrictFilter() {
    if (!$('docDistrict')) return;
    $('docDistrict').innerHTML = '<option value="">All Telangana</option>' + districts.map(function(d){ return '<option value="'+d.id+'">'+esc(d.district)+'</option>'; }).join('');
  }
  function fillDoctorSelect() {
    if (!$('docFeedbackDoctor')) return;
    var rows = WI.api('GET','/doctors');
    $('docFeedbackDoctor').innerHTML = rows.map(function(d){ return '<option value="'+esc(d.id)+'">'+esc(d.name)+' · '+esc(d.district)+' · '+esc(d.accessGrade)+'</option>'; }).join('');
  }
  function renderDoctorProfiles() {
    if (!$('docList')) return;
    var rows = WI.api('POST','/doctors/search',{ term: $('docSearch') ? $('docSearch').value : '', districtId: $('docDistrict') ? $('docDistrict').value : '' });
    currentDoctorRows = rows;
    $('docCount').textContent = rows.length + ' profiles';
    if (!rows.length) { $('docList').innerHTML = '<div style="color:var(--faint);font-size:13px">No doctor profiles match this search.</div>'; return; }
    $('docList').innerHTML = rows.map(function(d){
      var badges = (d.badges || []).slice(0,4).map(function(b){ return '<span class="badge">'+esc(b)+'</span>'; }).join('');
      return '<div class="doc-card" data-id="'+esc(d.id)+'"><div class="doc-top"><div><b>'+esc(d.name)+'</b><span>'+esc(d.speciality)+' · '+esc(d.district)+'</span></div><div class="grade '+gradeClass(d.accessGrade)+'">'+esc(d.accessGrade)+'</div></div>'+
        '<div class="doc-meta"><span>Reg: '+esc(d.registrationNo)+'</span><span>'+esc(d.verified ? 'Verified demo layer' : 'Unable to verify')+'</span><span>Google signal: '+esc(d.googleRating || '—')+' / '+esc(d.googleReviews || 0)+' reviews</span></div>'+
        '<div class="doc-clinic">'+esc(d.clinic)+' · '+esc(d.timings)+' · '+esc(d.languages)+'</div><div class="badges">'+badges+'</div>'+
        '<div class="doc-foot"><span>Public Health Access Score: <b>'+esc(d.accessScore100)+'/100</b> — '+esc(d.gradeLabel)+'</span><button class="btn sm doc-card-btn" data-id="'+esc(d.id)+'">Trust card</button></div></div>';
    }).join('');
    [].forEach.call(document.querySelectorAll('.doc-card-btn'), function(b){ b.addEventListener('click', function(){ renderDoctorCard(this.getAttribute('data-id')); }); });
    fillDoctorSelect();
    updateDoctorMap(rows);
  }
  function initDoctorMap() {
    if (!$('doctorMap') || typeof L === 'undefined') return;
    doctorMap = L.map('doctorMap',{scrollWheelZoom:false, attributionControl:false}).setView([17.9,79.2],7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:12,opacity:.45}).addTo(doctorMap);
    doctorMarkers = L.layerGroup().addTo(doctorMap);
  }
  function updateDoctorMap(rows) {
    if (!doctorMap || !doctorMarkers) return;
    doctorMarkers.clearLayers();
    rows = rows || currentDoctorRows || WI.api('GET','/doctors');
    rows.forEach(function(d){
      var c = L.circleMarker([d.lat,d.lon], { radius: d.verified ? 8 : 7, color: doctorColor(d), fillColor: doctorColor(d), fillOpacity:.55, weight:1.5 });
      c.bindTooltip('<b>'+esc(d.name)+'</b><br>'+esc(d.speciality)+'<br>Grade '+esc(d.accessGrade)+' · '+esc(d.registrationNo), {direction:'top'});
      doctorMarkers.addLayer(c);
    });
  }
  function renderDoctorVerify() {
    var q = ($('docVerifyQuery') && $('docVerifyQuery').value || '').trim();
    if (!q) return;
    var r = WI.api('POST','/doctors/verify',{ query:q });
    var box = $('docVerifyOut');
    if (r.doctor) {
      var d = r.doctor;
      box.className = 'verify-card ' + (d.verified ? 'good' : 'danger');
      box.innerHTML = '<b>'+esc(r.status.replace(/_/g,' ')).toUpperCase()+'</b><br>'+esc(d.name)+'<br>Registration: <b>'+esc(d.registrationNo)+'</b><br>District: '+esc(d.district)+'<br>Public Health Access Grade: <b>'+esc(d.accessGrade)+'</b><br><small>'+esc(r.message)+'</small>';
    } else {
      box.className = 'verify-card danger';
      box.innerHTML = '<b>UNABLE TO VERIFY</b><br>'+esc(r.message)+'<br><small>Use this as a prompt to check the official medical registry before consultation.</small>';
    }
    refreshState();
  }
  function addDoctorProfile() {
    var r = WI.api('POST','/doctors/add',{ name:$('docName').value, registrationNo:$('docReg').value, districtId:$('docAddDistrict').value, speciality:$('docSpec').value, clinic:$('docClinic').value, timings:$('docTimings').value, languages:$('docLang').value, activities:$('docActivities').value, verified:$('docVerified').checked, responsiblePledge:$('docPledge').checked });
    $('docAddMsg').textContent = 'Added '+r.name+' · grade '+r.accessGrade;
    ['docName','docReg','docSpec','docClinic','docTimings','docActivities'].forEach(function(id){ if($(id)) $(id).value=''; });
    renderDoctorProfiles(); renderDoctorGaps(); refreshState();
  }
  function saveDoctorFeedback() {
    var r = WI.api('POST','/doctors/feedback',{ doctorId:$('docFeedbackDoctor').value, communication:$('dfComm').value, respect:$('dfRespect').value, waiting:$('dfWait').value, explanation:$('dfExplain').value, followup:$('dfFollow').value, privateNote:$('dfNote').value });
    $('docFeedbackMsg').textContent = r.note || 'Saved.';
    renderDoctorProfiles(); refreshState();
  }
  function renderDoctorGaps() {
    if (!$('docGapTable')) return;
    var rows = WI.api('GET','/doctors/gaps').slice(0,12);
    $('docGapTable').innerHTML = rows.map(function(g){ return '<tr><td>'+esc(g.district)+'</td><td class="n">'+fmt(g.verified_profiles)+' / '+fmt(g.total_profiles)+'</td><td class="n">'+esc(g.average_access_score)+'</td><td>'+esc(g.gap)+'</td></tr>'; }).join('');
  }
  function renderDoctorCard(id) {
    id = id || ($('docFeedbackDoctor') ? $('docFeedbackDoctor').value : null);
    if (!id) return;
    var c = WI.api('POST','/doctors/card',{ id:id });
    if (c.error) { $('docCardOut').textContent = c.error; return; }
    $('docCardOut').innerHTML = '<div class="qrbox">'+esc(c.code)+'</div><b>'+esc(c.doctor)+'</b><br>Registration: '+esc(c.registrationNo)+'<br>District: '+esc(c.district)+'<br>Public Health Access Grade: <b>'+esc(c.grade)+'</b><br><small>'+esc(c.disclaimer)+'</small>';
  }
  function bindDoctors() {
    if (!$('docList')) return;
    fillDoctorDistrictFilter();
    if ($('docAddDistrict')) fillDistricts($('docAddDistrict'), 'TS23');
    initDoctorMap(); renderDoctorProfiles(); renderDoctorGaps();
    if ($('docVerifyBtn')) $('docVerifyBtn').addEventListener('click', renderDoctorVerify);
    if ($('docSearchBtn')) $('docSearchBtn').addEventListener('click', renderDoctorProfiles);
    if ($('docSearch')) $('docSearch').addEventListener('input', function(){ if (this.value.length === 0 || this.value.length > 2) renderDoctorProfiles(); });
    if ($('docDistrict')) $('docDistrict').addEventListener('change', renderDoctorProfiles);
    if ($('docAddBtn')) $('docAddBtn').addEventListener('click', addDoctorProfile);
    if ($('docFeedbackBtn')) $('docFeedbackBtn').addEventListener('click', saveDoctorFeedback);
    if ($('docGapBtn')) $('docGapBtn').addEventListener('click', renderDoctorGaps);
    if ($('docCardBtn')) $('docCardBtn').addEventListener('click', function(){ renderDoctorCard(); });
  }

  /* ============================================================
     BOOT
     ============================================================ */
  refreshState();
  renderBank();
  renderSignals();
  renderCalendar();
  renderCampaigns();
  renderSafetyAudit();
  renderTrust();
  renderOps();
  renderRecalls();
  renderPatients();
  renderRumours();
  renderReferral();
  runForecast();
  classify();
  initMap();
  bindDoctors();
  try { var __h = (location.hash||'').replace('#',''); if (__h) { var __b = document.querySelector('.tab[data-tab=\''+__h+'\']'); if (__b) __b.click(); } } catch(e){}
})();
