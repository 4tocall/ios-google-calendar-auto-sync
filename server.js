require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const ical = require("node-ical");
const { google } = require("googleapis");
const { createDAVClient } = require("tsdav");

const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "SESSION_SECRET", "ENCRYPTION_KEY"];
for (const k of required) if (!process.env[k]) {
  console.error(`Missing variable in .env: ${k}`);
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY)) {
  console.error("ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.");
  process.exit(1);
}

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
];
const LOCAL_TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
const db = new Database(process.env.DB_PATH || "sync.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sync_state (
    source_uid TEXT PRIMARY KEY, google_event_id TEXT, source_calendar TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, status TEXT NOT NULL,
    message TEXT NOT NULL, created INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, failed INTEGER DEFAULT 0
  );
`);
// Additive migrations: databases created by v2 remain compatible.
const addColumn = (table, col, type) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
};
addColumn("sync_state", "source_url", "TEXT");
addColumn("sync_state", "target_calendar", "TEXT");
addColumn("sync_state", "content_hash", "TEXT");
addColumn("sync_state", "event_start", "TEXT");
addColumn("sync_log", "updated", "INTEGER DEFAULT 0");
addColumn("sync_log", "deleted", "INTEGER DEFAULT 0");
addColumn("sync_log", "duration_ms", "INTEGER DEFAULT 0");

const KEY = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
function decrypt(value) {
  const buf = Buffer.from(value, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8"));
}
function put(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, encrypt(value));
}
function get(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  if (!row) return null;
  try { return decrypt(row.value); }
  catch {
    // Value encrypted with another ENCRYPTION_KEY: drop it so the user reconnects.
    console.warn(`Setting "${key}" cannot be decrypted with the current key: removed, reconnection required.`);
    db.prepare("DELETE FROM settings WHERE key=?").run(key);
    return null;
  }
}
function del(key) { db.prepare("DELETE FROM settings WHERE key=?").run(key); }
function log(status, message, s = {}) {
  db.prepare(`INSERT INTO sync_log(at,status,message,created,updated,deleted,skipped,failed,duration_ms)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(new Date().toISOString(), status, message, s.created || 0, s.updated || 0, s.deleted || 0,
      s.skipped || 0, s.failed || 0, s.durationMs || 0);
}

const DEFAULT_OPTIONS = {
  intervalMinutes: Math.max(5, Math.min(240, Number(process.env.SYNC_EVERY_MINUTES || 15))),
  autoSync: true,
  pastDays: 30,
  futureDays: 365,
  propagateUpdates: true,
  propagateDeletions: false
};
const getOptions = () => ({ ...DEFAULT_OPTIONS, ...(get("options") || {}) });
// mappings: [{ sourceUrl, sourceName, sourceColor, targetId, enabled }]
const getMappings = () => get("mappings") || [];

// ---------------------------------------------------------------------------
// External clients
// ---------------------------------------------------------------------------
function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}
function getGoogleClient() {
  const tokens = get("google_tokens");
  if (!tokens) throw new Error("Connect your Google account before syncing.");
  const client = oauthClient();
  client.setCredentials(tokens);
  client.on("tokens", fresh => put("google_tokens", { ...get("google_tokens"), ...fresh }));
  return client;
}
async function appleClient() {
  const creds = get("apple_credentials");
  if (!creds) throw new Error("Set up the Apple / iCloud account first.");
  return createDAVClient({
    serverUrl: "https://caldav.icloud.com",
    credentials: { username: creds.appleId, password: creds.appPassword },
    authMethod: "Basic",
    defaultAccountType: "caldav"
  });
}
const isEventCalendar = c => !c.components || c.components.includes("VEVENT");
const appleColor = c => (typeof c.calendarColor === "string" ? c.calendarColor.slice(0, 7) : null);

