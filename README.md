# Check-in System

An attendance app with a location lock. Employees check in and check out from their phone or laptop, but only
when they are physically at the office. Late check-ins, early check-outs and people who never showed up
trigger an email.

- **Frontend:** React (Vite) in `client/`
- **Backend:** Node.js + Express in `server/`, with SQLite (built into Node 22.13 and later) for storage and Nodemailer for email

## Quick start

Requires **Node.js 22.13 or newer**.

```bash
npm run setup            # installs root, server and client dependencies
cp server/.env.example server/.env   # then edit it (see below)
npm run dev              # API on :4000, React app on http://localhost:5173
```

On first start, the server creates an admin account from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`.
If no password is set, it generates one and prints it in the terminal.

### First-time setup (as admin)

1. Log in, then go to **Admin → Settings**.
2. Stand in the office and click **Use my current location**. You can also type the latitude and longitude yourself.
   Use **View on map** to confirm the location, then pick a radius (for example 100–150 m).
3. Set the start and end times, grace period, work days and **timezone** (for example `Africa/Kigali`).
4. Enter the manager or HR addresses that should get alerts, then click **Save settings** and **Send test email**.
5. In **Admin → Employees**, add each person with a temporary password.

## How it works

| Rule | Behaviour |
|---|---|
| Location lock | The browser sends a high-accuracy GPS fix. The **server** measures the distance to the office and rejects the request if it is outside the radius, or if the GPS accuracy is worse than the "max GPS inaccuracy" setting. |
| Time | The server's clock and the configured timezone are used, not the employee's device clock, so changing the phone's time does nothing. |
| Late | A check-in after `start time + grace period` on a work day is marked late. An email goes to the alert addresses (and to the employee if that option is on). |
| Early leave | A check-out before the end time is marked early, with an optional email. |
| No-show | Once the grace period ends, the server sends **one** email per day listing employees who haven't checked in yet. |
| Limits | One check-in and one check-out per person per day. |

## Email (SMTP)

Fill in the `SMTP_*` values in `server/.env`. Until you do, emails are **printed in the server console**,
which is useful for testing. To use Gmail, create an
[App Password](https://myaccount.google.com/apppasswords) and set:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-char-app-password
```

## Deploying

```bash
npm run build   # builds the React app into client/dist
npm start       # Express serves the API and the built app on PORT (default 4000)
```

**HTTPS is required in production.** Browsers only allow location access on `https://` pages (and on
`localhost`). Host it behind HTTPS, for example on a VPS with Caddy or nginx, or on Render or Railway. Set a long random
`JWT_SECRET` and keep `server/data.db` backed up.

## Limitations

- GPS can be spoofed by someone determined to cheat (for example with a fake-GPS app on a rooted or jail-broken phone). The server
  check stops casual cheating. For stronger guarantees, you could also require the office Wi-Fi network by checking the public IP,
  or use a QR code shown on a screen at the entrance.
- Overnight shifts (an end time past midnight) aren't supported. Everyone works the same single schedule.
