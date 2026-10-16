require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const ical = require("node-ical");
const { google } = require("googleapis");
const { createDAVClient } = require("tsdav");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "SESSION_SECRET", "ENCRYPTION_KEY"];
for (const k of required) if (!process.env[k]) {
  console.error(`Variable manquante dans .env : ${k}`);
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY)) {
  console.error("ENCRYPTION_KEY doit contenir exactement 64 caractères hexadécimaux.");
  process.exit(1);
}

const db = new Database("sync.sqlite");
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
  return row ? decrypt(row.value) : null;
}
function log(status, message, stats = {}) {
  db.prepare("INSERT INTO sync_log(at,status,message,created,skipped,failed) VALUES(?,?,?,?,?,?)")
    .run(new Date().toISOString(), status, message, stats.created || 0, stats.skipped || 0, stats.failed || 0);
}
function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}
function getGoogleClient() {
  const tokens = get("google_tokens");
  if (!tokens) throw new Error("Connecte ton compte Google avant de lancer la synchronisation.");
  const client = oauthClient();
  client.setCredentials(tokens);
  client.on("tokens", fresh => put("google_tokens", { ...get("google_tokens"), ...fresh }));
  return client;
}

app.use(session({
  name: "iosgoogle.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));

app.get("/auth/google", (req, res) => {
  const oauth = oauthClient();
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  res.redirect(oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state,
    scope: ["https://www.googleapis.com/auth/calendar.events"]
  }));
});
app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.oauthState) throw new Error("État OAuth invalide.");
    const { tokens } = await oauthClient().getToken(String(req.query.code));
    put("google_tokens", tokens);
    delete req.session.oauthState;
    res.redirect("/?google=connected");
  } catch (e) {
    console.error("OAuth callback:", e.message);
    res.redirect("/?error=google");
  }
});

app.get("/api/status", (req, res) => {
  const apple = get("apple_credentials");
  const tokens = get("google_tokens");
  const last = db.prepare("SELECT at,status,message,created,skipped,failed FROM sync_log ORDER BY id DESC LIMIT 1").get();
  res.json({ appleConnected: Boolean(apple), googleConnected: Boolean(tokens), last });
});

// Apple uses an app-specific password, not the main Apple Account password.
app.post("/api/apple", (req, res) => {
  const { appleId, appPassword } = req.body || {};
  if (typeof appleId !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(appleId.trim())) {
    return res.status(400).json({ error: "Saisis l’adresse e-mail de ton compte Apple." });
  }
  if (typeof appPassword !== "string" || appPassword.trim().length < 8) {
    return res.status(400).json({ error: "Saisis un mot de passe spécifique à l’application Apple." });
  }
  put("apple_credentials", { appleId: appleId.trim(), appPassword: appPassword.trim() });
  res.json({ ok: true });
});

app.post("/api/apple/test", async (req, res) => {
  try {
    const creds = get("apple_credentials");
    if (!creds) return res.status(400).json({ error: "Enregistre d’abord les identifiants iCloud." });
    const client = await createDAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: { username: creds.appleId, password: creds.appPassword },
      authMethod: "Basic",
      defaultAccountType: "caldav"
    });
    const calendars = await client.fetchCalendars();
    res.json({ ok: true, calendars: calendars.map(c => ({ displayName: c.displayName || "Calendrier Apple", url: c.url })) });
  } catch (e) {
    res.status(400).json({ error: "Connexion iCloud impossible. Vérifie l’identifiant Apple, le mot de passe spécifique et l’accès Calendrier iCloud." });
  }
});

let running = false;
async function runSync() {
  if (running) return { message: "Une synchronisation est déjà en cours." };
  running = true;
  let created = 0, skipped = 0, failed = 0;
  try {
    const creds = get("apple_credentials");
    if (!creds) throw new Error("Configure d’abord le compte Apple/iCloud.");
    const auth = getGoogleClient();
    const googleCalendar = google.calendar({ version: "v3", auth });
    const client = await createDAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: { username: creds.appleId, password: creds.appPassword },
      authMethod: "Basic",
      defaultAccountType: "caldav"
    });
    const calendars = await client.fetchCalendars();
    if (!calendars.length) throw new Error("Aucun calendrier iCloud accessible.");

    for (const calendar of calendars) {
      let objects;
      try {
        objects = await client.fetchCalendarObjects({ calendar });
      } catch (e) {
        failed++;
        continue;
      }
      for (const obj of objects || []) {
        if (!obj.data) continue;
        let parsed;
        try { parsed = ical.sync.parseICS(obj.data); }
        catch { failed++; continue; }
        const events = Object.values(parsed).filter(e => e && e.type === "VEVENT" && e.uid && e.start && e.end);
        for (const e of events) {
          try {
            // Include calendar identity because separate calendars can reuse a UID.
            const sourceUid = crypto.createHash("sha256")
              .update(`${calendar.url || calendar.displayName || "calendar"}|${e.uid}`)
              .digest("hex");
            const prior = db.prepare("SELECT google_event_id FROM sync_state WHERE source_uid=?").get(sourceUid);
            if (prior) { skipped++; continue; }

            const startDate = e.start instanceof Date ? e.start : new Date(e.start);
            const endDate = e.end instanceof Date ? e.end : new Date(e.end);
            const isAllDay = e.datetype === "date";
            const event = {
              summary: String(e.summary || "(Sans titre)"),
              description: e.description ? String(e.description) : undefined,
              location: e.location ? String(e.location) : undefined,
              extendedProperties: { private: { iosSyncSourceUid: sourceUid } }
            };
            if (isAllDay) {
              event.start = { date: startDate.toISOString().slice(0, 10) };
              event.end = { date: endDate.toISOString().slice(0, 10) };
            } else {
              event.start = { dateTime: startDate.toISOString() };
              event.end = { dateTime: endDate.toISOString() };
            }
            if (e.rrule) event.recurrence = [e.rrule.toString()];
            const inserted = await googleCalendar.events.insert({ calendarId: "primary", requestBody: event });
            db.prepare(`INSERT OR IGNORE INTO sync_state(source_uid,google_event_id,source_calendar,updated_at)
              VALUES(?,?,?,?)`).run(sourceUid, inserted.data.id, calendar.displayName || calendar.url || "", new Date().toISOString());
            created++;
          } catch (e) {
            failed++;
            console.error("Échec import événement:", e.message);
          }
        }
      }
    }
    const stats = { created, skipped, failed };
    log(failed ? "partial" : "success", `Synchronisation terminée depuis ${calendars.length} calendrier(s) iCloud.`, stats);
    return { ok: true, calendars: calendars.length, ...stats };
  } catch (e) {
    log("error", e.message, { created, skipped, failed: failed + 1 });
    throw e;
  } finally {
    running = false;
  }
}
app.post("/api/sync", async (req, res) => {
  try { res.json(await runSync()); }
  catch (e) { res.status(400).json({ error: e.message || "Synchronisation impossible." }); }
});

const interval = Math.max(5, Math.min(60, Number(process.env.SYNC_EVERY_MINUTES || 15)));
cron.schedule(`*/${interval} * * * *`, async () => {
  if (!get("apple_credentials") || !get("google_tokens")) return;
  try { await runSync(); }
  catch (e) { console.error("Synchronisation automatique échouée:", e.message); }
});

app.listen(Number(process.env.PORT || 3000), () => {
  console.log(`Sync iOS → Google Agenda disponible sur ${process.env.BASE_URL || "http://localhost:3000"}`);
  console.log(`Synchronisation automatique : toutes les ${interval} minutes (quand les deux comptes sont configurés).`);
});