async function listAppleCalendars() {
  const client = await appleClient();
  const cals = await client.fetchCalendars();
  return cals.filter(isEventCalendar).map(c => ({
    url: c.url, name: c.displayName || "Apple calendar", color: appleColor(c)
  }));
}
// Refresh token revoked or expired (after 7 days while the OAuth app is in "Testing" mode).
const isExpiredGrant = e => e?.message === "invalid_grant" || e?.response?.data?.error === "invalid_grant";
function expiredGrantError() {
  const err = new Error("The Google connection has expired. Reconnect your Google account.");
  err.reauth = true;
  return err;
}
async function listGoogleCalendars() {
  const cal = google.calendar({ version: "v3", auth: getGoogleClient() });
  try {
    const { data } = await cal.calendarList.list({ minAccessRole: "writer", maxResults: 250 });
    return (data.items || []).map(c => ({
      id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor, primary: Boolean(c.primary)
    })).sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
  } catch (e) {
    if (isExpiredGrant(e)) throw expiredGrantError();
    if ([401, 403].includes(e.code)) {
      const err = new Error("Access to the Google calendar list was denied. Reconnect your Google account to grant the new permission.");
      err.reauth = true;
      throw err;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
  next();
});
app.use(express.static("public"));
app.use(session({
  name: "iosgoogle.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
// Simple CSRF protection: a third-party form cannot set this header.
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && req.get("X-Requested-With") !== "fetch") {
    return res.status(403).json({ error: "Request refused." });
  }
  next();
});
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  if (isExpiredGrant(e)) e = expiredGrantError();
  console.error(req.path, e.message);
  res.status(e.status || 400).json({ error: e.message || "Unexpected error.", reauth: Boolean(e.reauth) });
});

app.get("/auth/google", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  res.redirect(oauthClient().generateAuthUrl({
    access_type: "offline", prompt: "consent", include_granted_scopes: true, state, scope: GOOGLE_SCOPES
  }));
});
app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.oauthState) throw new Error("Invalid OAuth state.");
    const { tokens } = await oauthClient().getToken(String(req.query.code));
    put("google_tokens", { ...(get("google_tokens") || {}), ...tokens });
    delete req.session.oauthState;
    res.redirect("/?google=connected");
  } catch (e) {
    console.error("OAuth callback:", e.message);
    res.redirect("/?error=google");
  }
});

app.get("/api/status", wrap(async (req, res) => {
  const apple = get("apple_credentials");
  const history = db.prepare(`SELECT at,status,message,created,updated,deleted,skipped,failed,duration_ms
    FROM sync_log ORDER BY id DESC LIMIT 12`).all();
  const tracked = db.prepare("SELECT COUNT(*) n FROM sync_state").get().n;
  res.json({
    appleConnected: Boolean(apple),
    appleId: apple ? apple.appleId.replace(/^(.{2}).*(@.*)$/, "$1•••$2") : null,
    googleConnected: Boolean(get("google_tokens")),
    running,
    nextRunAt: nextRunAt(),
    tracked,
    options: getOptions(),
    mappings: getMappings(),
    history
  });
}));

// Apple: app-specific password, never the main account password.
app.post("/api/apple", wrap(async (req, res) => {
  const { appleId, appPassword } = req.body || {};
  if (typeof appleId !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(appleId.trim())) {
    throw new Error("Enter your Apple Account email address.");
  }
  if (typeof appPassword !== "string" || appPassword.replace(/[\s-]/g, "").length < 16) {
    throw new Error("Enter an app-specific password (format xxxx-xxxx-xxxx-xxxx).");
  }
  const previous = get("apple_credentials");
  put("apple_credentials", { appleId: appleId.trim(), appPassword: appPassword.trim() });
  try {
    const calendars = await listAppleCalendars();
    res.json({ ok: true, calendars });
  } catch {
    if (previous) put("apple_credentials", previous); else del("apple_credentials");
    throw new Error("Could not connect to iCloud. Check your Apple ID, the app-specific password, and that Calendar is enabled in iCloud.");
  }
}));
app.delete("/api/apple", (req, res) => { del("apple_credentials"); res.json({ ok: true }); });
app.delete("/api/google", async (req, res) => {
  const tokens = get("google_tokens");
  if (tokens) await oauthClient().revokeToken(tokens.refresh_token || tokens.access_token).catch(() => {});
  del("google_tokens");
  res.json({ ok: true });
});

