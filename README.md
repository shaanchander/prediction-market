# Prediction Markets

A binary prediction market web app with pari-mutuel pooled betting.

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000

Copy `.env.example` to `.env` and set your `ADMIN_PASSWORD` before starting. The admin account is created automatically on first launch.

> ⚠️ **Important:** Public registration is disabled. Only admins can create new user accounts via the admin panel.

## Features

- **Binary Yes/No markets** — Any user can create markets
- **Pari-mutuel betting** — Winners split the opposing pool proportionally
- **20% per-bet cap** — Maximum bet is 20% of your token balance
- **Token economy** — 1000 starting tokens, 50/week admin top-up
- **Admin resolution** — Admins resolve markets and trigger payouts
- **Responsive UI** — Works on desktop and mobile
- **SQLite backend** — Data persists in `data.db`

## API

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/login` | — | Login |
| GET | `/api/me` | ✅ | Current user |
| POST | `/api/markets` | ✅ | Create market |
| GET | `/api/markets` | — | List markets |
| POST | `/api/bet` | ✅ | Place bet |
| POST | `/api/resolve` | Admin | Resolve market |
| GET | `/admin/users` | Admin | List users |
| POST | `/admin/users` | Admin | Create user |
| POST | `/admin/topup` | Admin | +50 tokens to all users |

## Tech Stack

- Express.js + SQLite (better-sqlite3)
- Vanilla JS frontend served statically
- bcrypt for password hashing
- Token-based sessions
