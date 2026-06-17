/* ============================================================
   World Intelligence — application engine
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
    return { lrkus: [], campaigns: [], feedback: [], runs: [], events: [], ops: [], safetyAudits: [], recalls: [], patients: [], day: 0, modelBoost: 0, riskOverrides: {} };
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
  function forecast(domain, seedId, iv, days) {
    days = days || 30;
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
          var lambda = 1.45 * (0.5 * prev[i] + 0.5 * nb) * dr * reach * transMult;
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
      situation: "Reported via loop run", belief: text, action: "—", reasoning: "—",
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
    DB.runs.unshift(run); DB.runs = DB.runs.slice(0, 25); logEvent("loop", run.domain + " · " + run.seed); persist();
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
      title: "World Intelligence Telangana — 7-day Public Health Intelligence Brief",
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

  /* ---------- 2x real-world utility layer across all five core domains ---------- */
  function latestLrku() { var rows = allLrkus(); return rows[rows.length - 1] || rows[0] || {}; }
  function lrkuQuality(o) {
    o = o || latestLrku();
    var fields = ["district","domain","contributor","situation","belief","action","outcome","verification","consent"];
    var present = fields.filter(function (k) { return !!(o[k] && String(o[k]).trim()); }).length;
    var score = Math.round((present / fields.length) * 100);
    if ((o.verification || "").toLowerCase().indexOf("review") >= 0) score = Math.min(100, score + 8);
    if ((o.consent || "").toLowerCase().indexOf("consent") >= 0) score = Math.min(100, score + 6);
    var cls = classify((o.belief || "") + " " + (o.situation || "") + " " + (o.outcome || ""));
    var missing = fields.filter(function (k) { return !(o[k] && String(o[k]).trim()); });
    var use = ["district signal scoring", "Telugu counselling message", "PHC task trigger"];
    if (cls.domain === "dengue" || cls.domain === "vaccine") use.push("infodemic tracking");
    if (cls.domain === "ncd") use.push("missed-follow-up recall");
    return { id: o.id || "new", district: o.district || "—", detected_domain: cls.domain, quality_score: score, missing: missing, risk_type: cls.risk_type, recommended_use: use, action_card: "Verify this field report, classify it as " + cls.domain + ", send through trusted messenger, and record feedback after 72 hours." };
  }
  function microplan(domain, districtId) {
    domain = domain || "dengue"; var d = byId(districtId) || districts[22] || districts[0];
    var sig = signals(domain).filter(function (x) { return x.id === d.id; })[0] || { score: avg(d.base_risks), lrku: 0 };
    var plan = trustPlan(domain, d.id); var msg = messages[domain] || messages.dengue;
    var targetHH = Math.max(200, Math.round(d.households * Math.min(0.18, Math.max(0.03, sig.score * 0.12))));
    var ashaDays = Math.ceil(targetHH / 80);
    var campDays = sig.score >= 0.66 ? 3 : sig.score >= 0.45 ? 2 : 1;
    var tasks = [
      "Verify top 3 ward/colony signals with ASHA/ANM",
      "Send Telugu message through " + plan.recommended.key,
      "Display PHC poster and repeat OPD announcement",
      "Collect 72-hour feedback: reached, believed, visited PHC, remaining myth"
    ];
    if (domain === "ncd") tasks.unshift("Prepare missed-follow-up list from NCD register");
    if (domain === "maternal") tasks.unshift("ANM review of danger-sign cases and referral transport readiness");
    return { district: d.district, districtId: d.id, domain: domain, signal: +sig.score.toFixed(2), target_households: targetHH, estimated_asha_field_days: ashaDays, camp_days: campDays, messenger: plan.recommended, telugu_message: msg.telugu, tasks: tasks };
  }
  function budgetOptimize(domain, districtId, budget) {
    domain = domain || "dengue"; districtId = districtId || "TS24"; budget = +(budget || 50000);
    var options = ["none","asha","doctor","shg","combined"].map(function (iv) {
      var f = forecast(domain, districtId, iv, 30);
      var roi = f.roi || {}; var cost = roi.cost || 0;
      return { intervention: iv, no_action_pct: f.baseline[30], selected_pct: f.selected[30], households_protected: roi.households_protected || 0, cost: cost, cost_per_household: roi.cost_per_household || 0, affordable: cost <= budget || iv === "none" };
    });
    var affordable = options.filter(function (o) { return o.affordable; }).sort(function (a, b) { return (b.households_protected - a.households_protected) || (a.cost - b.cost); });
    var best = affordable[0] || options[0];
    return { budget: budget, domain: domain, district: (byId(districtId) || {}).district, best: best, options: options, recommendation: best.intervention === "none" ? "Budget too low for active campaign; use no-cost PHC/OPD counselling and collect more LRKUs." : "Use " + best.intervention + " first; it protects ~" + best.households_protected + " households within budget." };
  }
  function shieldPack(text, districtId) {
    var cls = classify(text || ""); var msg = messages[cls.domain] || messages.dengue; var d = byId(districtId) || districts[22] || districts[0]; var plan = trustPlan(cls.domain, d.id);
    var base = msg.telugu;
    var variants = [
      { channel: "ASHA audio", telugu: "అక్కా/అన్నా, " + base + " మీకు సందేహం ఉంటే దగ్గరలోని PHC/ASHAని అడగండి." },
      { channel: "PHC doctor OPD line", telugu: "వైద్య సూచన: " + base + " ఆలస్యం ప్రమాదకరం కావచ్చు; పరీక్ష/సలహా కోసం PHCకి రండి." },
      { channel: "SHG group message", telugu: "మన కుటుంబాల కోసం ముఖ్యమైన సమాచారం: " + base + " ఈ సందేశాన్ని మీ కుటుంబ గ్రూపులో పంచండి." }
    ];
    return { claim: text || "", district: d.district, domain: cls.domain, risk_type: cls.risk_type, confidence: cls.confidence, best_messenger: plan.recommended, variants: variants, pre_bunk: ["మందులు/చికిత్స గురించి WhatsApp alone నమ్మవద్దు", "PHC/ASHA/ANMతో నిర్ధారించండి", "ప్రమాద సంకేతాలు ఉంటే ఆలస్యం చేయవద్దు"], whatsapp_bundle: variants.map(function(v){ return v.channel + ": " + v.telugu; }).join("\n\n") };
  }
  function aarogyamChecklist(domain, districtId, month) {
    domain = domain || "dengue"; var d = byId(districtId) || districts[22] || districts[0];
    var action = actions.filter(function (a) { return a.domain === domain || a.month === month; })[0] || actions[0];
    var msg = (messages[domain] || messages.dengue).telugu;
    var checklist = ["ఈ నెల కుటుంబ ఆరోగ్య చర్య చదివాం", "ఇంట్లో ఎవరికైనా ప్రమాద సంకేతాలు ఉన్నాయా అని అడిగాం", "అవసరమైతే PHC/ASHA/ANMను సంప్రదించాం", "తప్పు నమ్మకం/అపోహ ఉంటే నమోదు చేశాం", "72 గంటల తర్వాత ఫీడ్‌బ్యాక్ ఇచ్చాం"];
    if (domain === "dengue") checklist.unshift("ఇంటి చుట్టూ నిల్వ నీరు తొలగించాం");
    if (domain === "ncd") checklist.unshift("BP/షుగర్ మందులు ఆపకుండా ఉన్నారా అని చెక్ చేశాం");
    if (domain === "maternal") checklist.unshift("గర్భిణీ మహిళల్లో వాపు/తలనొప్పి/చూపు సమస్య అడిగాం");
    return { district: d.district, domain: domain, month: month || action.month, title: action.title || (messages[domain] || {}).title, telugu_message: msg, checklist: checklist, feedback_questions: ["ఎన్ని కుటుంబాలకు సందేశం చేరింది?", "ఎన్ని కుటుంబాలు అర్థం చేసుకున్నాయి?", "ఎవరైనా PHCకి వెళ్లారా?", "ఏ అపోహ ఇంకా మిగిలి ఉంది?"], printable_slip: "Aarogyam 365 — " + d.district + "\n" + msg + "\n\nచెక్‌లిస్ట్:\n- " + checklist.join("\n- ") };
  }

  /* ---------- REST-style router ---------- */
  function api(method, route, body) {
    method = (method || "GET").toUpperCase(); body = body || {};
    if (method === "GET" && route === "/overview") return overview();
    if (method === "GET" && route === "/districts") return districts;
    if (method === "GET" && route === "/lrkus") return allLrkus();
    if (method === "POST" && route === "/lrkus") return addLrku(body);
    if (method === "GET" && route === "/signals") return signals(body.domain);
    if (method === "POST" && route === "/forecast") return forecast(body.domain || "dengue", body.seedDistrict || "TS24", body.intervention || "none", body.days);
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
    if (method === "GET" && route === "/recalls") return DB.recalls || [];
    if (method === "POST" && route === "/recall/ncd") return ncdRecall(body.districtId, body.count, body.missedDays);
    if (method === "GET" && route === "/patients") return DB.patients || [];
    if (method === "POST" && route === "/patient/create") return createPatient(body);
    if (method === "POST" && route === "/patients/close") return closePatient(body.id);
    if (method === "POST" && route === "/lrku/analyze") return lrkuQuality(body.lrku || latestLrku());
    if (method === "POST" && route === "/praja/microplan") return microplan(body.domain || "dengue", body.districtId || "TS24");
    if (method === "POST" && route === "/darpan/optimize") return budgetOptimize(body.domain || "dengue", body.districtId || "TS24", body.budget || 50000);
    if (method === "POST" && route === "/shield/pack") return shieldPack(body.text || "", body.districtId || "TS24");
    if (method === "POST" && route === "/aarogyam/checklist") return aarogyamChecklist(body.domain || "dengue", body.districtId || "TS24", body.month || "July");
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
