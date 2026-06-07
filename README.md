# Cafe POS — White-label QR Ordering & POS System

A complete restaurant/café ordering system with three surfaces backed by one Node + SQLite server:

- **Customer menu** (`/menu?table=N`) — QR-based table ordering, dark/light mode, coupons
- **POS terminal** (`/counter`) — PIN-locked kitchen + billing display
- **Admin dashboard** (`/admin`) — menu, inventory, CRM, accounting, coupons, reports, settings

This is a generic / unbranded build. Set your café's name from **Admin → Settings → Restaurant Name**.

## Stack
Express · better-sqlite3 · Socket.IO · vanilla HTML/CSS/JS · QR generation.

## Run locally
```bash
npm install
node server.js          # http://localhost:4000
```

## Required environment variables
| Var | Purpose |
|-----|---------|
| `ADMIN_EMAIL` | Admin login email |
| `ADMIN_PASSWORD` | Admin login password |
| `POS_PIN` | PIN to unlock the POS terminal |
| `PUBLIC_URL` | Deployed URL (e.g. `https://your-app.onrender.com`) — used for QR codes & WhatsApp links |

Optional (WhatsApp order notifications via UltraMsg):
| Var | Purpose |
|-----|---------|
| `ULTRAMSG_INSTANCE` | UltraMsg instance id |
| `ULTRAMSG_TOKEN` | UltraMsg token |

The server **exits on start** if `ADMIN_PASSWORD`, `ADMIN_EMAIL`, or `POS_PIN` are missing.

## Deploy on Render
1. Push this repo to GitHub.
2. Render → New → Web Service → connect the repo (`render.yaml` is auto-detected).
3. Set the env vars above in the Render dashboard (including `PUBLIC_URL` = your service URL).
4. Deploy. SQLite DB is created automatically on first run with a sample menu.

## Routes
| Path | Page |
|------|------|
| `/` | Landing page |
| `/menu?table=N` | Customer ordering |
| `/counter` | POS terminal |
| `/admin` | Admin dashboard |
| `/qr-tables` | Printable table QR codes |
| `/status?order=ID` | Customer order tracking |
