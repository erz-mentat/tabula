/* ================= Tagwerk-Speicher: privates GitHub-Repository statt Google Kalender =================
   Tagwerk spricht weiter dieselben Werkzeuge wie früher (list_events, create_event, update_event,
   delete_event, ein db.doc mit onSnapshot/get/set). Dahinter liegen jetzt JSON-Dateien im Ordner
   tagwerk/ des privaten Repositorys, dasselbe, das Tabula nutzt:
     tagwerk/state.json, plan.json, weather.json   Zustand, Tagesplan, Wetter
     tagwerk/termine/JJJJ-MM.json                  Einzeltermine nach Monat des Beginns
     tagwerk/serien.json                           wiederkehrende Termine mit Ausnahmen
   Schlüssel und Repository teilt sich Tagwerk mit Tabula (gleiche Herkunft, localStorage „tabula.sync“). */
const TW = (() => {
  const API = window.__TAGWERK_API__ || "https://api.github.com";
  const ROOT = "tagwerk/";
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
  const fail = (code, message) => { const e = new Error(message || code); e.code = code; return e; };
  const pad = n => String(n).padStart(2, "0");

  function cfg() {
    const own = lsGet("tagwerk.sync", null);
    if (own && own.repo && own.token) return own;
    const tab = lsGet("tabula.sync", null);
    if (tab && tab.repo && tab.token) return { repo: tab.repo, token: tab.token, shared: true };
    return null;
  }
  function setCfg(repo, token) { lsSet("tagwerk.sync", { repo: String(repo).trim(), token: String(token).trim() }); }
  function clearCfg() { try { localStorage.removeItem("tagwerk.sync"); } catch (e) {} }

  /* ---- Base64 mit UTF-8 ---- */
  function dec(b64) { const bin = atob(String(b64).replace(/\s/g, "")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); }
  function enc(str) { const u = new TextEncoder().encode(str); let bin = ""; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(bin); }

  /* ---- GitHub ---- */
  async function gh(path, opts = {}) {
    const c = cfg();
    if (!c) throw fail("no_sync", "Tagwerk ist noch nicht mit deinem Repository verbunden.");
    const headers = { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    if (opts.accept) headers.Accept = opts.accept;
    if (opts.body) headers["Content-Type"] = "application/json";
    const url = `${API}/repos/${c.repo}/contents/${path}` + (opts.method ? "" : "?ref=main");
    try { return await fetch(url, { method: opts.method || "GET", headers, body: opts.body, cache: "no-store" }); }
    catch (e) { throw fail("offline", "Keine Verbindung zu GitHub."); }
  }
  async function httpErr(r) {
    let msg = ""; try { msg = (await r.json()).message || ""; } catch (e) {}
    if (r.status === 401) return fail("auth", "Der GitHub-Schlüssel ist ungültig oder abgelaufen.");
    if (r.status === 403 && /rate limit/i.test(msg)) return fail("rate", "GitHub bremst gerade, gleich noch einmal.");
    if (r.status === 403) return fail("forbidden", "Der GitHub-Schlüssel darf in diesem Repository nicht schreiben.");
    if (r.status === 404) return fail("not_found", "Repository nicht gefunden.");
    return fail("tool_error", `GitHub antwortet mit ${r.status}${msg ? ": " + msg : ""}`);
  }

  /* ---- Dateien mit Zwischenspeicher ---- */
  const files = {};          // Pfad → { sha, data, etag, fresh }
  const inflight = {};       // Pfad → laufende oder anstehende Schreibvorgänge
  function fileOf(path) {
    if (!files[path]) { const c = lsGet("tagwerk.f." + path, null); files[path] = c ? { sha: c.sha, data: c.data, etag: c.etag, fresh: false, cached: true } : { sha: null, data: undefined, etag: null, fresh: false }; }
    return files[path];
  }
  function keep(path) { const f = files[path]; lsSet("tagwerk.f." + path, { sha: f.sha, data: f.data, etag: f.etag }); }
  async function fetchFile(path, force) {
    const f = fileOf(path);
    let r;
    try { r = await gh(ROOT + path, { etag: force ? null : f.etag }); }
    catch (e) { if (e.code === "offline" && f.data !== undefined) { TW.offline = true; return f; } throw e; }
    TW.offline = false;
    if (r.status === 304) { f.fresh = true; return f; }
    if (r.status === 404) { Object.assign(f, { sha: null, data: null, etag: null, fresh: true }); keep(path); return f; }
    if (!r.ok) throw await httpErr(r);
    const j = await r.json();
    let data = null;
    try { data = JSON.parse(dec(j.content || "")); } catch (e) { throw fail("tool_error", `${path} ist beschädigt.`); }
    Object.assign(f, { sha: j.sha, data, etag: r.headers.get("ETag"), fresh: true });
    keep(path);
    return f;
  }
  async function writeFile(path, mutate) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const f = (attempt === 0 && fileOf(path).fresh) ? fileOf(path) : await fetchFile(path, true);
      const next = mutate(clone(f.data));
      if (next === undefined) return f.data;
      const body = { message: `Tagwerk: ${path}`, content: enc(JSON.stringify(next, null, 1) + "\n"), branch: "main" };
      if (f.sha) body.sha = f.sha;
      const r = await gh(ROOT + path, { method: "PUT", body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) { f.fresh = false; await sleep(250 + attempt * 450); continue; }
      if (!r.ok) throw await httpErr(r);
      const j = await r.json();
      Object.assign(f, { sha: j.content && j.content.sha, data: next, etag: null, fresh: true });
      keep(path);
      return next;
    }
    throw fail("conflict", "Ein anderes Gerät hat gleichzeitig geändert. Lade neu und versuch es noch einmal.");
  }
  /* Änderungen sammeln: alle Änderungen an einer Datei innerhalb von 150 ms werden ein Commit. */
  const pend = {}; let chain = Promise.resolve(), flushTimer = null;
  function mutateFile(path, fn) {
    inflight[path] = (inflight[path] || 0) + 1;
    return new Promise((res, rej) => {
      (pend[path] = pend[path] || []).push({ fn, res, rej });
      clearTimeout(flushTimer); flushTimer = setTimeout(flush, 150);
    });
  }
  function flush() {
    const batch = Object.entries(pend);
    for (const k of Object.keys(pend)) delete pend[k];
    chain = chain.then(async () => {
      for (const [path, ops] of batch) {
        try {
          await writeFile(path, data => {
            let d = data, changed = false;
            for (const op of ops) { const out = op.fn(d); if (out !== undefined) { d = out; changed = true; } }
            return changed ? d : undefined;
          });
          ops.forEach(o => o.res());
        } catch (e) { ops.forEach(o => o.rej(e)); }
        finally { inflight[path] = Math.max(0, (inflight[path] || 0) - ops.length); }
      }
    });
  }
  const busy = path => (inflight[path] || 0) > 0;

  /* ---- Zeit ---- */
  const ymdOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function offStr(d) { const o = -d.getTimezoneOffset(), s = o >= 0 ? "+" : "-", a = Math.abs(o); return `${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`; }
  function localDate(s) {      // „JJJJ-MM-TTTHH:MM:SS“ ohne Zone = Ortszeit; mit Zone wird umgerechnet
    s = String(s);
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
    const [d, t = "00:00:00"] = s.split("T"); const [y, m, dd] = d.split("-").map(Number); const [h, mi, se] = t.split(":").map(Number);
    return new Date(y, m - 1, dd, h || 0, mi || 0, se || 0);
  }
  const stamp = d => `${ymdOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offStr(d)}`;
  const startOf = ev => ev.start.dateTime ? new Date(ev.start.dateTime) : localDate(ev.start.date);
  const endOf = ev => ev.end ? (ev.end.dateTime ? new Date(ev.end.dateTime) : localDate(ev.end.date)) : startOf(ev);
  const monthKeyOf = ev => (ev.start.dateTime || ev.start.date).slice(0, 7);
  function monthsBetween(a, b) {
    const out = []; const d = new Date(a.getFullYear(), a.getMonth(), 1);
    while (d < b) { out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); d.setMonth(d.getMonth() + 1); }
    return out;
  }
  const newId = () => { const a = "abcdefghijklmnopqrstuv0123456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(26)); for (const x of r) s += a[x % 32]; return s; };

  /* ---- Serien ---- */
  function parseRule(rec) {
    const line = (rec || []).find(l => /^RRULE:/.test(l)); if (!line) return null;
    const R = {}; for (const kv of line.slice(6).split(";")) { const [k, v] = kv.split("="); R[k] = v; }
    return { freq: R.FREQ, interval: Math.max(1, +R.INTERVAL || 1), count: R.COUNT ? +R.COUNT : null, byday: R.BYDAY ? R.BYDAY.split(",") : null,
      until: R.UNTIL ? (/^\d{8}$/.test(R.UNTIL) ? localDate(`${R.UNTIL.slice(0, 4)}-${R.UNTIL.slice(4, 6)}-${R.UNTIL.slice(6, 8)}T23:59:59`) : new Date(R.UNTIL.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"))) : null };
  }
  const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  function instKey(ev, start) {
    if (ev.start.date) return `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
    return start.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }
  function expand(ser, from, to) {
    const rule = parseRule(ser.recurrence); const s0 = startOf(ser), dur = endOf(ser) - s0;
    const out = []; if (!rule) return out;
    const ex = new Set(ser.exdates || []), ov = ser.overrides || {};
    let n = 0, guard = 0;
    const emit = st => {
      n++;
      const key = instKey(ser, st), id = `${ser.id}_${key}`;
      if (ex.has(key)) return;
      const en = new Date(st.getTime() + dur);
      let inst = { ...clone(ser), id, recurringEventId: ser.id, originalStartTime: ser.start.date ? { date: ymdOf(st) } : { dateTime: stamp(st) } };
      delete inst.recurrence; delete inst.exdates; delete inst.overrides;
      inst.start = ser.start.date ? { date: ymdOf(st) } : { dateTime: stamp(st) };
      inst.end = ser.start.date ? { date: ymdOf(en) } : { dateTime: stamp(en) };
      if (ov[key]) inst = { ...inst, ...clone(ov[key]), id, recurringEventId: ser.id };
      if (endOf(inst) > from && startOf(inst) < to) out.push(inst);
    };
    const cur = new Date(s0);
    while (guard++ < 5000) {
      if (rule.until && cur > rule.until) break;
      if (rule.count && n >= rule.count) break;
      if (cur - to > 2 * 864e5) break;   // Abweichungen dürfen ein Vorkommen höchstens zwei Tage verschieben
      if (rule.freq === "WEEKLY" && rule.byday) {
        // Woche ab cur (Montag der Startwoche), jeden genannten Tag
        const mon = new Date(cur); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
        for (let k = 0; k < 7; k++) {
          const d = new Date(mon); d.setDate(mon.getDate() + k);
          if (!rule.byday.includes(DAYS[d.getDay()]) || d < s0) continue;
          if (rule.until && d > rule.until) break;
          if (rule.count && n >= rule.count) break;
          emit(d);
        }
        cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7) + 7 * rule.interval);
        cur.setHours(s0.getHours(), s0.getMinutes(), s0.getSeconds());
        continue;
      }
      emit(new Date(cur));
      if (rule.freq === "DAILY") cur.setDate(cur.getDate() + rule.interval);
      else if (rule.freq === "WEEKLY") cur.setDate(cur.getDate() + 7 * rule.interval);
      else if (rule.freq === "MONTHLY") cur.setMonth(cur.getMonth() + rule.interval);
      else if (rule.freq === "YEARLY") cur.setFullYear(cur.getFullYear() + rule.interval);
      else break;
    }
    return out;
  }

  /* ---- Feiertage in Hessen (statt Google-Feiertagskalender) ---- */
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
      h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, mo - 1, da);
  }
  function holidays(from, to) {
    const out = [];
    for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
      const E = easter(y), rel = n => { const d = new Date(E); d.setDate(d.getDate() + n); return d; };
      const list = [[new Date(y, 0, 1), "Neujahr"], [rel(-2), "Karfreitag"], [rel(1), "Ostermontag"], [new Date(y, 4, 1), "Tag der Arbeit"],
        [rel(39), "Christi Himmelfahrt"], [rel(50), "Pfingstmontag"], [rel(60), "Fronleichnam"], [new Date(y, 9, 3), "Tag der Deutschen Einheit"],
        [new Date(y, 11, 25), "1. Weihnachtstag"], [new Date(y, 11, 26), "2. Weihnachtstag"]];
      for (const [d, name] of list) {
        if (d < from || d >= to) continue;
        const nx = new Date(d); nx.setDate(d.getDate() + 1);
        out.push({ id: "fei" + ymdOf(d), summary: name, start: { date: ymdOf(d) }, end: { date: ymdOf(nx) }, description: "Gesetzlicher Feiertag (Hessen)" });
      }
    }
    return out;
  }

  /* ---- Kalenderwerkzeuge ---- */
  const MPATH = m => `termine/${m}.json`;
  const SPATH = "serien.json";
  const idMonth = {};   // Termin-ID → Monat, aus geladenen Dateien
  function index(m, data) { for (const id of Object.keys((data && data.events) || {})) idMonth[id] = m; }
  async function monthData(m) { const f = await fetchFile(MPATH(m)); index(m, f.data); return (f.data && f.data.events) || {}; }
  async function seriesData() { const f = await fetchFile(SPATH); return (f.data && f.data.events) || {}; }
  async function locate(id) {
    const base = String(id).split("_")[0];
    const ser = await seriesData();
    if (ser[id]) return { kind: "series", id };
    if (id.includes("_") && ser[base]) return { kind: "instance", id: base, key: id.slice(base.length + 1) };
    if (idMonth[id]) return { kind: "single", month: idMonth[id] };
    // Unbekannt: alle Monatsdateien durchgehen
    const r = await gh(ROOT + "termine");
    if (r.ok) {
      const list = await r.json();
      for (const e of list) { const m = /^(\d{4}-\d{2})\.json$/.exec(e.name); if (!m) continue; const ev = await monthData(m[1]); if (ev[id]) return { kind: "single", month: m[1] }; }
    }
    throw fail("tool_error", "Termin nicht gefunden.");
  }
  function fromInput(input, base) {
    const ev = base ? clone(base) : { id: newId(), eventType: "DEFAULT", created: new Date().toISOString() };
    if (input.summary !== undefined) ev.summary = String(input.summary);
    if (input.description !== undefined) ev.description = String(input.description);
    if (input.location !== undefined) ev.location = String(input.location);
    if (input.colorId !== undefined) ev.colorId = String(input.colorId);
    if (input.availability) { if (input.availability === "AVAILABILITY_FREE") ev.transparency = "transparent"; else delete ev.transparency; }
    if (input.overrideReminders) ev.reminders = { useDefault: false, overrides: input.overrideReminders };
    if (input.useDefaultReminders === true) ev.reminders = { useDefault: true };
    if (input.useDefaultReminders === false && !input.overrideReminders) ev.reminders = { useDefault: false, overrides: [] };
    const allDay = input.allDay !== undefined ? !!input.allDay : !!(base && base.start && base.start.date && !input.startTime);
    if (input.startTime || input.endTime) {
      const oldDur = base ? endOf(base) - startOf(base) : 3600e3;
      const s = input.startTime ? localDate(input.startTime) : startOf(base);
      const e = input.endTime ? localDate(input.endTime) : new Date(s.getTime() + oldDur);
      if (allDay) { ev.start = { date: ymdOf(s) }; const ee = e > s ? e : new Date(s.getTime() + 864e5); ev.end = { date: ymdOf(ee) }; }
      else { ev.start = { dateTime: stamp(s) }; ev.end = { dateTime: stamp(e > s ? e : new Date(s.getTime() + 3600e3)) }; }
    }
    if (input.recurrenceData) ev.recurrence = input.recurrenceData.map(String);
    ev.updated = new Date().toISOString();
    ev.status = "confirmed";
    return ev;
  }
  function putSingle(ev) {
    const m = monthKeyOf(ev); idMonth[ev.id] = m;
    return mutateFile(MPATH(m), d => { d = d || { v: 1, events: {} }; d.events = d.events || {}; d.events[ev.id] = ev; return d; });
  }
  function dropSingle(id, m) {
    return mutateFile(MPATH(m), d => { if (!d || !d.events || !d.events[id]) return undefined; delete d.events[id]; return d; });
  }
  const tools = {
    async list_events(input) {
      if (input.calendarId && /holiday/.test(input.calendarId)) return { events: holidays(localDate(input.startTime), localDate(input.endTime)) };
      if (input.pageToken) return { events: [] };
      const from = localDate(input.startTime || stamp(new Date())), to = input.endTime ? localDate(input.endTime) : new Date(from.getTime() + 7 * 864e5);
      const ms = monthsBetween(new Date(from.getFullYear(), from.getMonth() - 1, 1), to);   // Vormonat: Termine, die hineinragen
      const lists = await Promise.all(ms.map(monthData));
      const evs = [];
      for (const l of lists) for (const ev of Object.values(l)) if (endOf(ev) > from && startOf(ev) < to) evs.push(clone(ev));
      for (const s of Object.values(await seriesData())) evs.push(...expand(s, from, to));
      evs.sort((a, b) => startOf(a) - startOf(b));
      return { events: evs };
    },
    async get_event(input) {
      const at = await locate(String(input.eventId));
      if (at.kind === "single") return clone((await monthData(at.month))[input.eventId]);
      const s = (await seriesData())[at.id];
      if (at.kind === "series") return clone(s);
      const all = expand(s, new Date(0), new Date(8.64e15)).find(e => e.id === input.eventId);
      return all || null;
    },
    async create_event(input) {
      const ev = fromInput(input);
      if (ev.recurrence) {
        await mutateFile(SPATH, d => { d = d || { v: 1, events: {} }; d.events = d.events || {}; d.events[ev.id] = ev; return d; });
      } else await putSingle(ev);
      return clone(ev);
    },
    async update_event(input) {
      const id = String(input.eventId), at = await locate(id);
      if (at.kind === "single") {
        const old = (await monthData(at.month))[id];
        const ev = fromInput(input, old);
        if (monthKeyOf(ev) !== at.month) { await putSingle(ev); await dropSingle(id, at.month); }
        else await putSingle(ev);
        return clone(ev);
      }
      if (at.kind === "series") {
        let out = null;
        await mutateFile(SPATH, d => { if (!d || !d.events[id]) return undefined; d.events[id] = out = fromInput(input, d.events[id]); return d; });
        return clone(out);
      }
      // einzelnes Vorkommen einer Serie: als Abweichung speichern
      const ser = (await seriesData())[at.id];
      const inst = expand(ser, new Date(0), new Date(8.64e15)).find(e => e.id === id) || null;
      const ev = fromInput(input, inst || ser);
      const patch = { summary: ev.summary, description: ev.description, start: ev.start, end: ev.end, colorId: ev.colorId, location: ev.location, reminders: ev.reminders };
      await mutateFile(SPATH, d => { const s = d && d.events[at.id]; if (!s) return undefined; s.overrides = s.overrides || {}; s.overrides[at.key] = patch; return d; });
      return { ...ev, id };
    },
    async delete_event(input) {
      const id = String(input.eventId), at = await locate(id);
      if (at.kind === "single") { await dropSingle(id, at.month); return { ok: true }; }
      if (at.kind === "series") { await mutateFile(SPATH, d => { if (!d || !d.events[id]) return undefined; delete d.events[id]; return d; }); return { ok: true }; }
      await mutateFile(SPATH, d => { const s = d && d.events[at.id]; if (!s) return undefined; s.exdates = [...new Set([...(s.exdates || []), at.key])]; if (s.overrides) delete s.overrides[at.key]; return d; });
      return { ok: true };
    }
  };
  const mcp = { async callTool(server, tool, input) { if (!tools[tool]) throw fail("tool_error", `Unbekanntes Werkzeug ${tool}`); return { payload: await tools[tool](input || {}) }; } };

  /* ---- Dokumente (früher die Artifact-Datenbank) ---- */
  const subs = [];
  const snap = d => ({ exists: d != null, data: () => clone(d), metadata: { hasPendingWrites: false } });
  const docPath = name => String(name).replace(/^tagwerk\//, "") + ".json";
  function doc(name) {
    const path = docPath(name);
    return {
      onSnapshot(cb, errCb) {
        const sub = { path, cb, errCb, sha: undefined }; subs.push(sub);
        const f = fileOf(path);
        if (f.cached && f.data !== undefined) { sub.sha = f.sha; cb(snap(f.data)); }
        fetchFile(path).then(f => { if (sub.sha !== f.sha || !f.cached) { sub.sha = f.sha; f.cached = true; cb(snap(f.data)); } }).catch(e => errCb && errCb(e));
        return () => { const i = subs.indexOf(sub); if (i >= 0) subs.splice(i, 1); };
      },
      async get() { return snap((await fetchFile(path)).data); },
      async set(data) { const c = clone(data); await mutateFile(path, () => c); for (const s of subs) if (s.path === path) s.sha = fileOf(path).sha; }
    };
  }
  async function poll() {
    for (const s of subs) {
      if (busy(s.path)) continue;
      try { const f = await fetchFile(s.path); if (f.sha !== s.sha && !busy(s.path)) { s.sha = f.sha; s.cb(snap(f.data)); } } catch (e) {}
    }
  }
  const db = { doc };

  /* ---- Planungshilfe über Daimonion (nur im Daimonion-Fenster) ---- */
  const sample = (window.daimonion && typeof window.daimonion.sample === "function") ? window.daimonion.sample : null;

  /* Für Daimonion: ein Dokument gezielt ändern und beliebige Dateien des Repositorys lesen (Tabula) */
  function mutateDoc(name, fn) { return mutateFile(docPath(name), fn); }
  async function readDoc(name) { return clone((await fetchFile(docPath(name))).data); }
  async function readRaw(p) {
    const r = await gh(String(p).replace(/^\/+/, ""), { accept: "application/vnd.github.raw+json" });
    if (r.status === 404) return null;
    if (!r.ok) throw await httpErr(r);
    return r.text();
  }
  async function listDir(p) {
    const r = await gh(String(p).replace(/^\/+/, ""));
    if (r.status === 404) return [];
    if (!r.ok) throw await httpErr(r);
    const j = await r.json(); return Array.isArray(j) ? j.map(e => ({ name: e.name, type: e.type, size: e.size })) : [];
  }
  return {
    offline: false, cfg, setCfg, clearCfg, poll, tools, mutateDoc, readDoc, readRaw, listDir,
    use(n) { if (n === "db") return Promise.resolve(cfg() ? db : null); if (n === "mcp") return Promise.resolve(cfg() ? mcp : null); if (n === "sample") return Promise.resolve(sample); return Promise.resolve(null); },
    async test(repo, token) {
      const r = await fetch(`${API}/repos/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, cache: "no-store" }).catch(() => null);
      if (!r) return "Keine Verbindung zu GitHub.";
      if (r.status === 401) return "Der Schlüssel ist ungültig.";
      if (r.status === 404) return "Repository nicht gefunden oder der Schlüssel sieht es nicht.";
      if (!r.ok) return `GitHub antwortet mit ${r.status}.`;
      const j = await r.json(); if (j.permissions && !j.permissions.push) return "Der Schlüssel darf in diesem Repository nicht schreiben.";
      return "";
    }
  };
})();
