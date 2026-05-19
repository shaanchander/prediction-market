# Prediction Markets App — Implementation Plan

## Project Overview

A responsive web application that allows users to create binary prediction markets (Yes/No events) and wager tokens on outcomes. Users compete against each other in a pari-mutuel pooling system. The app is designed for ease of use on desktop and mobile devices.

**MVP Scope:** Single-deployment demo with SQLite backend, no real money or regulatory compliance.

---

## Core Requirements (Confirmed)

### User & Token System
- **Authentication:** Username + password (no email required for MVP)
- **User Roles:** Regular user, Admin
- **Starting Allocation:** 1000 tokens per new user
- **Weekly Top-Up:** 50 tokens per user per week (admin endpoint)
- **Token Balance:** Tracked per user; tokens are internal units (not real currency)

### Markets & Betting

#### Market Creation
- Any authenticated user can create a market
- Market has: title, description, optional min/max stake per market
- Market creator can set per-market wager limits (in addition to global 20% cap)
- Markets are binary (Yes/No outcomes only)

#### Betting Rules
- **Global Per-Bet Cap:** 20% of user's current token balance (e.g., user with 1000 tokens can bet max 200)
- **Per-Market Limits:** Creator can optionally enforce min/max stake per market
- **Validation:** Bet amount must be positive integer; user must have sufficient balance
- **Pools:** Yes/No stakes accumulate in separate pools per market

#### Payout Model (Pari-Mutuel)
- Winners split the **opposing pool** proportionally to their stake
- Example: 100 tokens bet Yes, 150 bet No. If Yes wins:
  - Each Yes bettor gets their stake back + their share of the 150-token pool
  - Share = (their_stake / total_yes_stakes) × 150
- **Platform fee:** None (MVP)

#### Market Resolution
- **Resolution Authority:** Admin only (final decision, no appeals)
- **Workflow:** Admin views a market and clicks "Resolve Yes" or "Resolve No"
- **Payout Trigger:** Winning bets are automatically paid out; market marked as resolved
- **User Visibility:** Resolved markets show the outcome; no further bets allowed

---

## User Roles & Permissions

### Regular User
- Register with username/password
- Login with token-based session
- Create markets (any title/description)
- Place bets on unresolved markets
- View their token balance
- View market list and betting history (basic)

### Admin
- All regular user capabilities
- Resolve markets (determine Yes/No winner)
- Manage users: list all users, create new users (assign role)
- Top-up: trigger weekly token distribution to all regular users
- Delete/modify markets (optional — not in MVP UI)

---

## Technical Architecture

### Backend
- **Server:** Express.js
- **Database:** SQLite (data.db)
- **Port:** 3000 (default)
- **Session Management:** Simple token-based (randomUUID); stored in sessions table

### Frontend
- **Type:** Responsive single-page app (HTML/CSS/JavaScript)
- **Assets:** Served inline in server.js (index.html, app.js, styles.css)
- **Storage:** localStorage for session token persistence
- **Mobile:** CSS media queries; mobile-first input layout

### Deployment
- npm install && npm start
- No Docker/Kubernetes in MVP
- Data persists in SQLite file (data.db)

---

## Database Schema

### Users Table
```
id (PRIMARY KEY, auto-increment)
username (UNIQUE)
password_hash (bcrypt-hashed)
role (user | admin)
tokens (integer balance)
```

### Sessions Table
```
token (PRIMARY KEY, UUID string)
user_id (foreign key → users)
created_at (unix timestamp)
```

### Markets Table
```
id (PRIMARY KEY, auto-increment)
creator_id (user_id who created it)
title (string)
description (string)
yes_pool (integer, accumulated stakes)
no_pool (integer, accumulated stakes)
min_stake (integer, default 1)
max_stake (integer, nullable)
resolved (boolean, 0 or 1)
resolution (string, 'yes' or 'no' or null)
created_at (unix timestamp)
```

### Bets Table
```
id (PRIMARY KEY, auto-increment)
user_id (foreign key → users)
market_id (foreign key → markets)
side (string, 'yes' or 'no')
amount (integer, tokens wagered)
created_at (unix timestamp)
```

---

## API Endpoints

### Auth
- `POST /api/register` — Create new user (username, password → user object)
- `POST /api/login` — Login (username, password → session token)
- `GET /api/me` [auth] — Fetch current user profile

### Markets
- `POST /api/markets` [auth] — Create market (title, description, min_stake?, max_stake?)
- `GET /api/markets` — List all markets (no auth required)

### Betting
- `POST /api/bet` [auth] — Place bet (market_id, side, amount)

### Market Resolution
- `POST /api/resolve` [auth, admin] — Resolve market (market_id, resolution: 'yes' | 'no')

### Admin
- `GET /admin/users` [auth, admin] — List all users
- `POST /admin/users` [auth, admin] — Create user (username, password, role)
- `POST /admin/topup` [auth, admin] — Top up all regular users by 50 tokens

---

## Frontend Pages & Features

