# Check-in System

An attendance app with a location lock, for one or many institutions. Employees check in and check out from
their phone or laptop, but only when they are physically at their office. Late check-ins, early check-outs
and people who never showed up trigger an email, and admins can download attendance reports as Excel, CSV or PDF.

- **Frontend:** React (Vite) in `client/`
- **Backend:** Node.js + Express in `server/`, with SQLite (built into Node 22.13 and later) for storage,
  Nodemailer for email, ExcelJS and PDFKit for reports

## Quick start

Requires **Node.js 22.13 or newer**.

```bash
npm run setup            # installs root, server and client dependencies
cp server/.env.example server/.env   # then edit it (see below)
npm run dev              # API on :4000, React app on http://localhost:5173
```

## Who uses what

| Role | Logs in at | Can |
|---|---|---|
| **Platform owner** | `/platform` | Create institutions, suspend or reactivate them, resend admin invites, and open an institution in support view. Every support visit is recorded in that institution's security log. |
| **Institution admin** | `/<code>` (e.g. `/nga`) | Everything for their own institution: attendance, reports, employees, office location, hours, alerts and security. They can't see any other institution. |
| **Employee** | `/<code>` | Check in and check out, and see their own last 14 days. |

The platform owner account is created on first start from `PLATFORM_OWNER_EMAIL` / `PLATFORM_OWNER_PASSWORD`.

### Setting up an institution

1. As platform owner, open `/platform`, fill in **New institution** (name, short code, timezone, first admin) and click
   **Create institution & send invite**. The admin gets an email to choose their own password.
2. The admin logs in at `/<code>`, opens **Settings**, stands in the office and clicks **Use my current location**, then sets
   the hours, work days and alert emails.
3. In **Employees**, the admin adds people. Leave the password empty to send them an invite email (recommended).

## Sign-in security

- **Email code on new devices:** the first time someone logs in on a phone or browser, they get a 6-digit code by email.
  If they tick "Trust this device", it's remembered (90 days by default). Admins can change the timings or turn this off
  under **Settings › Security & devices**. It is always on for the platform owner.
- **Lockout:** 5 wrong codes or 10 wrong passwords lock the account for 15 minutes and email the person.
- **Password reset:** "Forgot password?" emails a single-use link (30 min by default). The reply is the same whether or not the email
  exists. Resetting logs the person out everywhere and forgets their trusted devices.
- Admins can see and remove trusted devices, and see recent security activity.

## Reports

**Reports** has three report types: a daily log (one row per person per work day, including absences), a summary per person,
and exceptions only (late, early, absent). Each can be previewed, downloaded as **XLSX**, **CSV** or **PDF** (A4, with signature
lines), or emailed to yourself. Admins can also turn on an automatic summary every Monday (Settings › Email alerts).

Reports are built one at a time in a background worker thread, so check-ins and page loads stay fast while a big
export runs. The worker has its own memory limit (`REPORT_WORKER_MEMORY_MB`, default 1024): a report that would need
more fails with a clear message instead of crashing the server. PDFs are limited to 15,000 rows; use Excel or CSV for more.

Durations of 60 minutes or more are shown as hours and minutes ("1 hr 25 min"). Excel and CSV files also include
a minutes column so totals can still be added up.

## How check-in works

| Rule | Behaviour |
|---|---|
| Location lock | The browser sends a high-accuracy GPS fix. The **server** measures the distance to the office and rejects the request if it is outside the radius, or if the GPS accuracy is worse than the "max GPS inaccuracy" setting. |
| Time | The server's clock and the institution's timezone are used, not the employee's device clock. |
| Late | A check-in after `start time + grace period` on a work day is marked late and emailed to the alert addresses (and the employee, if that's on). |
| Early leave | A check-out before the end time is marked early, with an optional email. |
| No-show | Once the grace period ends, **one** email per day lists employees who haven't checked in yet. |
| Limits | One check-in and one check-out per person per day. |

## Email (SMTP)

Fill in the `SMTP_*` values in `server/.env`. Until you do, emails (including login codes and reset links) are
**printed in the server console**, which is useful for testing. On hosts that block the usual email ports
(Render does), try port `2525` with `SMTP_SECURE=false`.

## Testing

```bash
npm test          # from the project root: end-to-end tests on throwaway databases
```

- **API flow** (`server/test/api.test.mjs`): invites, email codes, check-in rules, reports, password reset,
  lockout, branding, support access, suspension and search.
- **Upgrade** (`server/test/migration.test.mjs`): a database in the original v1 format is migrated and keeps
  its people, attendance and settings.
- **Institution isolation** (`server/test/tenant-isolation.test.mjs`): every admin and platform route is tried
  without login, as an employee, as another institution's admin and as a support session. The route list is
  read from `index.js`, so adding an admin route without an isolation test makes the suite fail.

Load benchmark (CPU and memory per kind of request; run it on the real server to size it):

```bash
npm run build && npm run bench --prefix server -- --employees 2000
```

## Deploying

```bash
npm run build   # builds the React app into client/dist
npm start       # Express serves the API and the built app on PORT (default 4000)
```

**Keep the data outside the code.** Every deploy replaces the code folder, so `DB_PATH` (and the
uploads, which go next to the database) must point to a persistent disk, e.g. `/var/data/checkin.db`
on Render or `/data/checkin.db` on an AWS EBS volume. With `NODE_ENV=production` (or on Render) the
server refuses to start if `DB_PATH` is missing or inside the app folder, and every start logs where
the database is and how many records it has. **AWS step-by-step guide and safe update script:
[deploy/aws/README.md](deploy/aws/README.md).** `npm run backup --prefix server` makes a consistent
copy of the live database at any time.

**HTTPS is required in production**, because browsers only allow location access on `https://` pages (and on `localhost`).
Set `APP_URL` to the public address so that email links point to the right place, set a long random `JWT_SECRET`,
and back up the database file.

### Upgrading from v1

The first time v2 starts on an existing database, it moves all people, attendance and settings into one institution
named by `DEFAULT_INSTITUTION_CODE` / `DEFAULT_INSTITUTION_NAME`. Set those (and the `PLATFORM_OWNER_*` values)
**before** deploying. After the upgrade:

- The root address now shows a search box where people find their institution by name or code. The device remembers
  the last one used and offers it first. Employees can also bookmark `/<code>` directly.
- Everyone has to log in again and confirm their device with an email code once, so make sure SMTP works first.

## Limitations

- GPS can be spoofed by someone determined to cheat (for example with a fake-GPS app on a rooted phone). The server
  check stops casual cheating. For stronger guarantees, you could also require the office Wi-Fi network or a QR code at the entrance.
- Overnight shifts (an end time past midnight) aren't supported. Each institution has one schedule and one office.
