<div align="center">

# CalSync

**Your iCloud calendars, in Google Calendar. Automatically.**

A small self‑hosted server that copies events from your iPhone, iPad and Mac
to Google Calendar: you pick the calendars, it takes care of the rest.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-000000?style=flat-square&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-local-000000?style=flat-square&logo=sqlite&logoColor=white)
![Google Calendar API](https://img.shields.io/badge/Google_Calendar-API_v3-000000?style=flat-square&logo=googlecalendar&logoColor=white)
![MIT License](https://img.shields.io/badge/license-MIT-000000?style=flat-square)

[Quick start](#quick-start) ·
[Features](#features) ·
[Google setup](#google-cloud-setup) ·
[How it works](#under-the-hood) ·
[FAQ](#faq)

</div>

---

## Features

|  |  |
|---|---|
| **Pick your calendars** | Enable each iCloud calendar individually and send it to the Google calendar of your choice (primary, "Work", "Family"…). |
| **Zero duplicates** | Before creating an event, the sync checks whether it already exists in Google and adopts it instead of copying it twice. |
| **Changes follow** | Title, time, location or description changed in iCloud? Google is updated. |
| **Deletions (optional)** | An event deleted in iCloud can also disappear from Google. |
| **Duplicate cleanup** | A dedicated card finds extra copies and deletes them in one click, without ever touching your own events. |
| **Fully automatic** | Frequency from 5 min to 3 h and the covered time range are set from the UI. |
| **Encrypted secrets** | Apple credentials and Google tokens are encrypted with AES‑256‑GCM and stored only on your machine. |
| **Clean interface** | Black and white dashboard, light or dark theme, sync history, mobile‑friendly. |

> Sync is **one‑way**: from iCloud to Google. Nothing is ever written to iCloud.

## Quick start

```bash
git clone git@github.com:4tocall/ios-google-calendar-auto-sync.git
cd ios-google-calendar-auto-sync
npm install
cp .env.example .env
```

Fill in `.env` (see [Google Cloud setup](#google-cloud-setup)), then generate `SESSION_SECRET` and `ENCRYPTION_KEY` by running this twice:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

And you're off:

```bash
npm start
```

Open **<http://localhost:3000>**, then:

1. **Connect iCloud** with your Apple ID and an [app‑specific password](https://appleid.apple.com).
2. **Connect Google Calendar.**
3. **Pick your calendars** and their destination Google calendar.
4. Click **Sync now**, then let it run.

> **Keep `ENCRYPTION_KEY` safe.** Without it, the saved credentials can no longer be decrypted.

## Requirements

- **Node.js 18** or later
- An **Apple Account** with Calendar enabled in iCloud (Settings → your name → iCloud → Calendar)
- An Apple **app‑specific password** (appleid.apple.com → Sign‑In and Security)
- A **Google Cloud project** with the Google Calendar API enabled

Only calendars **synced with iCloud** are read. "On My iPhone" calendars or calendars from another account (Exchange, Google…) are not accessible.

## Google Cloud setup

<details>
<summary><b>Create the OAuth credentials (5 minutes)</b></summary>

<br>

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library**: enable the **Google Calendar API**.
3. **OAuth consent screen**: choose *External*, then add your Gmail address under **Test users**.
4. **Credentials → Create → OAuth client ID**, type **Web application**.
5. Under **Authorized redirect URIs**, add `http://localhost:3000/auth/google/callback`.
6. Copy the *Client ID* and *Client secret* into `.env`.

**Avoid being signed out every 7 days:** while the app stays in *Testing* mode, Google revokes access after a week. Click **Publish app** to move it to *Production*. For personal use no verification is needed: a simple warning shows up when you sign in.

Requested scopes:

- `calendar.events`: create, update and delete synced events;
- `calendar.calendarlist.readonly`: list your calendars so you can pick a destination.

</details>

<details>
<summary><b>Environment variables</b></summary>

<br>

| Variable | Required | Description |
|---|:---:|---|
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | yes | Must match the URI declared in Google Cloud |
| `SESSION_SECRET` | yes | Random string used to sign cookies |
| `ENCRYPTION_KEY` | yes | 64 hexadecimal characters (AES‑256 key) |
| `PORT` | | HTTP port, `3000` by default |
| `SYNC_EVERY_MINUTES` | | Initial frequency, `15` by default (can be changed in the UI) |
| `DB_PATH` | | SQLite database, `sync.sqlite` by default |
| `TZ` | | Default time zone for events without one, e.g. `Europe/Paris` |

</details>

## Under the hood

```text
 iCloud (CalDAV)
       |
       |  events in the chosen time range
       v
 +-----------+        +------------------+
 |  CalSync  | <----> | encrypted SQLite |
 +-----------+        +------------------+
       |
       v
 Already in Google?
   |-- no ................ create
   |-- yes, changed ...... update
   '-- yes, unchanged .... nothing to do
       |
       v
 Google Calendar
```

1. Each selected calendar is read over **CalDAV** (`caldav.icloud.com`), limited to the chosen time range.
2. Each event gets a stable identifier derived from the calendar and the iCalendar UID.
3. Before any creation, the target Google calendar is inspected: an event carrying that identifier, or with the same title at the same time, is **adopted** instead of duplicated.
4. A content fingerprint avoids needless updates.
5. Changing a calendar's destination **moves** its events.
6. Recurring events are sent with their `RRULE` and `EXDATE` exceptions.

## FAQ

<details>
<summary><b>I have duplicates in Google Calendar, what should I do?</b></summary>

<br>

Open the **Duplicates** card, click **Scan**, review the list, then click **Delete**. Only events created by the sync are affected, and one copy of each is always kept.

</details>

<details>
<summary><b>"The Google connection has expired"</b></summary>

<br>

Your OAuth app is probably in *Testing* mode (access expires after 7 days). Click **Reconnect Google**, then publish the app in the Google Cloud console so you don't have to do it again.

</details>

<details>
<summary><b>Can I use it from my phone?</b></summary>

<br>

Yes, on the same Wi‑Fi network: open `http://<your-computer-ip>:3000`. Just do the Google sign‑in from the computer, since Google redirects to `localhost`.

</details>

<details>
<summary><b>Does the server need to stay on?</b></summary>

<br>

Yes, for automatic sync. A Mac mini, a Raspberry Pi, a NAS or a small VPS will do just fine.

</details>

## Known limitations

- Occurrences **edited individually** within a recurring series (`RECURRENCE-ID`) are not carried over yet; the main series is.
- Reminders, attendees and attachments are not copied.
- Designed for **a single user, running locally**. Before exposing it to the Internet: HTTPS, authentication in front of the UI, persistent sessions and production OAuth URIs.

## Security

- **Never** use your main Apple Account password; revoke the app‑specific password if you stop using the service.
- `.env` and `sync.sqlite*` are excluded from Git.
- Write requests require the `X-Requested-With` header (CSRF protection).
- *Disconnect* on the Google card also revokes the token on Google's side.

## License

[MIT](LICENSE) © 4tocall