### Home / Main View
- **Auth Panel** (if not logged in): Register & Login forms
- **User Info** (if logged in): Display username, token balance, role
- **Create Market Panel**: Title, Description, Min Stake, Max Stake inputs + Create button
- **Markets List**: 
  - Show all markets: title, description, yes_pool, no_pool
  - For unresolved markets: input field + Bet Yes/Bet No buttons
  - For admin on unresolved: Resolve Yes/Resolve No buttons
  - For resolved: display outcome (e.g., "Resolved: Yes")

### Interactions
- Clicking "Register" → creates account, shows success/error
- Clicking "Login" → authenticates, stores token in localStorage, refreshes UI
- Clicking "Logout" → clears token, resets UI
- Creating market → adds to list immediately
- Placing bet → deducts tokens, updates market pools, refreshes user info
- Resolving market (admin) → pays winners, marks market resolved, updates display

---

## Key Business Logic

### Bet Validation
1. Amount must be positive integer
2. User must have sufficient tokens
3. Bet amount must not exceed 20% of user's current balance
4. Bet must respect market's min/max limits (if set)
5. Market must not be already resolved

### Payout Calculation on Resolution
```
winning_pool = sum of all winning bets
losing_pool = sum of all losing bets

for each winning_bet:
  share = (bet_amount / winning_pool) × losing_pool
  payout = bet_amount + share
  user.tokens += payout
```

### Weekly Top-Up
- Endpoint: `POST /admin/topup`
- Effect: Add 50 tokens to all users with role='user'
- Recommendation: Call manually or schedule external cron job (not in MVP)

---

## Admin Defaults

- **Default Admin User:** username=`admin`, password=`admin`
- Created on first server start if not already present
- All new regular users created with role=`user`

---

## Security Notes (MVP Limitations)

⚠️ **NOT production-ready**
- Sessions stored in memory/DB; no JWT or HTTPS
- Passwords hashed with bcrypt (good), but no password validation rules
- No rate limiting on endpoints
- No input sanitization beyond basic checks
- No CSRF protection
- No SQL injection protection (using parameterized queries, so generally safe)
- Admin endpoints not rate-limited
- No audit logging

**Recommendations for production:**
- Use JWT with expiry and refresh tokens
- Enforce HTTPS
- Add rate limiting + request validation
- Implement proper session expiry
- Add audit logs for admin actions
- Use a real session store (Redis, etc.)

---

## Testing Checklist

- [ ] Register new user → token balance is 1000
- [ ] Login with registered user
- [ ] Create market as regular user
- [ ] Place bet (both Yes and No) on same market
- [ ] Verify token deduction and pool updates
- [ ] Verify 20% per-bet cap enforced
- [ ] Verify per-market min/max enforced
- [ ] Login as admin, resolve market with Yes winner
- [ ] Verify payouts calculated correctly (winners get stake + share)
- [ ] Verify losers receive no payout
- [ ] Run admin topup, verify all regular users gain 50 tokens
- [ ] Test mobile layout (responsive CSS)
- [ ] Test localStorage persistence (close/reopen browser, token still valid)

---

## File Structure

```
/agent-proj
├── server.js                 # Express server + inline frontend assets
├── package.json              # npm dependencies
├── data.db                   # SQLite database (created on first run)
├── CONTEXT.md                # Domain glossary
├── README.md                 # Quick start
└── public/                   # (Optional) Static assets on disk
    ├── index.html
    ├── app.js
    └── styles.css
```

---

## Success Criteria

1. ✅ App starts without errors: `npm install && npm start`
2. ✅ Root URL (http://localhost:3000) serves UI
3. ✅ User can register, login, and view balance
4. ✅ User can create binary markets
5. ✅ User can place bets within 20% cap
6. ✅ Admin can resolve markets and trigger payouts
7. ✅ UI is responsive and mobile-friendly
8. ✅ All data persists in SQLite
9. ✅ Weekly top-up endpoint works

---

## Known Limitations & Future Work

- **Single-deployment only** (no horizontal scaling)
- **Binary markets only** (no sports spreads, multi-outcome, etc.)
- **No real-time updates** (polling-based via page refresh)
- **No market search/filter** (all markets shown)
- **No user leaderboards** (no ranking)
- **No market expiry** (admin must manually mark resolved)
- **No dispute mechanism** (admin decision is final)
- **No bet history per user** (only market-level view)

Future iterations could add:
- JWT authentication with expiry
- Real-time WebSocket updates
- Advanced market types (multi-outcome, continuous)
- Scheduled auto-resolution via oracle
- User profiles and stats
- Market categories/tags
- Admin dashboard
- Audit logs

---

## Summary

**Build a full-stack prediction market web app with:**
- Binary Yes/No markets, user-created or admin-managed
- Pari-mutuel pooled betting with 20% per-bet cap
- Token-based economy (1000 starting, 50/week top-up)
- Admin-resolved outcomes with automatic payouts
- Responsive UI for desktop and mobile
- SQLite backend, Express server, vanilla JavaScript frontend
- Session-based auth (username/password)

**Minimal viable product, suitable for demo and learning.**
