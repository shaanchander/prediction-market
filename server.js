require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

// --- Middleware ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Rate Limiting ---
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: 'Too many attempts, please try again later.' }
});

app.use('/api/', generalLimiter);
app.use('/admin/', generalLimiter);

// --- Database Setup ---
const DB_PATH = path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
    tokens INTEGER NOT NULL DEFAULT 1000,
    must_set_password INTEGER NOT NULL DEFAULT 0
  );



  CREATE TABLE IF NOT EXISTS markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    yes_pool INTEGER NOT NULL DEFAULT 0,
    no_pool INTEGER NOT NULL DEFAULT 0,
    min_stake INTEGER NOT NULL DEFAULT 1,
    max_stake INTEGER,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolution TEXT CHECK(resolution IN ('yes', 'no', NULL)),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    market_id INTEGER NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('yes', 'no')),
    amount INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE
  );
`);

// --- Migration: add must_set_password column if it doesn't exist (for existing DBs) ---
try { db.exec('ALTER TABLE users ADD COLUMN must_set_password INTEGER NOT NULL DEFAULT 0'); } catch {}

// --- Create indexes for query performance ---
db.exec('CREATE INDEX IF NOT EXISTS idx_bets_user_id ON bets(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_bets_market_id ON bets(market_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_bets_market_side ON bets(market_id, side)');

// --- Prepare Statements ---
const getUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const insertUser = db.prepare('INSERT INTO users (username, password_hash, role, tokens, must_set_password) VALUES (?, ?, ?, ?, ?)');
const updateUserPassword = db.prepare('UPDATE users SET password_hash = ?, must_set_password = 0 WHERE id = ?');
const resetUserPasswordFlag = db.prepare('UPDATE users SET must_set_password = 1 WHERE id = ?');
const updateUserRole = db.prepare('UPDATE users SET role = ? WHERE id = ?');
const deleteUser = db.prepare('DELETE FROM users WHERE id = ?');
const countAdmins = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'");

const insertMarket = db.prepare(
  'INSERT INTO markets (creator_id, title, description, min_stake, max_stake, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const getActiveMarkets = db.prepare(`
  SELECT m.*, u.username AS creator_username 
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  WHERE m.resolved = 0
  ORDER BY m.created_at DESC
`);
const getResolvedMarkets = db.prepare(`
  SELECT m.*, u.username AS creator_username 
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  WHERE m.resolved = 1
  ORDER BY m.created_at DESC
`);
const getAllMarkets = db.prepare(`
  SELECT m.*, u.username AS creator_username 
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  ORDER BY m.created_at DESC
`);
const getMarketById = db.prepare('SELECT * FROM markets WHERE id = ?');

const insertBet = db.prepare(
  'INSERT INTO bets (user_id, market_id, side, amount, created_at) VALUES (?, ?, ?, ?, ?)'
);
const updateUserTokens = db.prepare('UPDATE users SET tokens = ? WHERE id = ?');
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

const updateMarketPools = db.prepare(
  'UPDATE markets SET yes_pool = yes_pool + ?, no_pool = no_pool + ? WHERE id = ?'
);
const resolveMarket = db.prepare(
  'UPDATE markets SET resolved = 1, resolution = ? WHERE id = ?'
);

const getBetsByMarketAndSide = db.prepare(
  'SELECT * FROM bets WHERE market_id = ? AND side = ?'
);

const getBetsForMarket = db.prepare(`
  SELECT b.amount, b.created_at, b.side, u.username
  FROM bets b
  JOIN users u ON b.user_id = u.id
  WHERE b.market_id = ?
  ORDER BY b.created_at DESC
`);

const getBetCountForMarket = db.prepare(
  'SELECT COUNT(*) AS cnt FROM bets WHERE market_id = ?'
);

const getUserBets = db.prepare(`
  SELECT b.*, m.title AS market_title, m.resolved, m.resolution
  FROM bets b
  JOIN markets m ON b.market_id = m.id
  WHERE b.user_id = ?
  ORDER BY b.created_at DESC
