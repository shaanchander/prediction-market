# Prediction Markets — Agent Instructions

Binary prediction-market web app with pari-mutuel betting. Vanilla JS frontend, Express + SQLite backend.

## Quick Start

```bash
npm install
npm start
```

Server runs at `http://localhost:3000`. Database auto-initializes as `data.db` in the project root.

Copy `.env.example` to `.env` and set your own secrets. Default admin username is `admin`. Public registration is disabled — only admins create users.

## Architecture

Everything is monolithic — no framework, no build step.

| File | Purpose |
|---|---|
| `server.js` | Express server, SQLite setup, all API routes |
| `public/index.html` | Single-page app shell (all views inline, toggled via JS) |
| `public/app.js` | Frontend logic: auth, navigation, API calls, rendering |
| `public/styles.css` | All styles, dark theme via CSS custom properties, mobile breakpoint at 640px |

### Data Flow

1. Frontend calls REST API via `api()` helper in `app.js`
2. Auth uses JWT Bearer tokens stored in `localStorage` (`pm_token`)
3. Backend queries SQLite directly with prepared statements
4. Frontend renders HTML strings with `esc()` for XSS safety

### Pages (SPA Sections)

- **Markets** — Active market cards with betting
- **History** — Resolved market archive
- **Leaderboard** — Users ranked by token balance
- **My Bets** — Current user's bet history
- **Admin** — User management, stats, token top-up

## Key Conventions

### Frontend Patterns

- Use `hidden` class (`.hidden { display: none !important }`) for show/hide
- `$(sel)` / `$$` for `querySelector` / `querySelectorAll`
- `show(el)` / `hide(el)` toggle the `hidden` class
- `esc(str)` escapes HTML before injecting into the DOM
- `showToast(message, type)` for feedback — types: `'error'` (default), `'success'`
- `flashMsg(el, msg, type)` for inline form messages
- `api(path, opts)` wraps `fetch` with auth headers and error handling; returns JSON or throws
- Window-scoped functions (`window.placeBet`, `window.resolveMarket`, etc.) for inline `onclick` handlers
- `navigateTo(page)` central function controls page visibility and data loading

### CSS Patterns

- CSS custom properties in `:root` for theming (colors, radius, etc.)
- Mobile-first responsive with `@media (max-width: 640px)` breakpoint
- iOS safe-area insets: `env(safe-area-inset-top/bottom)` for notched phones
- `font-size: 16px` on inputs to prevent iOS zoom on focus
- Admin table transforms to card layout on mobile via `data-label` attributes

### Backend Patterns

- Prepared SQLite statements at module top, reused in routes
- `requireAuth` middleware parses JWT, attaches `req.user`
- `requireAdmin` middleware checks `req.user.role === 'admin'`
- Input validation functions (`validateUsername`, `validatePassword`) return error string or `null`
- Rate limiting: 200 req/min general, 30 req/15min on auth endpoints

### Business Rules

- **20% per-bet cap:** Max bet = 20% of user's current token balance
- **Pari-mutuel payout:** Winners split the *opposing* pool proportionally
- **Market resolution:** Admin-only. Triggers automatic payouts to winners
- **Token economy:** 1000 starting tokens. Admin top-up grants 50 tokens/week to regular users
- **User creation:** Admin-created users have `must_set_password=1` — they set their own password on first login

## Responsive Design

This is a responsive web app. **After any UI change beyond minor tweaks, validate the layout at both desktop (~960px) and mobile (~375px) window widths.**

Common mobile pitfalls:
- Bet row stacks vertically — ensure buttons remain thumb-reachable
- Admin table becomes cards — check `data-label` attributes render correctly
- Nav scrolls horizontally — verify no nav buttons are clipped
- Header stacks vertically — ensure user bar and token badge are visible

Use the VS Code browser to test both breakpoints, or open `http://localhost:3000` and resize the window.

## Database Schema

See [plan.md](./plan.md) for the full schema and API reference.

### Tables

- **users** — id, username (unique), password_hash, role (user/admin), tokens, must_set_password
- **markets** — id, creator_id, title, description, yes_pool, no_pool, min_stake, max_stake, resolved, resolution, created_at
- **bets** — id, user_id, market_id, side (yes/no), amount, created_at

## Git Workflow

**Always run git commands outside the sandbox** (set `requestUnsandboxedExecution=true`).

After completing a feature or fix:

1. **Stage and commit** with a descriptive message:
   ```bash
   git add -A && git commit -m "feat: short description of what changed"
   ```
   Use conventional prefixes: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`.

2. **If the change is a feature** (not a minor fix or config tweak), create a branch first:
   ```bash
   git checkout -b feature/description
   git add -A && git commit -m "feat: description"
   ```

3. **Push to GitHub** after verifying the server still starts:
   ```bash
   git push origin main
   # Or if on a feature branch:
   git push -u origin feature/description
   ```

4. **Never commit secrets.** `.env` is in `.gitignore`. If a secret slips in, force-push a clean commit immediately.

5. **Don't push** `.vscode/`, `node_modules/`, or `data.db` — all covered by `.gitignore`.

## File Structure

```
server.js              ← Express server, DB setup, all API routes
public/
  index.html           ← SPA shell with all page sections
  app.js               ← Frontend logic
  styles.css           ← All styles (desktop + mobile media query)
package.json           ← Dependencies
plan.md                ← Detailed design doc, API spec, business logic
README.md              ← Quick start, features overview
```

## Dependencies

- **express** — HTTP server
- **better-sqlite3** — Synchronous SQLite
- **bcrypt** — Password hashing
- **jsonwebtoken** — JWT session tokens
- **helmet** — Security headers
- **cors** — Cross-origin config
- **express-rate-limit** — Rate limiting
- **body-parser** — JSON body parsing
- **dotenv** — Environment variables
