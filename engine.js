/* ============================================================
   Telangana Nethra — application engine
   A self-contained in-browser backend: data store + REST-style
   API + simulation model + persistence. Deploys static; swap the
   store for Supabase in production without touching the UI.
   ============================================================ */
(function () {
  "use strict";
  var KEY = "wi_fullstack_v1";
  var SEED = window.__WI_SEED || {};
  var districts = (SEED.districts || []).slice();
  var messages = SEED.messages || {};
  var actions = (SEED.actions || []).slice();
  var seedLrkus = (SEED.lrkus || []).slice();
  var MODEL = JSON.parse(JSON.stringify(SEED.model || {}));

  /* ---------- persistence (the "database") ---------- */
  function blank() {
    return { lrkus: [], campaigns: [], feedback: [], runs: [], events: [], ops: [], safetyAudits: [], recalls: [], patients: [], doctors: [], doctorFeedback: [], verificationChecks: [], day: 0, modelBoost: 0, riskOverrides: {} };
  }
  var DB = load();
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!d) return blank();
      var b = blank();
      for (var k in b) if (d[k] === undefined) d[k] = b[k];
      return d;
    } catch (e) { return blank(); }
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) {}
  }
  function logEvent(type, detail) {
    DB.events.unshift({ t: new Date().toISOString(), type: type, detail: detail });
    DB.events = DB.events.slice(0, 60);
  }

  /* ---------- helpers ---------- */
  var DOMAINS = ["dengue", "heat", "ncd", "vaccine", "maternal", "rabies"];
  function byId(id) { for (var i = 0; i < districts.length; i++) if (districts[i].id === id) return districts[i]; return null; }
  function byName(n) { for (var i = 0; i < districts.length; i++) if (districts[i].district === n) return districts[i]; return null; }
  function avg(o) { var s = 0, n = 0; for (var k in o) { s += o[k]; n++; } return n ? s / n : 0; }
  function allLrkus() { return seedLrkus.concat(DB.lrkus); }

  /* ---------- real-data overrides (CSV import replaces synthetic risk) ---------- */
  var SEED_RISKS = {};
  districts.forEach(function (d) { SEED_RISKS[d.id] = JSON.parse(JSON.stringify(d.base_risks)); });
  function applyOverrides() {
    districts.forEach(function (d) {
      d.base_risks = JSON.parse(JSON.stringify(SEED_RISKS[d.id]));
      var o = (DB.riskOverrides || {})[d.id];
      if (o) for (var k in o) if (d.base_risks[k] != null && o[k] != null) d.base_risks[k] = Math.max(0, Math.min(1, +o[k]));
    });
  }
  applyOverrides();

  /* ---------- district network (nearest neighbours by geography) ---------- */
  function dist(a, b) { var dx = a.lat - b.lat, dy = (a.lon - b.lon) * 0.94; return Math.sqrt(dx * dx + dy * dy); }
  var NEIGHBOURS = {};
  districts.forEach(function (d) {
    NEIGHBOURS[d.id] = districts.filter(function (o) { return o.id !== d.id; })
      .sort(function (a, b) { return dist(d, a) - dist(d, b); })
      .slice(0, 8).map(function (o) { return o.id; });
  });
  function catchment(seedId) {
    var ids = [seedId].concat(NEIGHBOURS[seedId] || []);
    return ids.map(byId).filter(Boolean);
  }

  /* ---------- signal engine (Praja Intelligence) ---------- */
  function signals(domain) {
    var counts = {};
    allLrkus().forEach(function (l) {
      if (!domain || l.domain === domain) counts[l.district] = (counts[l.district] || 0) + 1;
    });
    var rows = districts.map(function (d) {
      var base = domain ? (d.base_risks[domain] != null ? d.base_risks[domain] : avg(d.base_risks)) : avg(d.base_risks);
      var lr = counts[d.district] || 0;
      var score = Math.min(1, base + 0.12 * lr + DB.modelBoost * -0.04);
      return { id: d.id, district: d.district, lat: d.lat, lon: d.lon, score: Math.max(0, score), lrku: lr, base: base, households: d.households, population: d.population };
    });
    rows.sort(function (a, b) { return b.score - a.score; });
    return rows;
  }

  /* ---------- forecast / simulation (Praja Darpan) ---------- */
  function correctionRate(iv, d) {
    var c = d.capacity || {};
    switch (iv) {
      case "asha": return 0.02 + 0.10 * (c.asha_strength || 0.6);
      case "doctor": return 0.02 + 0.13 * (c.doctor_trust || 0.6);
      case "shg": return 0.02 + 0.11 * (c.shg_strength || 0.6);
      case "combined": return Math.min(0.34, 0.02 + 0.09 * (c.asha_strength || 0.6) + 0.13 * (c.doctor_trust || 0.6) + 0.07 * (c.shg_strength || 0.6));
      default: return 0.012;
    }
  }
  function forecast(domain, seedId, iv, days, params) {
    days = days || 30;
    var trans = (params && +params.trans) ? +params.trans : 1;
    var cat = catchment(seedId);
    var eff = (MODEL.intervention_effectiveness || {});
    function sim(ivKey) {
      var transMult = eff[ivKey] != null ? eff[ivKey] : 1;
      var st = cat.map(function (d) { return { s: 1, b: d.id === seedId ? 0.18 : 0, c: 0, d: d }; });
      var series = [], finalB = {};
      for (var day = 0; day <= days; day++) {
        var num = 0, den = 0;
        st.forEach(function (x) { num += x.b * x.d.households; den += x.d.households; });
        series.push(+(100 * num / den).toFixed(1));
        if (day === days) { st.forEach(function (x) { finalB[x.d.id] = x.b; }); break; }
        var prev = st.map(function (x) { return x.b; });
        st.forEach(function (x, i) {
          var nb = 0; for (var j = 0; j < st.length; j++) if (j !== i) nb += prev[j];
          nb /= Math.max(1, st.length - 1);
          var dr = x.d.base_risks[domain] != null ? x.d.base_risks[domain] : 0.4;
          var reach = (x.d.capacity && x.d.capacity.mobile_reach) || 0.6;
          var lambda = 1.45 * (0.5 * prev[i] + 0.5 * nb) * dr * reach * transMult * trans;
          var newB = x.s * (1 - Math.exp(-lambda));
          var corr = x.b * correctionRate(ivKey, x.d);
          x.s = Math.max(0, x.s - newB);
          x.b = Math.min(1, Math.max(0, x.b + newB - corr));
          x.c = Math.min(1, x.c + corr);
        });
      }
      return { series: series, finalB: finalB };
    }
    var baseRun = sim("none");
    var chosenRun = sim(iv);
    var totalHH = cat.reduce(function (a, x) { return a + x.households; }, 0);
    var endBase = baseRun.series[days], endSel = chosenRun.series[days];
    var protectedHH = Math.round(Math.max(0, (endBase - endSel) / 100 * totalHH));
    var cost = (MODEL.intervention_cost && MODEL.intervention_cost[iv]) || 0;
    var febrile = Math.round(totalHH * 0.07);
    var delaysAverted = Math.round(Math.max(0, (endBase - endSel) / 100 * febrile));
    return {
      domain: domain, seed: byId(seedId).district, intervention: iv, days: days,
      baseline: baseRun.series, selected: chosenRun.series,
      catchmentDistricts: cat.map(function (d) { return d.id; }),
      catchmentFinal: chosenRun.finalB,
      catchmentHouseholds: totalHH,
      roi: {
        households_protected: protectedHH,
        care_delays_averted: delaysAverted,
        cost: cost,
        cost_per_household: protectedHH > 0 ? +(cost / protectedHH).toFixed(2) : null,
        reach_no_action: Math.round(endBase / 100 * totalHH)
      }
    };
  }

  /* ---------- rumour classifier (Infodemic Shield) ---------- */
  var KW = {
    dengue: ["dengue", "fever", "papaya", "platelet", "mosquito", "spray", "fog", "డెంగ్యూ", "జ్వరం", "బొప్పాయి", "ప్లేట్‌లెట్", "దోమ"],
    ncd: ["bp", "blood pressure", "sugar", "diabetes", "tablet", "kidney", "herbal", "medicine", "షుగర్", "బీపీ", "మందు", "మూత్రపిండ"],
    heat: ["heat", "heatstroke", "water", "dehydration", "sun", "వేడి", "నీరు", "ఎండ"],
    vaccine: ["vaccine", "vaccination", "immuniz", "teeka", "టీకా", "వ్యాక్సిన్"],
    maternal: ["pregnan", "swelling", "headache", "anc", "delivery", "గర్భ", "వాపు", "తలనొప్పి"],
    rabies: ["dog", "bite", "rabies", "kutta", "కుక్క", "కరిచ", "రేబిస్"]
  };
  function classify(text) {
    var t = (text || "").toLowerCase();
    var best = null, bestN = 0;
    DOMAINS.forEach(function (dom) {
      var n = 0; KW[dom].forEach(function (k) { if (t.indexOf(k.toLowerCase()) >= 0) n++; });
      if (n > bestN) { bestN = n; best = dom; }
    });
    if (!best) best = "dengue";
    var risk = { dengue: "Delayed care risk", ncd: "Treatment-stopping risk", heat: "Heat-illness risk", vaccine: "Vaccine-hesitancy risk", maternal: "Maternal danger-sign delay", rabies: "Rabies-exposure risk" }[best];
    return {
      domain: best,
      risk_type: risk,
      confidence: bestN >= 2 ? "high" : bestN === 1 ? "medium" : "low",
      messenger: (MODEL.domain_messengers && MODEL.domain_messengers[best]) || ["ASHA"],
      message: messages[best] || null
    };
  }

  /* ---------- action delivery (Aarogyam 365) ---------- */
  function dispatchCampaign(domain, districtId) {
    var d = byId(districtId) || districts[0];
    var msg = messages[domain] || messages.dengue;
    var c = {
      id: "CMP-" + (DB.campaigns.length + 1001),
      domain: domain, district: d.district, districtId: d.id,
      messenger: ((MODEL.domain_messengers || {})[domain] || ["ASHA"])[0],
      telugu: msg.telugu, title: msg.title,
      households_targeted: d.households, sent_at: new Date().toISOString(),
      received: 0, believed: 0, delayed: 0, responses: 0
    };
    DB.campaigns.unshift(c); logEvent("campaign", c.id + " · " + domain + " · " + d.district); persist();
    return c;
  }
  function recordFeedback(campaignId, fb) {
    var c = null; for (var i = 0; i < DB.campaigns.length; i++) if (DB.campaigns[i].id === campaignId) c = DB.campaigns[i];
    if (!c) return { error: "Campaign not found" };
    c.responses += (fb.responses || 100);
    c.received += (fb.received != null ? fb.received : 78);
    c.believed += (fb.believed != null ? fb.believed : 22);
    c.delayed += (fb.delayed != null ? fb.delayed : 14);
    // feedback closes the loop: good reach nudges the model's confidence up
    DB.modelBoost = Math.min(5, DB.modelBoost + 1);
    DB.feedback.unshift({ campaign: campaignId, at: new Date().toISOString(), fb: fb });
    logEvent("feedback", campaignId + " · model boost " + DB.modelBoost);
    persist();
    return { campaign: c, modelBoost: DB.modelBoost };
  }

  /* ---------- overview ---------- */
  function overview() {
    var lr = allLrkus();
    var byDomain = {}; DOMAINS.forEach(function (d) { byDomain[d] = 0; });
    lr.forEach(function (l) { byDomain[l.domain] = (byDomain[l.domain] || 0) + 1; });
    return {
      model_version: MODEL.version, day: DB.day, model_boost: DB.modelBoost,
      lrku_total: lr.length, lrku_user: DB.lrkus.length,
      districts: districts.length, campaigns: DB.campaigns.length,
      feedback: DB.feedback.length, top_signals: signals(null).slice(0, 5),
      by_domain: byDomain
    };
  }

  /* ---------- the closed loop (all five stages in one call) ---------- */
  function runLoop(opts) {
    opts = opts || {};
    var text = opts.signal_text || "Papaya leaf juice is enough for dengue; no test needed.";
    var seed = opts.seedDistrict || "TS24"; // Rangareddy
    var contributor = opts.contributor || "ASHA";
    // 1. LISTEN + 2. STRUCTURE
    var cls = classify(text);
    var lrku = addLrku({
      district: (byId(seed) || {}).district || "Rangareddy", domain: cls.domain, contributor: contributor,
      situation: "Reported via cycle run", belief: text, action: "—", reasoning: "—",
      outcome: "—", risk: cls.risk_type, verification: "pending", consent: "consented"
    });
    // 3. FORECAST
    var fc = forecast(cls.domain, seed, "combined", 30);
    // 4. ACT  + 5. DELIVER
    var camp = dispatchCampaign(cls.domain, seed);
    var fb = recordFeedback(camp.id, { responses: 120, received: 96, believed: 18, delayed: 9 });
    var run = {
      at: new Date().toISOString(), seed: (byId(seed) || {}).district, domain: cls.domain,
      listen: { lrku_id: lrku.id, text: text },
      structure: { classified: cls.domain, risk: cls.risk_type, messenger: cls.messenger },
      forecast: { no_action_pct: fc.baseline[30], combined_pct: fc.selected[30], households_protected: fc.roi.households_protected },
      act: { campaign: camp.id, telugu: camp.telugu, messenger: camp.messenger },
      deliver: { reached: fb.campaign.received, model_boost: fb.modelBoost }
    };
    DB.runs.unshift(run); DB.runs = DB.runs.slice(0, 25); logEvent("cycle", run.domain + " · " + run.seed); persist();
    return run;
  }
  function addLrku(o) {
    var l = {
      id: "LRKU-" + String(9000 + DB.lrkus.length + 1),
      district: o.district, domain: o.domain, contributor: o.contributor,
      situation: o.situation || "", belief: o.belief || "", action: o.action || "",
      reasoning: o.reasoning || "", outcome: o.outcome || "", risk: o.risk || "",
      verification: o.verification || "pending", consent: o.consent || "consented",
      created_at: new Date().toISOString()
    };
    DB.lrkus.unshift(l); logEvent("lrku", l.id + " · " + l.domain + " · " + l.district); persist();
    return l;
  }



  /* ---------- Jeevana-1 patient voice assistant + safety layer ---------- */
  var RED_FLAGS = {
    dengue: ["bleeding", "blood", "vomit", "persistent vomiting", "drowsy", "severe weakness", "బ్లీడింగ్", "రక్త", "వాంత", "మగత", "బలహీన"],
    heat: ["confusion", "unconscious", "faint", "seizure", "గందరగోళ", "మూర్చ", "స్పృహ", "తల తిర"],
    ncd: ["chest pain", "breathless", "stroke", "fits", "ఛాతి", "శ్వాస", "పక్షవాతం", "ఫిట్స్"],
    maternal: ["bleeding", "fits", "severe headache", "blurred", "swelling", "రక్తస్రావ", "ఫిట్స్", "తలనొప్పి", "చూపు", "వాపు"],
    rabies: ["dog bite", "snake bite", "bleeding", "కుక్క", "పాము", "కరిచ", "రక్త"]
  };
  function safetyTriage(text, domain) {
    var t = (text || "").toLowerCase();
    var cls = domain ? { domain: domain } : classify(text);
    var flags = (RED_FLAGS[cls.domain] || []).filter(function (k) { return t.indexOf(k.toLowerCase()) >= 0; });
    var emergency = flags.length > 0 || /snake|పాము/.test(t);
    var route = emergency ? "Immediate PHC staff / emergency referral" : "PHC help desk / ASHA-ANM counselling";
    var level = emergency ? "RED" : (cls.domain === "maternal" || cls.domain === "rabies" ? "AMBER" : "GREEN");
    var advice = emergency ?
      "వెంటనే ఆరోగ్య సిబ్బందిని సంప్రదించండి. ఆలస్యం చేయవద్దు." :
      "దయచేసి PHC సిబ్బంది / ASHA / ANM వద్ద వివరాలు చెక్ చేయించుకోండి.";
    var audit = { id: "SAFE-" + Date.now(), at: new Date().toISOString(), text: text, domain: cls.domain, level: level, red_flags: flags, route: route };
    DB.safetyAudits.unshift(audit); DB.safetyAudits = DB.safetyAudits.slice(0, 50); logEvent("safety", level + " · " + cls.domain); persist();
    return { domain: cls.domain, level: level, red_flags: flags, route: route, advice_telugu: advice, audit_id: audit.id };
  }
  function patientAnswer(text, mode) {
    var domain = mode && mode !== "auto" ? mode : classify(text).domain;
    var safety = safetyTriage(text, domain);
    var msg = messages[domain] || messages.dengue;
    var prefix = safety.level === "RED" ? "ఇది ప్రమాద సంకేతంగా ఉండవచ్చు. " : "మీరు చెప్పిన విషయం నమోదు చేసుకున్నాను. ";
    var answer = prefix + safety.advice_telugu + "\n\n" +
      "ఇప్పుడు చేయవలసింది: " + msg.telugu + "\n\n" +
      "ఎవరిని సంప్రదించాలి: " + safety.route + ".\n\n" +
      "గమనిక: నేను వైద్యుడికి బదులు కాదు; తుది నిర్ణయం PHC వైద్య సిబ్బంది తీసుకోవాలి.";
    return { domain: domain, safety: safety, answer_telugu: answer, message: msg };
  }

  /* ---------- Trust Network: choose the messenger people are most likely to follow ---------- */
  function trustPlan(domain, districtId) {
    var d = byId(districtId) || districts[0];
    var c = d.capacity || {};
    var options = [
      { key: "ASHA", base: c.asha_strength || 0.6, cost: 8000, reason: "door-to-door trust and follow-up" },
      { key: "ANM", base: ((c.asha_strength || 0.6) + (c.doctor_trust || 0.6)) / 2, cost: 12000, reason: "maternal, vaccine and NCD counselling" },
      { key: "PHC doctor", base: c.doctor_trust || 0.6, cost: 25000, reason: "clinical authority for myth correction" },
      { key: "SHG leader", base: c.shg_strength || 0.6, cost: 10000, reason: "family decision influence through women groups" },
      { key: "teacher", base: domain === "vaccine" ? 0.76 : 0.52, cost: 7000, reason: "school and parent WhatsApp channel" },
      { key: "municipal/panchayat announcement", base: domain === "heat" ? 0.72 : 0.48, cost: 6000, reason: "fast public announcement reach" }
    ];
    options.forEach(function (o) {
      var domainBonus = ((MODEL.domain_messengers || {})[domain] || []).indexOf(o.key) >= 0 ? 0.12 : 0;
      o.score = Math.min(0.98, +(o.base + domainBonus + (c.mobile_reach || 0.6) * 0.08).toFixed(2));
      o.reach_per_1000 = Math.round(1000 * o.score);
      o.cost_per_reached = +(o.cost / Math.max(1, o.reach_per_1000)).toFixed(1);
    });
    options.sort(function (a, b) { return b.score - a.score; });
    return { district: d.district, domain: domain, recommended: options[0], options: options, combined: options.slice(0, 3) };
  }

  /* ---------- PHC Ops Queue: translate intelligence into accountable work ---------- */
  function createOps(domain, districtId, urgency) {
    var d = byId(districtId) || districts[0];
    var plan = trustPlan(domain, districtId);
    var templates = {
      dengue: ["Verify fever/dengue rumour in catchment", "Send ASHA Telugu fever-testing audio", "Review fever cases reported at OPD"],
      heat: ["Identify elderly/outdoor worker high-risk households", "Display heat danger signs at PHC", "Coordinate water/shade IEC point"],
      ncd: ["Call missed BP/diabetes follow-up list", "Counsel medicine-adherence myth", "Check stock of routine NCD medicines"],
      vaccine: ["List schools/colonies with hesitancy", "Prepare doctor myth-busting message", "Coordinate teacher-parent reminder"],
      maternal: ["Flag pregnancy danger-sign reports", "ANM follow-up for swelling/headache", "Check referral transport readiness"],
      rabies: ["Verify bite reports", "Display wound-wash and vaccine urgency message", "Check anti-rabies vaccine guidance desk"]
    };
    var tasks = (templates[domain] || templates.dengue).map(function (t, i) {
      return { id: "OPS-" + Date.now() + "-" + (i + 1), district: d.district, districtId: d.id, domain: domain, task: t, assigned_to: plan.combined[i % plan.combined.length].key, urgency: urgency || "48 hours", status: "open", created_at: new Date().toISOString() };
    });
    DB.ops = tasks.concat(DB.ops || []); DB.ops = DB.ops.slice(0, 100); logEvent("ops", tasks.length + " tasks · " + domain + " · " + d.district); persist();
    return { plan: plan, tasks: tasks };
  }
  function completeOp(id) {
    (DB.ops || []).forEach(function (o) { if (o.id === id) { o.status = "done"; o.completed_at = new Date().toISOString(); } });
    DB.modelBoost = Math.min(5, DB.modelBoost + 0.5); logEvent("ops-done", id + " · model boost " + DB.modelBoost); persist();
    return (DB.ops || []).filter(function (o) { return o.id === id; })[0] || null;
  }

  /* ---------- Minister intelligence brief ---------- */
  function ministerBrief() {
    var o = overview();
    var top = o.top_signals[0] || {};
    var domain = top.domain || "dengue";
    var districtId = top.id || "TS24";
    var d = byId(districtId) || districts[0];
    var riskDomain = DOMAINS.slice().sort(function (a,b){ return (d.base_risks[b]||0)-(d.base_risks[a]||0); })[0];
    var fc = forecast(riskDomain, d.id, "combined", 30);
    var plan = trustPlan(riskDomain, d.id);
    return {
      title: "Telangana Nethra — 7-day Public Health Intelligence Brief",
      generated_at: new Date().toISOString(),
      executive_line: "The system converts Telugu lived-reality reports into district risk, rehearsed response and PHC action tasks.",
      highest_signal_district: d.district,
      highest_risk_domain: riskDomain,
      lrkus: o.lrku_total,
      campaigns: o.campaigns,
      open_ops: (DB.ops || []).filter(function (x) { return x.status !== "done"; }).length,
      forecast: { no_action_pct: fc.baseline[30], combined_pct: fc.selected[30], households_protected: fc.roi.households_protected, cost_per_household: fc.roi.cost_per_household },
      recommended_messengers: plan.combined.map(function (x) { return x.key + " (trust " + Math.round(x.score*100) + "%)"; }),
      next_72_hours: ["Verify top signal with PHC staff", "Deploy Telugu counter-message through trusted messenger", "Collect feedback and update model confidence"],
      safety_position: "Decision support only; no diagnosis, no prescription, no personal identifiers, human approval required."
    };
  }

  /* ---------- primary-care operations: single task, NCD recall, patient register ---------- */
  function addOpTask(o) {
    var t = { id: "OPS-" + Date.now() + "-" + Math.floor(Math.random() * 900 + 100), district: o.district, districtId: o.districtId, domain: o.domain, task: o.task, assigned_to: o.assigned_to || "ASHA", urgency: o.urgency || "48 hours", status: "open", source: o.source || "", created_at: new Date().toISOString() };
    DB.ops = [t].concat(DB.ops || []); DB.ops = DB.ops.slice(0, 120); persist(); return t;
  }
  function ncdRecall(districtId, count, missedDays) {
    var d = byId(districtId) || byName("Nalgonda") || districts[0];
    count = Math.max(1, +(count || 50)); missedDays = Math.max(1, +(missedDays || 30));
    var msg = messages.ncd || messages.dengue;
    var task = addOpTask({ district: d.district, districtId: d.id, domain: "ncd", task: "Recall " + count + " BP/diabetes patients who missed follow-up > " + missedDays + " days", assigned_to: "ANM + ASHA", urgency: missedDays >= 60 ? "24 hours" : "7 days", source: "recall" });
    var recall = { id: "RECALL-" + (DB.recalls.length + 1001), district: d.district, districtId: d.id, count: count, missed_days: missedDays, task: task.id, telugu: msg.telugu, title: msg.title, created_at: new Date().toISOString() };
    DB.recalls.unshift(recall); DB.recalls = DB.recalls.slice(0, 60); logEvent("recall", recall.id + " · " + count + " patients · " + d.district); persist();
    return recall;
  }
  function createPatient(o) {
    var d = byId(o.districtId) || byName(o.district) || districts[0];
    var tr = safetyTriage(o.complaint || "", o.domain && o.domain !== "auto" ? o.domain : undefined);
    var msg = messages[tr.domain] || messages.dengue;
    var n = (DB.patients || []).length + 1;
    var ticket = {
      id: "PT-" + String(1000 + n), token: "JEEVANA-" + String(100 + n),
      district: d.district, districtId: d.id, age_group: o.age_group || "adult", gender: o.gender || "—",
      complaint: o.complaint || "", duration_days: +(o.duration_days || 0),
      domain: tr.domain, level: tr.level, route: tr.route, advice_telugu: tr.advice_telugu, message_telugu: msg.telugu,
      red_flags: tr.red_flags, status: "waiting", created_at: new Date().toISOString()
    };
    DB.patients.unshift(ticket); DB.patients = DB.patients.slice(0, 120); logEvent("patient", ticket.token + " · " + ticket.level + " · " + ticket.domain);
    if (tr.level === "RED") addOpTask({ district: d.district, districtId: d.id, domain: tr.domain, task: "Immediate review for " + ticket.token + " (" + (o.complaint || "") + ")", assigned_to: "PHC MO / Staff nurse", urgency: "now", source: ticket.id });
    else if (tr.level === "AMBER") addOpTask({ district: d.district, districtId: d.id, domain: tr.domain, task: "Same-day counselling for " + ticket.token, assigned_to: "ANM / ASHA", urgency: "today", source: ticket.id });
    persist(); return ticket;
  }
  function closePatient(id) {
    var p = null; (DB.patients || []).forEach(function (x) { if (x.id === id) { x.status = "closed"; x.closed_at = new Date().toISOString(); p = x; } });
    if (p) { DB.modelBoost = Math.min(5, DB.modelBoost + 0.25); logEvent("patient-closed", p.token); persist(); }
    return p || { error: "Patient ticket not found" };
  }

  /* ---------- vetted rumour library (real myths + safe Telugu replies) ---------- */
  var RUMOURS = [
    { domain: "dengue", myth: "Papaya-leaf juice cures dengue and raises platelets, so a blood test is not needed.", truth: "There is no proven home cure. A blood test and watching for warning signs are what protect the patient.", te: "బొప్పాయి ఆకుల రసం డెంగ్యూకి నివారణ కాదు. జ్వరం ఉంటే పరీక్ష చేయించుకోండి; తీవ్ర కడుపు నొప్పి, వాంతులు, రక్తస్రావం ఉంటే వెంటనే ఆరోగ్య కేంద్రానికి వెళ్లండి." },
    { domain: "dengue", myth: "Once the fever comes down, dengue is over.", truth: "The day or two after the fever drops can be the most dangerous phase. Keep watching for warning signs.", te: "జ్వరం తగ్గాక కూడా ప్రమాదం ఉండవచ్చు. తీవ్ర కడుపు నొప్పి, ఆగని వాంతులు, నీరసం ఉంటే వెంటనే వైద్యుని సంప్రదించండి." },
    { domain: "dengue", myth: "Mosquito fogging is more harmful than dengue itself.", truth: "Removing stored water stops breeding. Untreated breeding sites are what spread the disease.", te: "నిల్వ ఉన్న నీటిని తొలగించడం డెంగ్యూను అరికడుతుంది. దోమల ఉత్పత్తి ప్రదేశాలను వదిలేస్తే వ్యాధి వ్యాపిస్తుంది." },
    { domain: "ncd", myth: "You can stop BP or sugar tablets once you feel fine.", truth: "These are long-term medicines. Stopping them without a doctor's advice is dangerous.", te: "లక్షణాలు తగ్గినా బీపీ, షుగర్ మందులు వైద్యుడు చెప్పకుండా ఆపకండి. సందేహం ఉంటే ఆరోగ్య కేంద్రంలో అడగండి." },
    { domain: "ncd", myth: "BP tablets damage the kidneys, so it is safer to avoid them.", truth: "Uncontrolled high BP is what harms the kidneys; the tablets help protect them. Raise any concern with a doctor.", te: "అదుపులో లేని బీపీ మూత్రపిండాలను దెబ్బతీస్తుంది; మందులు రక్షిస్తాయి. సందేహం ఉంటే వైద్యుని అడగండి, సొంతంగా ఆపకండి." },
    { domain: "ncd", myth: "Herbal powder can fully replace diabetes medicine.", truth: "Diet helps, but it does not replace prescribed medicine. Stopping it can raise sugar dangerously.", te: "మూలికల పొడి మధుమేహం మందుకు పూర్తి ప్రత్యామ్నాయం కాదు. మందు ఆపితే షుగర్ ప్రమాదకరంగా పెరగవచ్చు. వైద్యుని సలహా తీసుకోండి." },
    { domain: "heat", myth: "Drink less water during work to avoid frequent urination.", truth: "In heat this causes dangerous dehydration. Drink water regularly and rest in shade.", te: "వేడిలో నీళ్లు తక్కువ తాగితే ప్రమాదకరమైన నిర్జలీకరణం వస్తుంది. తరచూ నీరు తాగండి, నీడలో విశ్రాంతి తీసుకోండి." },
    { domain: "heat", myth: "Only old people get heat stroke.", truth: "Anyone can. Outdoor workers, children and the elderly are most at risk.", te: "వడదెబ్బ ఎవరికైనా రావచ్చు. బయట పనిచేసేవారు, పిల్లలు, వృద్ధులు ఎక్కువ ప్రమాదంలో ఉంటారు. తల తిరిగితే వెంటనే నీడ, నీరు, సహాయం తీసుకోండి." },
    { domain: "vaccine", myth: "Vaccines cause infertility.", truth: "There is no evidence for this. Vaccines protect against serious disease. Ask a doctor or ANM.", te: "టీకాలు సంతానలేమికి కారణం అనేది అపోహ. టీకాలు తీవ్రమైన వ్యాధుల నుండి రక్షిస్తాయి. సందేహం ఉంటే వైద్యుడిని లేదా ANMని అడగండి." },
    { domain: "vaccine", myth: "The vaccine gives you the disease.", truth: "Most vaccines cannot cause the disease. A mild fever afterwards is a normal immune response.", te: "చాలా టీకాలు వ్యాధిని కలిగించవు. టీకా తర్వాత తేలికపాటి జ్వరం సాధారణం. అపోహల వల్ల అవసరమైన టీకాను ఆలస్యం చేయవద్దు." },
    { domain: "maternal", myth: "Swelling and headache in late pregnancy are normal and can be ignored.", truth: "They can be signs of pre-eclampsia. A BP check is needed urgently.", te: "గర్భధారణలో వాపు, తలనొప్పి లేదా చూపు మసకగా ఉంటే నిర్లక్ష్యం చేయవద్దు — వెంటనే బీపీ పరీక్ష చేయించాలి." },
    { domain: "maternal", myth: "Home delivery is fine, the way it was done in earlier generations.", truth: "Institutional delivery is safer, and danger signs need a hospital immediately.", te: "ఆసుపత్రి ప్రసవం సురక్షితం. ప్రమాద సంకేతాలు ఉంటే వెంటనే ఆసుపత్రికి వెళ్లండి." },
    { domain: "rabies", myth: "A small bite, or a healthy-looking dog, needs no injection.", truth: "Any bite needs washing and anti-rabies advice the same day. Rabies is almost always fatal once symptoms begin.", te: "ఏ కుక్క కరిచినా గాయాన్ని సబ్బుతో కడిగి అదే రోజు ఆరోగ్య కేంద్రంలో టీకా గురించి సలహా తీసుకోండి. ఆలస్యం చేయవద్దు." },
    { domain: "rabies", myth: "Applying chilli, turmeric or herbs treats a dog bite.", truth: "Wash the wound with soap and running water and seek the vaccine. Home remedies do not prevent rabies.", te: "కుక్క కరిస్తే మిరప లేదా పసుపు రాయడం పనిచేయదు. గాయాన్ని సబ్బు, నీటితో కడిగి వెంటనే టీకా కోసం వైద్య సలహా తీసుకోండి." }
  ];
  /* ---------- referral / danger-sign field guide (conservative, route-to-care) ---------- */
  var REFERRAL = [
    { domain: "dengue", title: "Dengue warning signs — refer now if any appear", signs: ["severe abdominal pain", "persistent vomiting", "bleeding from gums, nose or skin; or black stools", "extreme weakness, drowsiness or restlessness", "cold, clammy skin"], te: "ఈ సంకేతాలు ఉంటే వెంటనే ఆరోగ్య కేంద్రానికి: తీవ్ర కడుపు నొప్పి, ఆగని వాంతులు, రక్తస్రావం, తీవ్ర నీరసం, చల్లని చెమట." },
    { domain: "ncd", title: "BP / diabetes emergencies — refer now", signs: ["chest pain or breathlessness", "very high BP with severe headache or vision change", "weakness on one side of the body or slurred speech", "confusion, heavy sweating or unconsciousness (possible low sugar)", "very high sugar with rapid breathing"], te: "ఛాతి నొప్పి, శ్వాస ఇబ్బంది, ఒక వైపు బలహీనత, గందరగోళం లేదా అపస్మారక స్థితి ఉంటే వెంటనే ఆసుపత్రికి తరలించండి." },
    { domain: "heat", title: "Heat emergency — act immediately", signs: ["confusion or fainting", "very high body temperature", "hot, dry skin or sweating that has stopped", "seizures", "fast heartbeat with severe weakness"], te: "గందరగోళం, మూర్ఛ, చాలా ఎక్కువ ఒంటి వేడి, మూర్ఛలు ఉంటే వెంటనే నీడకు తరలించి, ఒళ్లు చల్లబరిచి, అత్యవసర సహాయం పిలవండి." },
    { domain: "vaccine", title: "After vaccination — seek urgent care if", signs: ["difficulty breathing", "swelling of the face, lips or throat", "very high fever that does not settle", "persistent crying or a seizure in a child"], te: "టీకా తర్వాత శ్వాస ఇబ్బంది, ముఖం లేదా పెదవుల వాపు, తగ్గని తీవ్ర జ్వరం, మూర్ఛ ఉంటే వెంటనే వైద్య సహాయం తీసుకోండి." },
    { domain: "maternal", title: "Pregnancy danger signs — hospital now", signs: ["severe headache or blurred vision", "swelling of the face and hands", "severe abdominal pain", "any bleeding", "reduced or absent fetal movement", "fits or breathlessness"], te: "గర్భధారణలో తీవ్ర తలనొప్పి, చూపు మసక, ముఖం/చేతుల వాపు, రక్తస్రావం, కడుపులో కదలికలు తగ్గడం, మూర్ఛలు ఉంటే వెంటనే ఆసుపత్రికి." },
    { domain: "rabies", title: "Any animal bite or scratch — same-day action", signs: ["wash the wound with soap under running water for 15 minutes", "do not apply chilli, turmeric or herbs", "go for anti-rabies advice the same day", "never wait for symptoms — rabies is preventable but not curable"], te: "ఏ జంతువు కరిచినా లేదా గీరినా 15 నిమిషాలు సబ్బు, నీటితో కడగండి; మిరప/పసుపు వద్దు; అదే రోజు యాంటీ-రేబిస్ సలహా తీసుకోండి." }
  ];
  function rumours(q, domain) {
    q = (q || "").toLowerCase();
    return RUMOURS.filter(function (r) {
      if (domain && r.domain !== domain) return false;
      if (!q) return true;
      return (r.myth + " " + r.truth + " " + r.domain).toLowerCase().indexOf(q) >= 0;
    });
  }
  function referral(q) {
    q = (q || "").toLowerCase();
    if (!q) return REFERRAL;
    return REFERRAL.filter(function (g) { return (g.title + " " + g.signs.join(" ") + " " + g.domain).toLowerCase().indexOf(q) >= 0; });
  }
  function importLrkus(rows) {
    var n = 0;
    (rows || []).forEach(function (o) {
      if (!o || (!o.belief && !o.situation)) return;
      addLrku({ district: o.district || "Rangareddy", domain: o.domain || "dengue", contributor: o.contributor || "field import", belief: o.belief || "", situation: o.situation || "", risk: o.risk || "" });
      n++;
    });
    logEvent("import", n + " field reports imported"); return n;
  }

  var seedDoctors = (SEED.doctors || []).slice();

  /* ---------- Aarogya Darpan Telangana: verified doctor access network ---------- */
  function allDoctors() { return seedDoctors.concat(DB.doctors || []); }
  function doctorById(id) { var a = allDoctors(); for (var i=0;i<a.length;i++) if (a[i].id === id) return a[i]; return null; }
  function normalizeText(x) { return String(x || '').trim().toLowerCase(); }
  function expAverage(e) {
    e = e || {}; var vals = ['communication','respect','waiting','explanation','followup'].map(function(k){ return +e[k] || 0; }).filter(function(v){ return v > 0; });
    if (!vals.length) return 0; return vals.reduce(function(a,b){return a+b;},0) / vals.length;
  }
  function doctorScore(doc) {
    if (!doc) return { score: 0, grade: '—', label: 'No profile' };
    if (!doc.verified) return { score: 0, grade: 'UNVERIFIED', label: 'Unable to verify registration' };
    var score = 0;
    score += 25; // verified registration
    score += Math.round(15 * (+doc.profileComplete || 0));
    score += Math.round(15 * (+doc.accessScore || 0));
    score += Math.round(15 * (expAverage(doc.experience) / 5));
    score += Math.min(15, (doc.publicHealthActivities || []).length * 5);
    score += doc.responsiblePledge ? 10 : 0;
    var g = +doc.googleRating || 0, n = +doc.googleReviews || 0;
    var googleSignal = Math.min(5, Math.max(0, (g / 5) * 3 + Math.min(2, n / 75)));
    score += Math.round(googleSignal);
    score = Math.min(100, Math.max(0, score));
    var grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'INCOMPLETE';
    var label = grade === 'A+' ? 'Excellent public-health transparency' : grade === 'A' ? 'Strong public-health access' : grade === 'B' ? 'Basic verified access' : grade === 'C' ? 'Limited profile transparency' : 'Profile incomplete';
    return { score: score, grade: grade, label: label };
  }
  function doctorWithScore(doc) {
    var d = JSON.parse(JSON.stringify(doc));
    var sc = doctorScore(d); d.accessGrade = sc.grade; d.accessScore100 = sc.score; d.gradeLabel = sc.label;
    return d;
  }
  function doctorsList(q) {
    q = q || {}; var term = normalizeText(q.term), dist = q.districtId || q.district || '', minVerified = !!q.verifiedOnly;
    var rows = allDoctors().filter(function(d){
      var ok = true;
      if (dist) ok = ok && (d.districtId === dist || d.district === dist);
      if (minVerified) ok = ok && !!d.verified;
      if (term) ok = ok && [d.name,d.registrationNo,d.speciality,d.clinic,d.district].join(' ').toLowerCase().indexOf(term) >= 0;
      return ok;
    }).map(doctorWithScore);
    rows.sort(function(a,b){ return (b.accessScore100||0) - (a.accessScore100||0); });
    return rows;
  }
  function verifyDoctor(query) {
    var q = normalizeText(query);
    var d = allDoctors().filter(function(x){ return normalizeText(x.registrationNo) === q || normalizeText(x.name).indexOf(q) >= 0; })[0];
    var result = d ? doctorWithScore(d) : null;
    var out = result ? { status: result.verified ? 'verified' : 'unable_to_verify', doctor: result, message: result.verified ? 'Registration matched in the demo registry layer.' : 'Profile exists but registration is not verified in this demo layer.' } : { status: 'not_found', doctor: null, message: 'Unable to verify this doctor/profile in the local demo data. Check NMC/TSMC official registry before consultation.' };
    DB.verificationChecks.unshift({ id:'VERIFY-' + Date.now(), at:new Date().toISOString(), query: query, status: out.status }); DB.verificationChecks = DB.verificationChecks.slice(0,80);
    logEvent('doctor-verify', out.status + ' · ' + query); persist(); return out;
  }
  function addDoctor(o) {
    var d = byId(o.districtId) || byName(o.district) || districts[22] || districts[0];
    var doc = {
      id: 'DOC-USER-' + Date.now(), name: o.name || 'Claimed doctor profile', registrationNo: o.registrationNo || 'pending',
      districtId: d.id, district: d.district, lat: d.lat + (Math.random()-0.5)*0.06, lon: d.lon + (Math.random()-0.5)*0.06,
      speciality: o.speciality || 'General practice', clinic: o.clinic || 'Clinic address pending', languages: o.languages || 'Telugu', timings: o.timings || 'Timings pending',
      verified: !!o.verified, claimed: true, demoProfile: false, googleRating: +(o.googleRating || 0), googleReviews: +(o.googleReviews || 0),
      profileComplete: o.name && o.registrationNo && o.clinic && o.timings ? 0.82 : 0.48, accessScore: +(o.accessScore || 0.62),
      publicHealthActivities: String(o.activities || '').split(',').map(function(x){return x.trim();}).filter(Boolean),
      badges: ['Claimed profile'].concat(o.verified ? ['Verified Doctor'] : ['Pending verification']), responsiblePledge: !!o.responsiblePledge,
      experience: { communication: 0, respect: 0, waiting: 0, explanation: 0, followup: 0, count: 0 }, created_at: new Date().toISOString()
    };
    DB.doctors.unshift(doc); logEvent('doctor-profile', doc.name + ' · ' + doc.district); persist(); return doctorWithScore(doc);
  }
  function addDoctorFeedback(o) {
    var doc = null, isSeed = false;
    for (var i=0;i<seedDoctors.length;i++) if (seedDoctors[i].id === o.doctorId) { doc = seedDoctors[i]; isSeed = true; }
    for (var j=0;j<(DB.doctors||[]).length;j++) if (DB.doctors[j].id === o.doctorId) doc = DB.doctors[j];
    if (!doc) return { error: 'Doctor not found' };
    var fb = { id:'DFB-' + Date.now(), doctorId:o.doctorId, at:new Date().toISOString(), communication:+o.communication||3, respect:+o.respect||3, waiting:+o.waiting||3, explanation:+o.explanation||3, followup:+o.followup||3, privateNote:o.privateNote||'' };
    DB.doctorFeedback.unshift(fb); DB.doctorFeedback = DB.doctorFeedback.slice(0,200);
    if (!isSeed) {
      var e = doc.experience || { communication:0,respect:0,waiting:0,explanation:0,followup:0,count:0 };
      var n = +e.count || 0, keys = ['communication','respect','waiting','explanation','followup'];
      keys.forEach(function(k){ e[k] = ((+e[k]||0)*n + fb[k])/(n+1); }); e.count = n+1; doc.experience = e;
    }
    logEvent('doctor-feedback', doc.name + ' · patient experience saved privately'); persist(); return { feedback: fb, doctor: doctorWithScore(doc), note: isSeed ? 'Seed demo profile is not modified; feedback stored privately.' : 'Profile score updated.' };
  }
  function doctorAccessGaps() {
    var docs = allDoctors();
    return districts.map(function(d){
      var ds = docs.filter(function(x){ return x.districtId === d.id; });
      var verified = ds.filter(function(x){ return x.verified; });
      var avgGrade = verified.length ? Math.round(verified.reduce(function(a,x){return a + doctorScore(x).score;},0)/verified.length) : 0;
      var perLakh = +(verified.length / Math.max(1, d.population) * 100000).toFixed(2);
      var gap = verified.length === 0 ? 'No verified profiles in demo' : perLakh < 0.4 ? 'Low verified-map coverage' : avgGrade < 65 ? 'Profiles need transparency improvement' : 'Adequate demo coverage';
      return { districtId:d.id, district:d.district, verified_profiles:verified.length, total_profiles:ds.length, verified_per_lakh:perLakh, average_access_score:avgGrade, gap:gap };
    }).sort(function(a,b){ return a.verified_profiles - b.verified_profiles || a.average_access_score - b.average_access_score; });
  }
  function doctorQrCard(id) {
    var d = doctorById(id); if (!d) return { error:'Doctor not found' };
    var sc = doctorScore(d);
    return { title:'Aarogya Darpan Telangana — Verify Before Visit', code:'ADTG-' + d.id.replace(/[^0-9A-Z]/g,'').slice(-8), doctor:d.name, registrationNo:d.registrationNo, district:d.district, grade:sc.grade, disclaimer:'Access grade is not a clinical-quality ranking. Verify registration through official NMC/TSMC sources before relying on any profile.' };
  }

  /* ---------- REST-style router ---------- */
  function api(method, route, body) {
    method = (method || "GET").toUpperCase(); body = body || {};
    if (method === "GET" && route === "/overview") return overview();
    if (method === "GET" && route === "/districts") return districts;
    if (method === "GET" && route === "/lrkus") return allLrkus();
    if (method === "POST" && route === "/lrkus") return addLrku(body);
    if (method === "GET" && route === "/signals") return signals(body.domain);
    if (method === "POST" && route === "/forecast") return forecast(body.domain || "dengue", body.seedDistrict || "TS24", body.intervention || "none", body.days, body.params);
    if (method === "POST" && route === "/classify") return classify(body.text);
    if (method === "POST" && route === "/campaign") return dispatchCampaign(body.domain || "dengue", body.districtId || "TS24");
    if (method === "GET" && route === "/campaigns") return DB.campaigns;
    if (method === "POST" && route === "/feedback") return recordFeedback(body.campaignId, body);
    if (method === "POST" && route === "/loop/run") return runLoop(body);
    if (method === "GET" && route === "/model") return MODEL;
    if (method === "GET" && route === "/events") return DB.events;
    if (method === "POST" && route === "/patient/answer") return patientAnswer(body.text || "", body.mode || "auto");
    if (method === "POST" && route === "/safety/triage") return safetyTriage(body.text || "", body.domain);
    if (method === "POST" && route === "/trust/plan") return trustPlan(body.domain || "dengue", body.districtId || "TS24");
    if (method === "POST" && route === "/ops/create") return createOps(body.domain || "dengue", body.districtId || "TS24", body.urgency || "48 hours");
    if (method === "POST" && route === "/ops/complete") return completeOp(body.id);
    if (method === "GET" && route === "/ops") return DB.ops || [];
    if (method === "GET" && route === "/safety/audits") return DB.safetyAudits || [];
    if (method === "GET" && route === "/minister/brief") return ministerBrief();
    if (method === "GET" && route === "/rumours") return rumours(body.q, body.domain);
    if (method === "GET" && route === "/referral") return referral(body.q);
    if (method === "POST" && route === "/lrkus/import") return importLrkus(body.rows);
    if (method === "GET" && route === "/recalls") return DB.recalls || [];
    if (method === "POST" && route === "/recall/ncd") return ncdRecall(body.districtId, body.count, body.missedDays);
    if (method === "GET" && route === "/patients") return DB.patients || [];
    if (method === "GET" && route === "/doctors") return doctorsList(body);
    if (method === "POST" && route === "/doctors/search") return doctorsList(body);
    if (method === "POST" && route === "/doctors/verify") return verifyDoctor(body.query || body.registrationNo || body.name || "");
    if (method === "POST" && route === "/doctors/add") return addDoctor(body);
    if (method === "POST" && route === "/doctors/feedback") return addDoctorFeedback(body);
    if (method === "GET" && route === "/doctors/gaps") return doctorAccessGaps();
    if (method === "POST" && route === "/doctors/card") return doctorQrCard(body.id || body.doctorId);
    if (method === "GET" && route === "/doctors/verifications") return DB.verificationChecks || [];
    if (method === "POST" && route === "/patient/create") return createPatient(body);
    if (method === "POST" && route === "/patients/close") return closePatient(body.id);
    return { error: "No route " + method + " " + route };
  }

  window.WI = {
    api: api,
    domains: DOMAINS,
    districts: function () { return districts; },
    messages: function () { return messages; },
    actions: function () { return actions; },
    model: function () { return MODEL; },
    neighbours: NEIGHBOURS,
    reset: function () { DB = blank(); applyOverrides(); persist(); },
    importData: function (overrides) { DB.riskOverrides = overrides || {}; applyOverrides(); persist(); return Object.keys(DB.riskOverrides).length; },
    dataSource: function () { return Object.keys(DB.riskOverrides || {}).length ? "imported" : "synthetic"; },
    export: function () {
      var blob = new Blob([JSON.stringify(DB, null, 2)], { type: "application/json" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = "world_intelligence_data.json"; a.click();
    }
  };
})();