app.get("/api/calendars", wrap(async (req, res) => {
  const [apple, googleCals] = await Promise.allSettled([listAppleCalendars(), listGoogleCalendars()]);
  res.json({
    apple: apple.status === "fulfilled" ? apple.value : [],
    appleError: apple.status === "rejected" ? apple.reason.message : null,
    google: googleCals.status === "fulfilled" ? googleCals.value : [],
    googleError: googleCals.status === "rejected" ? googleCals.reason.message : null,
    googleReauth: googleCals.status === "rejected" && Boolean(googleCals.reason.reauth)
  });
}));

app.put("/api/mappings", wrap(async (req, res) => {
  const list = Array.isArray(req.body?.mappings) ? req.body.mappings : null;
  if (!list || list.length > 100) throw new Error("Invalid calendar list.");
  const clean = list.map(m => ({
    sourceUrl: String(m.sourceUrl || ""),
    sourceName: String(m.sourceName || "").slice(0, 200),
    sourceColor: /^#[0-9a-f]{6}$/i.test(m.sourceColor || "") ? m.sourceColor : null,
    targetId: String(m.targetId || "primary").slice(0, 300),
    enabled: Boolean(m.enabled)
  })).filter(m => m.sourceUrl.startsWith("https://"));
  put("mappings", clean);
  res.json({ ok: true, mappings: clean });
}));

app.put("/api/options", wrap(async (req, res) => {
  const b = req.body || {};
  const int = (v, min, max, d) => Number.isFinite(+v) ? Math.max(min, Math.min(max, Math.round(+v))) : d;
  const cur = getOptions();
  const next = {
    intervalMinutes: int(b.intervalMinutes, 5, 240, cur.intervalMinutes),
    autoSync: b.autoSync === undefined ? cur.autoSync : Boolean(b.autoSync),
    pastDays: int(b.pastDays, 0, 3650, cur.pastDays),
    futureDays: int(b.futureDays, 1, 3650, cur.futureDays),
    propagateUpdates: b.propagateUpdates === undefined ? cur.propagateUpdates : Boolean(b.propagateUpdates),
    propagateDeletions: b.propagateDeletions === undefined ? cur.propagateDeletions : Boolean(b.propagateDeletions)
  };
  put("options", next);
  res.json({ ok: true, options: next });
}));

app.post("/api/sync", wrap(async (req, res) => res.json(await runSync())));

