# Prediction Markets

Binary prediction-market web app with pari-mutuel pooled betting.

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000

Copy `.env.example` to `.env` and set `JWT_SECRET` and `ADMIN_PASSWORD` before starting. The admin account (`username: admin`) is created automatically on first launch.

> ⚠️ **Note:** If `ADMIN_PASSWORD` contains special characters (`#`, `$`, etc.), wrap the value in single quotes to prevent dotenv from truncating it.

> ⚠️ **Important:** Public registration is disabled. Only admins can create new user accounts via the admin panel.

## Features

- **Binary Yes/No markets** — Any authenticated user can create markets
- **Market categories** — Admins create categories with custom colors; filter markets by category
- **Pari-mutuel betting** — Winners split the opposing pool proportionally
- **20% per-bet cap** — Maximum bet is 20% of your token balance
- **Token economy** — 1000 starting tokens, admin top-up grants 50 tokens per user
- **Market expiry** — Optional deadline after which betting closes
- **Admin resolution** — Admins resolve markets, triggering automatic payouts
- **Admin bet refunds** — Cancel individual bets, refunding tokens and removing from pool
- **User profiles** — View any user's stats: wins, losses, win rate, profit/loss
- **Live polling** — Markets auto-refresh every 10 seconds
- **Auto backup** — Daily database backups, retained for 7 days
- **Responsive UI** — Bottom sheets on mobile, centered modals on desktop
- **SQLite backend** — Data persists in `data.db` (WAL mode)

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | *(required)* | Secret for signing JWT tokens — use a strong random value |
| `ADMIN_PASSWORD` | `changeme` | Initial admin password |
| `PORT` | `3000` | Server port |
| `JWT_EXPIRY` | `7d` | JWT token lifetime |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins |

## API

All endpoints require a valid JWT Bearer token except `/api/login` and `/api/set-password`.

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/login` | Login (body: `{ username, password }`) |
| POST | `/api/set-password` | First-time password set (body: `{ username, password }`) |
| POST | `/api/logout` | Logout |
| GET | `/api/me` | Current user info |

### Markets

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/markets` | Create market |
| GET | `/api/markets?type=active` | List active markets |
| GET | `/api/markets?type=resolved` | List resolved markets |
| GET | `/api/markets?search=...` | Search markets |
| PATCH | `/api/markets/:id` | Edit market (creator or admin only) |
| DELETE | `/api/markets/:id` | Delete market (creator or admin only) |
| GET | `/api/markets/:id/bets` | Get bets for a market |

### Betting

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/bet` | Place bet (body: `{ market_id, side, amount }`) |
| POST | `/api/resolve` | Resolve market (admin only, body: `{ market_id, resolution }`) |
| GET | `/api/history` | Current user's bet history |
| GET | `/api/leaderboard` | All users ranked by tokens |

### Categories

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/categories` | List all categories |
| POST | `/admin/categories` | Create category (admin, body: `{ name, color }`) |
| DELETE | `/admin/categories/:id` | Delete category (admin, fails if markets exist) |
| PATCH | `/admin/markets/:id/category` | Assign category to market (admin, body: `{ category_id }`) |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/stats` | Platform statistics |
| GET | `/admin/categories` | List all categories (admin) |
| GET | `/admin/users` | List all users |
| POST | `/admin/users` | Create user (body: `{ username, role }`) |
| PATCH | `/admin/users/:id` | Change user role |
| DELETE | `/admin/users/:id` | Delete user |
| POST | `/admin/users/:id/reset-password` | Force password reset |
| POST | `/admin/topup` | Grant +50 tokens to all regular users |
| GET | `/admin/markets/:id/bets` | List bets on a market (with usernames) |
| POST | `/admin/bets/:id/refund` | Refund a single bet (tokens returned, pool adjusted) |
| POST | `/admin/markets/:id/refund-and-delete` | Refund all bets then delete market |

### User Profile

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users/:username` | User stats: bets, wins, losses, win rate, profit/loss |

## Security

- **Helmet** — Security headers (CSP, HSTS disabled for local dev)
- **Rate limiting** — 200 req/min general, 30 req/15min on auth endpoints
- **bcrypt** — Password hashing with 10 salt rounds
- **JWT** — Signed tokens with algorithm pinned to HS256
- **Prepared statements** — All SQLite queries parameterized
- **XSS protection** — HTML escaping on all user-generated content
- **CORS** — Configurable via `CORS_ORIGINS` env var

## File Structure

```
server.js              ← Express server, SQLite setup, all API routes
public/
  index.html           ← SPA shell with all page sections
  app.js               ← Frontend logic
  styles.css           ← All styles (desktop + mobile)
package.json           ← Dependencies
.env.example           ← Environment template
plan.md                ← Detailed design doc
```

## Tech Stack

- Express.js + SQLite (better-sqlite3)
- Vanilla JS frontend, no build step
- bcrypt for password hashing
- JWT for session tokens
- helmet, cors, express-rate-limit for security

## Deployment Notes

- SQLite uses WAL mode — copy `data.db` and `data.db-wal` together for backups
- Set a strong `JWT_SECRET` — the default from `.env.example` is not safe for production
- Set `CORS_ORIGINS` to your domain if serving behind a reverse proxy
- Use a process manager (pm2, systemd) for auto-restart on crash
- Consider `NODE_ENV=production` to reduce console output
