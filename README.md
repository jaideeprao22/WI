# Telangana Nethra — Public Health Intelligence Network

A working, end-to-end demonstration of one full cycle:
**Listen → Structure → Forecast → Act → Deliver.**

Ten working features, one shared in-browser engine (behaves like a real
backend: data store + REST-style API + model). No server to run,
no build step. It works on GitHub Pages, on any static host, and
even by opening `index.html` directly.

---

## What's inside

| Tab | Feature | What it does |
|---|---|---|
| 01 | **Lived Reality** | Capture a field report as a structured LRKU; it flows live into the signals and map |
| 02 | **Praja Intelligence** | Live signal score for all 33 districts + geographic map |
| 03 | **Praja Darpan** | 30-day spread forecast + a decision panel (who's protected, at what cost per 1,000) |
| 04 | **Infodemic Shield** | Classify a rumour (English or Telugu) → vetted Telugu counter-message + messenger |
| 05 | **Aarogyam 365** | 12-month action calendar; dispatch + feedback that visibly sharpens the model |
| 06 | **Jeevana-1 Voice Kiosk** | Telugu patient question → safe answer → speech playback → LRKU save |
| 07 | **Praja Suraksha** | Red-flag safety triage and audit log |
| 08 | **Trust Network Planner** | Chooses ASHA/ANM/doctor/SHG/teacher by trust-weighted reach and cost |
| 09 | **PHC Action Queue** | Converts intelligence into accountable PHC tasks |
| 10 | **Minister Brief** | One-click executive brief with forecast, cost, action and safety boundary |

The **Run the full cycle** button at the top pushes one real signal
through all five stages and animates it.

---

## Put it online (GitHub Pages) — no coding

1. **Unzip** this folder on your computer.
2. Go to **github.com → New repository.** Name it (e.g. `world-intelligence`), set **Public**, click **Create**.
3. On the repo page: **Add file → Upload files.**
4. Open the unzipped folder, select **everything inside it** (the files *and* the `vendor` folder — not the outer folder itself), and drag them into the upload box.
5. Click **Commit changes.**
6. Go to **Settings → Pages.** Under **Source**, choose **Deploy from a branch**, pick **`main`** and **`/ (root)`**, click **Save.**
7. Wait about a minute, then refresh. Your live link appears at the top of that page (e.g. `https://<your-name>.github.io/world-intelligence/`).

That link is what you share or open in the room.

---

## Good to know

- **Offline:** everything works without internet **except** the map's background tiles. The coloured district markers still appear; only the street basemap hides. Safe for a low-bandwidth room.
- **Data:** anything you add is saved in that browser only. **Reset data** (bottom bar) restores the seed set. **Export JSON** downloads the current state.
- **The numbers are illustrative.** Real district populations, synthetic risk and effectiveness assumptions — a planning model, not a validated forecast. That line is on the page on purpose; keep it.
- **Production path:** the entire data layer lives in `engine.js`. Swapping it for Supabase (real database, multi-user) is an isolated change — the whole UI stays exactly as is.

---

## Files

```
index.html      the console (everything renders here)
styles.css      design system
data.js         seed data (33 districts, 6 domains, 12 actions, messages)
engine.js       the backend: data store + API + forecast model
app.js          the UI wiring
vendor/leaflet  the map library, bundled (so the map needs no CDN)
```


## What was upgraded in this version

This version was rebuilt from a good MVP into a more minister-ready working prototype. New modules added:

1. **Jeevana-1 Telugu Voice Kiosk** — patient-facing PHC assistant mode with Telugu speech input/playback, local safe-answer engine and LRKU capture.
2. **Praja Suraksha Layer** — red-flag safety screen that prevents the AI from acting like a doctor; every danger signal is routed to PHC staff and logged.
3. **Trust Network Planner** — ranks ASHA, ANM, PHC doctor, SHG leader, teacher and civic announcement by district trust, reach and cost-per-reached household.
4. **PHC Ops Queue** — converts simulation output into tasks with assignee, urgency and completion status.
5. **Minister Brief Generator** — one-click print-ready executive summary for officials.

These features make the product feel like a deployable public-health intelligence system, not only a simulation dashboard.

---

## What this build adds (real, working — not demo theater)

**1. Real dispatch.** On the Infodemic Shield, Aarogyam 365 and Jeevana Voice tabs, the vetted Telugu message can be sent on **WhatsApp** (opens WhatsApp with the message pre-filled) or **copied** to paste anywhere. No backend — it uses the phone's own WhatsApp, so a real worker can broadcast a vetted message to their groups today.

**2. Install and run fully offline (PWA).** On a phone or laptop (served over https / GitHub Pages), an **Install** button appears in the top bar. Once installed it opens like an app and works with **no internet** — only the map's street tiles need a connection; everything else (signals, forecast, voice playback, vetted messages) runs offline. Built for low-connectivity field use.

**3. Import real surveillance data (CSV).** On the Praja Intelligence tab: **Download template** → fill the `district` rows with real numbers for any of dengue / heat / ncd / vaccine / maternal / rabies (0–1, or 0–100 and it scales) → **Import & recompute**. The map, signals and forecast immediately run on your real IDSP/field data instead of the synthetic baseline. **Export current signals** saves the live scores as CSV. The top bar shows whether the model is running on `synthetic` or `imported` data. **Revert to synthetic** restores the baseline.

## Honest limits (so you never overclaim)

- Until you import real data, the risk numbers are a **synthetic baseline**; the forecast is an **illustrative mechanistic model on real populations**, not a validated prediction. (The footer says exactly this — keep it.)
- It is a **single-operator tool**: data lives in that one browser/device (localStorage). It is not yet a central, multi-user system. The clean upgrade path is to point the engine's data layer at **Supabase** — the UI does not change.
- The voice and patient-answer features are **rules-based and conservative on purpose** (no diagnosis, no doses, danger-sign → PHC referral, every answer audited). That boundary is the point; do not loosen it.

---

## Added in this build (adapted from the field-ops version, then wired together)

**NCD Recall (tab 11).** Generate a recall for a district — *N* BP/diabetes patients who missed follow-up > *X* days. It raises an ANM/ASHA task in PHC Ops automatically and hands you the vetted Telugu reminder to send on WhatsApp. This targets the quietest failure in primary care: the chronic patient who stops coming and is lost until a crisis.

**Patient Queue (tab 12).** Register a walk-in or kiosk patient with a complaint. The system triages it **RED / AMBER / GREEN**, returns the Telugu advice and the referral route, and for RED/AMBER **auto-raises a follow-up task** so a danger sign is never dropped. No diagnosis, no dose — danger signs route straight to PHC staff, every step logged.

**Today's worklist (Overview).** One prioritised list pulled from the whole system — RED/AMBER patients first, then "act now" tasks, recalls, and high-signal districts. This is the "what do I do right now" view that turns the console into a daily driver instead of a dashboard.

All three are wired to the same WhatsApp dispatch and the same engine, so a recall or a triage result becomes a real message a real worker can send. The honest limits above still apply: forecasting is illustrative until real data is imported, and it remains a single-operator tool until the engine's store is pointed at Supabase.

---

## Depth added across the five domains (this build)

The previous version was wide but shallow — one form, one result per domain. This build adds real, usable depth, with honest labels on what is a tool vs. a model:

- **Infodemic Shield → Rumour library.** 14 real health myths circulating in the field (papaya-leaf "cure", stopping BP/sugar tablets, vaccine-infertility, dog-bite remedies, pregnancy swelling, "drink less water in heat", etc.), each with a vetted plain-English reality and a **safe Telugu reply ready to send on WhatsApp or copy**. Searchable. This is a real job-aid, not a model.
- **Safety Guard → Referral & danger-sign field guide.** Conservative "refer immediately if…" criteria for all six domains in English + Telugu, searchable, **works offline**. Routes danger signs to PHC staff — no diagnosis, no dose.
- **Praja Darpan → tunable, transparent forecast.** A transmission-intensity control lets the user set local outbreak speed; the model recomputes live and shows the multiplier. The hidden assumption is now in the operator's hands and on screen. Still an illustrative model — clearly labelled.
- **Lived Reality → bulk field-report import + search + export.** Import a whole register of field observations from CSV, search the knowledge bank, and export it back to CSV for analysis. Real data in and out.
- **Aarogyam 365 → calendar export (.ics).** The 12 monthly prevention actions download as a phone calendar with yearly reminders and the Telugu message in each event.

**Honest ceiling (unchanged):** the forecast is a model, not a measured prediction; everything runs in one browser on `localStorage`. It becomes a multi-user system only when the engine's store is pointed at Supabase (the UI is already structured for it), and it becomes *proven* only after a real pilot with one ASHA/PHC using real data. More tabs will not change that — depth and a field test will.

---

## Added: Aarogya Darpan Telangana (tab 13) — verified-doctor access layer

Adapted from the standalone build and merged into this (full-feature) version so nothing else was lost. It is a citizen-facing **doctor access + anti-quackery transparency** layer, deliberately built to stay on the safe side of the law:

- **Verify before visit** — check a name/registration; the demo answers verified / unable-to-verify and always points to the official **NMC National Medical Register / Telangana State Medical Council** for real confirmation.
- **Doctor access map + profiles** with a **Public Health Access Grade** that explicitly measures registration, transparency, public-health participation, access and structured patient experience — **not clinical quality**, and not a "best/worst doctor" list.
- **Claim/add profile** (opt-in), **structured patient-experience signal** (private, not public allegations), **district access-gap table** (aggregate, population-level), and a **QR trust card** a doctor generates for their own profile.

**Safety properties baked in:** every profile is a clearly-labelled fictional **"Dr. Demo …"** sample with a placeholder **TSMC-DEMO** number — no real doctor is named, graded, or "verified," and nothing is scraped from any registry. A banner states this on the tab. That is the difference between a safe transparency concept and a defamation/data-protection problem.

---

## Telangana Nethra — front door (this build)

The app was rebranded from the old console name to **Telangana Nethra — Public Health Intelligence Network**, and given a proper entry point so it no longer opens as a wall of tabs:

- **Home.html** — a landing page that states what Nethra is, shows the full cycle, and presents the modules grouped (the full cycle · frontline tools · plan & coordinate · citizen access). Every card deep-links straight into that module in the console.
- **Sitemap.html** — the whole network on one page.

Both pages are **plain static HTML** — they work offline / on `file://`, need no React/Babel/CDN, and you can edit the copy yourself. (The earlier versions of these pages depended on a CDN runtime and broke offline; this does not.) The console deep-links via `index.html#<module>`, so Home → "Aarogya Darpan" opens the doctor tab directly.