// ---------------------------------------------------------------------------
// Duplicates: only events created by the sync (iosSyncSourceUid) are affected.
// For each iCloud event, keep the copy tracked in the database and delete the others.
// ---------------------------------------------------------------------------
async function findDuplicates() {
  const gcal = google.calendar({ version: "v3", auth: getGoogleClient() });
  const calendars = await listGoogleCalendars();
  const tracked = new Map(db.prepare("SELECT source_uid, google_event_id FROM sync_state").all()
    .map(r => [r.source_uid, r.google_event_id]));

  const bySource = new Map();
  let scanned = 0;
  for (const c of calendars) {
    let pageToken;
    do {
      const { data } = await gcal.events.list({
        calendarId: c.id, maxResults: 2500, pageToken, showDeleted: false,
        fields: "nextPageToken,items(id,summary,start,updated,extendedProperties/private/iosSyncSourceUid)"
      });
      for (const e of data.items || []) {
        const uid = e.extendedProperties?.private?.iosSyncSourceUid;
        if (!uid) continue;
        scanned++;
        const copy = { id: e.id, calendarId: c.id, calendarName: c.name, summary: e.summary || "(Untitled)",
          start: e.start?.dateTime || e.start?.date || null, updated: e.updated };
        bySource.set(uid, [...(bySource.get(uid) || []), copy]);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  const toDelete = [];
  for (const [uid, copies] of bySource) {
    if (copies.length < 2) continue;
    const keep = copies.find(c => c.id === tracked.get(uid))
      || copies.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0];
    for (const c of copies) if (c !== keep) toDelete.push({ ...c, keptIn: keep.calendarName });
  }
  toDelete.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { gcal, scanned, toDelete };
}

app.get("/api/duplicates", wrap(async (req, res) => {
  const { scanned, toDelete } = await findDuplicates();
  res.json({ scanned, count: toDelete.length, items: toDelete.slice(0, 200).map(({ id, calendarId, ...rest }) => rest) });
}));

app.post("/api/duplicates/clean", wrap(async (req, res) => {
  if (running) { const e = new Error("A sync is in progress, try again in a moment."); e.status = 409; throw e; }
  running = true;
  const t0 = Date.now();
  let deleted = 0, failed = 0;
  try {
    // Recompute the list at deletion time so nothing relies on a stale preview.
    const { gcal, toDelete } = await findDuplicates();
    for (const d of toDelete) {
      try {
        await gcal.events.delete({ calendarId: d.calendarId, eventId: d.id });
        deleted++;
      } catch (err) {
        if ([404, 410].includes(err.code)) { deleted++; continue; }
        if (isExpiredGrant(err)) throw err;
        failed++;
        console.error("Failed to delete duplicate:", err.message);
      }
    }
    log(failed ? "partial" : "success", `Duplicate cleanup: ${deleted} copy(ies) deleted.`,
      { deleted, failed, durationMs: Date.now() - t0 });
    res.json({ ok: true, deleted, failed });
  } finally {
    running = false;
  }
}));

// ---------------------------------------------------------------------------
// iCalendar → Google conversion
// ---------------------------------------------------------------------------
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const icsUtc = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function toGoogleEvent(e, sourceUid) {
  const start = e.start instanceof Date ? e.start : new Date(e.start);
  let end = e.end ? (e.end instanceof Date ? e.end : new Date(e.end)) : null;
  const allDay = e.datetype === "date";
  if (!end || end <= start) end = new Date(start.getTime() + (allDay ? 86400000 : 3600000));
  const tz = typeof e.start?.tz === "string" && !e.start.tz.startsWith("Etc/Unknown") ? e.start.tz : LOCAL_TZ;

  const event = {
    summary: String(e.summary || "(Untitled)"),
    description: e.description ? String(e.description) : undefined,
    location: e.location ? String(e.location) : undefined,
    transparency: e.transparency === "TRANSPARENT" ? "transparent" : undefined,
    extendedProperties: { private: { iosSyncSourceUid: sourceUid } }
  };
  if (allDay) {
    // node-ical creates all-day dates at local midnight: keep the local components.
    event.start = { date: ymd(start) };
    event.end = { date: ymd(end) };
  } else {
    event.start = { dateTime: start.toISOString(), timeZone: tz };
    event.end = { dateTime: end.toISOString(), timeZone: tz };
  }
  if (e.rrule) {
    // Google only accepts RRULE/EXDATE lines (not DTSTART).
    const rule = e.rrule.toString().split("\n").find(l => l.startsWith("RRULE:"));
    if (rule) {
      event.recurrence = [rule];
      const ex = Object.values(e.exdate || {}).filter(d => d instanceof Date);
      if (ex.length) {
        event.recurrence.push(allDay
          ? `EXDATE;VALUE=DATE:${ex.map(d => ymd(d).replace(/-/g, "")).join(",")}`
          : `EXDATE:${ex.map(icsUtc).join(",")}`);
      }
    }
  }
  return { event, start };
}
const signature = (summary, start) => {
  const when = start?.dateTime ? new Date(start.dateTime).getTime() : start?.date?.slice(0, 10);
  return `${String(summary || "").trim().toLowerCase()}|${when}`;
};

async function indexGoogleEvents(gcal, calendarId, from, to) {
  const byUid = new Map(), bySig = new Map(), claimed = new Set();
  let pageToken;
  do {
    const { data } = await gcal.events.list({
      calendarId, pageToken, maxResults: 2500, showDeleted: false, singleEvents: false,
      timeMin: new Date(from.getTime() - 86400000).toISOString(),
      timeMax: new Date(to.getTime() + 86400000).toISOString(),
      fields: "nextPageToken,items(id,summary,start,extendedProperties/private/iosSyncSourceUid)"
    });
    for (const e of data.items || []) {
      const uid = e.extendedProperties?.private?.iosSyncSourceUid;
      if (uid && !byUid.has(uid)) byUid.set(uid, e);
      const sig = signature(e.summary, e.start);
      if (!bySig.has(sig)) bySig.set(sig, e);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return {
    find(uid, event) {
      const hit = byUid.get(uid) || bySig.get(signature(event.summary, event.start));
      if (!hit || claimed.has(hit.id)) return null;
      claimed.add(hit.id);
      return hit;
    },
    claim(id) { claimed.add(id); }
  };
}
const hashOf = obj => crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
let running = false;
let lastRunAt = 0;
function nextRunAt() {
  const o = getOptions();
  if (!o.autoSync) return null;
  const base = lastRunAt || Date.now();
  return new Date(Math.max(Date.now(), base + o.intervalMinutes * 60000)).toISOString();
}

async function runSync() {
  if (running) { const e = new Error("A sync is already in progress."); e.status = 409; throw e; }
  running = true;
  lastRunAt = Date.now();
  const t0 = Date.now();
  const s = { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 };
  try {
    const mappings = getMappings().filter(m => m.enabled);
    if (!mappings.length) throw new Error("No calendar selected. Choose at least one iCloud calendar to sync.");
    const opts = getOptions();
    const gcal = google.calendar({ version: "v3", auth: getGoogleClient() });
    const client = await appleClient();
    const remote = await client.fetchCalendars();

    const from = new Date(Date.now() - opts.pastDays * 86400000);
    const to = new Date(Date.now() + opts.futureDays * 86400000);
    const selectState = db.prepare("SELECT * FROM sync_state WHERE source_uid=?");
    const upsert = db.prepare(`INSERT INTO sync_state(source_uid,google_event_id,source_calendar,source_url,target_calendar,content_hash,event_start,updated_at)
      VALUES(@uid,@gid,@name,@url,@target,@hash,@start,@now)
      ON CONFLICT(source_uid) DO UPDATE SET google_event_id=@gid, source_calendar=@name, source_url=@url,
        target_calendar=@target, content_hash=@hash, event_start=@start, updated_at=@now`);

    for (const m of mappings) {
      const calendar = remote.find(c => c.url === m.sourceUrl);
      if (!calendar) { s.failed++; console.error(`Calendar not found: ${m.sourceName}`); continue; }
      let objects;
      try {
        objects = await client.fetchCalendarObjects({
          calendar, timeRange: { start: from.toISOString(), end: to.toISOString() }, expand: false
        });
      } catch (e) { s.failed++; console.error(`Could not read ${m.sourceName}:`, e.message); continue; }

      // Index the events already in the target calendar so a duplicate is never created.
      const existing = await indexGoogleEvents(gcal, m.targetId, from, to);
      const seen = new Set();
      for (const obj of objects || []) {
        if (!obj.data) continue;
        let parsed;
        try { parsed = ical.sync.parseICS(obj.data); } catch { s.failed++; continue; }
        // One object = one master event (RECURRENCE-ID exceptions are skipped here).
        const events = Object.values(parsed).filter(e => e && e.type === "VEVENT" && e.uid && e.start && !e.recurrenceid);
        for (const e of events) {
          // The calendar URL is part of the key: two calendars can reuse a UID.
          const uid = crypto.createHash("sha256").update(`${calendar.url}|${e.uid}`).digest("hex");
          seen.add(uid);
          try {
            const { event, start } = toGoogleEvent(e, uid);
            const hash = hashOf({ event, target: m.targetId });
            const prior = selectState.get(uid);
            if (prior?.google_event_id) existing.claim(prior.google_event_id);
            const row = { uid, name: m.sourceName, url: calendar.url, target: m.targetId, hash, start: start.toISOString(), now: new Date().toISOString() };

            if (prior && prior.content_hash === hash) { s.skipped++; continue; }
            if (prior && !opts.propagateUpdates) { s.skipped++; continue; }

            const priorTarget = prior?.target_calendar || "primary";
            if (prior && prior.google_event_id && priorTarget === m.targetId) {
              try {
                await gcal.events.update({ calendarId: m.targetId, eventId: prior.google_event_id, requestBody: event });
                upsert.run({ ...row, gid: prior.google_event_id });
                s.updated++;
                continue;
              } catch (err) {
                if (![404, 410].includes(err.code)) throw err; // deleted in Google → recreate it
              }
            } else if (prior && prior.google_event_id) {
              // The target calendar changed: move the event.
              await gcal.events.delete({ calendarId: priorTarget, eventId: prior.google_event_id }).catch(() => {});
            }
            // Already in Google (same marker, or same title at the same time): adopt it.
            const match = existing.find(uid, event);
            if (match) {
              await gcal.events.update({ calendarId: m.targetId, eventId: match.id, requestBody: event });
              upsert.run({ ...row, gid: match.id });
              s.updated++;
              continue;
            }
            const inserted = await gcal.events.insert({ calendarId: m.targetId, requestBody: event });
            existing.claim(inserted.data.id);
            upsert.run({ ...row, gid: inserted.data.id });
            prior ? s.updated++ : s.created++;
          } catch (err) {
            if (isExpiredGrant(err)) throw err;
            s.failed++;
            console.error(`Failed "${e.summary}":`, err.message);
          }
        }
      }

      if (opts.propagateDeletions) {
        // Only events inside the fetched window can be considered deleted.
        const rows = db.prepare(`SELECT * FROM sync_state WHERE source_url=? AND event_start BETWEEN ? AND ?`)
          .all(calendar.url, from.toISOString(), to.toISOString());
        for (const r of rows) {
          if (seen.has(r.source_uid)) continue;
          try {
            await gcal.events.delete({ calendarId: r.target_calendar || "primary", eventId: r.google_event_id })
              .catch(err => { if (![404, 410].includes(err.code)) throw err; });
            db.prepare("DELETE FROM sync_state WHERE source_uid=?").run(r.source_uid);
            s.deleted++;
          } catch (err) { s.failed++; console.error("Failed to delete:", err.message); }
        }
      }
    }
    s.durationMs = Date.now() - t0;
    const message = `${mappings.length} calendar(s) synced.`;
    log(s.failed ? "partial" : "success", message, s);
    return { ok: true, calendars: mappings.length, ...s };
  } catch (err) {
    const e = isExpiredGrant(err) ? expiredGrantError() : err;
    s.durationMs = Date.now() - t0;
    log("error", e.message, { ...s, failed: s.failed + 1 });
    throw e;
  } finally {
    running = false;
  }
}

// Check every minute whether the interval chosen in the UI has elapsed.
cron.schedule("* * * * *", async () => {
  const o = getOptions();
  if (!o.autoSync || running) return;
  if (Date.now() - lastRunAt < o.intervalMinutes * 60000) return;
  if (!get("apple_credentials") || !get("google_tokens") || !getMappings().some(m => m.enabled)) return;
  try { await runSync(); }
  catch (e) { console.error("Automatic sync failed:", e.message); }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`CalSync iCloud → Google Calendar: ${process.env.BASE_URL || `http://localhost:${port}`}`);
});