`);

const getAllUsers = db.prepare('SELECT id, username, role, tokens, must_set_password FROM users ORDER BY id');
const topUpUsers = db.prepare("UPDATE users SET tokens = tokens + 50 WHERE role = 'user'");

const getStats = db.prepare(`
  SELECT 
    (SELECT COUNT(*) FROM users) AS total_users,
    (SELECT COUNT(*) FROM markets) AS total_markets,
    (SELECT COUNT(*) FROM bets) AS total_bets,
    (SELECT COALESCE(SUM(tokens), 0) FROM users) AS total_tokens,
    (SELECT COUNT(*) FROM markets WHERE resolved = 0) AS active_markets,
    (SELECT COUNT(*) FROM markets WHERE resolved = 1) AS resolved_markets,
    (SELECT COALESCE(SUM(yes_pool + no_pool), 0) FROM markets) AS total_volume
`);

// --- Create default admin on startup ---
function ensureDefaultAdmin() {
  const existing = getUserByUsername.get('admin');
  if (!existing) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';
    const hash = bcrypt.hashSync(adminPassword, 10);
    insertUser.run('admin', hash, 'admin', 1000, 0);
  }
}
ensureDefaultAdmin();

// --- Input Validation ---
function validatePassword(password) {
  if (!password || password.length < 1) return 'Password is required';
  return null;
}

function validateUsername(username) {
  if (!username || username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > 30) return 'Username must be 30 characters or less';
  return null;
}

// --- Auth Middleware ---
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUserById.get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    req.user = { user_id: user.id, username: user.username, role: user.role, tokens: user.tokens };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

app.post('/api/login', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const user = getUserByUsername.get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // If user hasn't set a password yet, allow login without a password
    if (user.must_set_password === 1) {
      return res.json({ must_set_password: true, username: user.username });
    }

    if (!password) return res.status(400).json({ error: 'Password required' });

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    res.json({ token, user: { id: user.id, username: user.username, role: user.role, tokens: user.tokens } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/set-password', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = getUserByUsername.get(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.must_set_password !== 1) return res.status(403).json({ error: 'Password already set' });

    const passwordErr = validatePassword(password);
    if (passwordErr) return res.status(400).json({ error: passwordErr });

    const hash = bcrypt.hashSync(password, 10);
    updateUserPassword.run(hash, user.id);

    const updatedUser = getUserById.get(user.id);
    const token = jwt.sign({ userId: updatedUser.id }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    res.json({ token, user: { id: updatedUser.id, username: updatedUser.username, role: updatedUser.role, tokens: updatedUser.tokens } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set password' });
  }
});

app.post('/api/logout', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = getUserById.get(req.user.user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, role: user.role, tokens: user.tokens });
});

// --- Market Endpoints ---
app.post('/api/markets', requireAuth, (req, res) => {
  try {
    const { title, description, min_stake, max_stake } = req.body;
    if (!title || title.trim().length === 0) return res.status(400).json({ error: 'Title is required' });
    if (title.trim().length > 200) return res.status(400).json({ error: 'Title must be 200 characters or less' });
    if (description && description.trim().length > 2000) return res.status(400).json({ error: 'Description must be 2000 characters or less' });

    const minStake = parseInt(min_stake) || 1;
    const maxStake = max_stake ? parseInt(max_stake) : null;

    if (minStake < 1) return res.status(400).json({ error: 'Min stake must be at least 1' });
    if (maxStake !== null && maxStake < minStake) return res.status(400).json({ error: 'Max stake must be >= min stake' });

    const result = insertMarket.run(
      req.user.user_id,
      title.trim(),
      (description || '').trim(),
      minStake,
      maxStake,
      Math.floor(Date.now() / 1000)
    );

    const market = getMarketById.get(result.lastInsertRowid);
    res.status(201).json(market);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create market' });
  }
});

// Helper to get bet count for a list of market IDs
function getBetCounts(marketIds) {
  const counts = {};
  for (const id of marketIds) {
    const row = getBetCountForMarket.get(id);
    counts[id] = row ? row.cnt : 0;
  }
  return counts;
}

app.get('/api/markets', (req, res) => {
  try {
    const type = req.query.type || 'all';
    let markets;
    if (type === 'active') {
      markets = getActiveMarkets.all();
    } else if (type === 'resolved') {
      markets = getResolvedMarkets.all();
    } else {
      markets = getAllMarkets.all();
    }
    
    // Attach bet counts
    const marketIds = markets.map(m => m.id);
    const betCounts = getBetCounts(marketIds);
    markets = markets.map(m => ({ ...m, bet_count: betCounts[m.id] || 0 }));
    
    res.json(markets);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

// --- Market Bets Endpoint ---
app.get('/api/markets/:id/bets', (req, res) => {
  try {
    const marketId = parseInt(req.params.id);
    const market = getMarketById.get(marketId);
    if (!market) return res.status(404).json({ error: 'Market not found' });

    const bets = getBetsForMarket.all(marketId);
    const yesBets = bets.filter(b => b.side === 'yes');
    const noBets = bets.filter(b => b.side === 'no');

    res.json({
      yes_voters: yesBets,
      no_voters: noBets,
      total_bets: bets.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

// --- Leaderboard Endpoint ---
app.get('/api/leaderboard', (_req, res) => {
  try {
    const rows = db.prepare('SELECT id, username, tokens FROM users ORDER BY tokens DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// --- Betting Endpoint ---
app.post('/api/bet', requireAuth, (req, res) => {
  try {
    const { market_id, side, amount } = req.body;
    if (!market_id || !side || !amount) return res.status(400).json({ error: 'market_id, side, and amount required' });
    if (!['yes', 'no'].includes(side)) return res.status(400).json({ error: 'Side must be "yes" or "no"' });

    const betAmount = parseInt(amount);
    if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ error: 'Amount must be a positive integer' });

    const user = getUserById.get(req.user.user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const market = getMarketById.get(market_id);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.resolved) return res.status(400).json({ error: 'Market already resolved' });

    // Validate min/max stake
    if (betAmount < market.min_stake) return res.status(400).json({ error: `Minimum stake is ${market.min_stake}` });
    if (market.max_stake !== null && betAmount > market.max_stake) {
      return res.status(400).json({ error: `Maximum stake is ${market.max_stake}` });
    }

    // 20% cap
    const maxBet = Math.floor(user.tokens * 0.2);
    if (betAmount > maxBet) return res.status(400).json({ error: `Maximum bet is ${maxBet} tokens (20% of balance)` });

    // Sufficient balance
    if (betAmount > user.tokens) return res.status(400).json({ error: 'Insufficient tokens' });

    // Deduct tokens
    updateUserTokens.run(user.tokens - betAmount, user.id);

    // Add to pool
    const yesAdd = side === 'yes' ? betAmount : 0;
    const noAdd = side === 'no' ? betAmount : 0;
    updateMarketPools.run(yesAdd, noAdd, market_id);

    // Record bet
    insertBet.run(user.id, market_id, side, betAmount, Math.floor(Date.now() / 1000));

    const updatedUser = getUserById.get(user.id);
    const updatedMarket = getMarketById.get(market_id);

    res.json({
      bet: { market_id, side, amount: betAmount },
      user: { tokens: updatedUser.tokens },
      market: { yes_pool: updatedMarket.yes_pool, no_pool: updatedMarket.no_pool }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to place bet' });
  }
});

// --- Resolution Endpoint ---
app.post('/api/resolve', requireAuth, requireAdmin, (req, res) => {
  try {
    const { market_id, resolution } = req.body;
    if (!market_id || !resolution) return res.status(400).json({ error: 'market_id and resolution required' });
    if (!['yes', 'no'].includes(resolution)) return res.status(400).json({ error: 'Resolution must be "yes" or "no"' });

    const market = getMarketById.get(market_id);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.resolved) return res.status(400).json({ error: 'Market already resolved' });

    const losingSide = resolution === 'yes' ? 'no' : 'yes';
    const winningPool = resolution === 'yes' ? market.yes_pool : market.no_pool;
    const losingPool = resolution === 'yes' ? market.no_pool : market.yes_pool;

    const winningBets = getBetsByMarketAndSide.all(market_id, resolution);

    // Calculate payouts
    const payoutStmt = db.transaction((bets) => {
      for (const bet of bets) {
        if (winningPool > 0) {
          const share = Math.floor((bet.amount / winningPool) * losingPool);
          const payout = bet.amount + share;
          const user = getUserById.get(bet.user_id);
          updateUserTokens.run(user.tokens + payout, bet.user_id);
        }
      }
      resolveMarket.run(resolution, market_id);
    });

    payoutStmt(winningBets);

    const updatedMarket = getMarketById.get(market_id);
    res.json({ market: updatedMarket, payouts: winningBets.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve market' });
  }
});

// --- Bet History Endpoint ---
app.get('/api/history', requireAuth, (req, res) => {
  try {
    const bets = getUserBets.all(req.user.user_id);
    res.json(bets);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bet history' });
  }
});

// --- Admin Endpoints ---
app.get('/admin/stats', requireAuth, requireAdmin, (_req, res) => {
  try {
    const stats = getStats.get();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/admin/users', requireAuth, requireAdmin, (_req, res) => {
  try {
    const users = getAllUsers.all();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/admin/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, role } = req.body;

    const usernameErr = validateUsername(username);
    if (usernameErr) return res.status(400).json({ error: usernameErr });

    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Role must be "user" or "admin"' });

    const existing = getUserByUsername.get(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    // Create user with must_set_password = 1 — they'll set their own password on first login
    // Use a placeholder hash (empty string) since password_hash may be NOT NULL on existing DBs
    // The must_set_password check in login prevents this placeholder from ever being compared
    const placeholderHash = '$2b$10$placeholder';
    const result = insertUser.run(username, placeholderHash, role, 1000, 1);
    const user = getUserById.get(result.lastInsertRowid);

    res.status(201).json({ id: user.id, username: user.username, role: user.role, tokens: user.tokens, must_set_password: user.must_set_password });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.post('/admin/users/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = getUserById.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    resetUserPasswordFlag.run(userId);
    res.json({ ok: true, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

app.patch('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { role } = req.body;

    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Role must be "user" or "admin"' });

    const user = getUserById.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent demoting the last admin
    if (user.role === 'admin' && role === 'user') {
      const { cnt } = countAdmins.get();
      if (cnt <= 1) return res.status(400).json({ error: 'Cannot demote the last admin' });
    }

    updateUserRole.run(role, userId);
    const updated = getUserById.get(userId);
    res.json({ ok: true, username: updated.username, role: updated.role });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // Prevent deleting yourself
    if (userId === req.user.user_id) return res.status(400).json({ error: 'Cannot delete yourself' });

    const user = getUserById.get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent deleting the last admin
    if (user.role === 'admin') {
      const { cnt } = countAdmins.get();
      if (cnt <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
    }

    const username = user.username;
    deleteUser.run(userId);
    res.json({ ok: true, username });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.post('/admin/topup', requireAuth, requireAdmin, (_req, res) => {
  try {
    const result = topUpUsers.run();
    res.json({ ok: true, users_updated: result.changes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to top up users' });
  }
});

// --- Serve SPA ---
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Error Handling Middleware ---
// Handle 404 for API routes
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin/')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  if (_req.path.startsWith('/api/') || _req.path.startsWith('/admin/')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(500).send('Internal server error');
});

// --- Graceful Shutdown ---
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  db.close();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  db.close();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// --- Start Server ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Prediction Market running at http://0.0.0.0:${PORT}`);
  console.log('Admin: username=admin (see server.js for password)');
});
