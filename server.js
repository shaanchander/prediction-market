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
const fs = require('fs');

// --- Database Backup ---
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_RETENTION_COUNT = 7; // Keep the most recent N backups
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function backupDatabase(label = 'manual') {
  ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').replace(/Z$/, '');
  const filename = `backup_${timestamp}_${label}.db`;
  const backupPath = path.join(BACKUP_DIR, filename);

  // Force WAL checkpoint for consistency, then copy the file
  db.pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB_PATH, backupPath);

  // Cleanup: keep only the most recent BACKUP_RETENTION_COUNT backups
  cleanupOldBackups();

  const size = fs.statSync(backupPath).size;
  console.log(`Backup created: ${filename} (${formatBytes(size)})`);
  return { filename, path: backupPath, size, timestamp: new Date().toISOString() };
}

function cleanupOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  for (const f of files.slice(BACKUP_RETENTION_COUNT)) {
    fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    console.log(`Removed old backup: ${f.name}`);
  }
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: stat.size, created: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Schedule automatic backups
ensureBackupDir();
setInterval(() => {
  try { backupDatabase('auto'); } catch (err) { console.error('Backup failed:', err.message); }
}, BACKUP_INTERVAL_MS);
console.log(`Auto-backup enabled: daily, retaining ${BACKUP_RETENTION_COUNT} most recent`);

// --- Middleware ---
app.use(helmet({
  hsts: false, // Disable HSTS — local server has no HTTPS support
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null // null explicitly disables the directive in Helmet 8
    }
  }
}));
// Restrict CORS — set CORS_ORIGINS env var for production (comma-separated origins)
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000'];
app.use(cors({ origin: corsOrigins, credentials: true }));
// Limit request body size to 10KB to prevent DoS
app.use(bodyParser.json({ limit: '10kb' }));
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
    expires_at INTEGER,
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

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// --- Migration: add must_set_password column if it doesn't exist (for existing DBs) ---
try { db.exec('ALTER TABLE users ADD COLUMN must_set_password INTEGER NOT NULL DEFAULT 0'); } catch {}
// --- Migration: add expires_at column if it doesn't exist ---
try { db.exec('ALTER TABLE markets ADD COLUMN expires_at INTEGER'); } catch {}
// --- Migration: create activity_log table if it doesn't exist ---
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
} catch {}
// Migration: add ip column to activity_log if missing
try { db.exec('ALTER TABLE activity_log ADD COLUMN ip TEXT'); } catch {}

// --- Activity Logger ---
const insertActivityLog = db.prepare(
  'INSERT INTO activity_log (user_id, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?)'
);

function logActivity(userId, action, details, ip) {
  try {
    insertActivityLog.run(
      userId,
      action,
      sanitizeHtml(details || ''),
      ip || null,
      Math.floor(Date.now() / 1000)
    );
  } catch (err) {
    console.error('Activity log write failed:', err.message);
  }
}

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
  'INSERT INTO markets (creator_id, title, description, min_stake, max_stake, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const updateMarket = db.prepare(
  'UPDATE markets SET title = ?, description = ?, expires_at = ? WHERE id = ?'
);
const deleteMarket = db.prepare('DELETE FROM markets WHERE id = ?');

const getActiveMarkets = db.prepare(`
  SELECT m.*, u.username AS creator_username 
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  WHERE m.resolved = 0 AND (m.expires_at IS NULL OR m.expires_at > ?)
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
const searchMarkets = db.prepare(`
  SELECT m.*, u.username AS creator_username 
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  WHERE m.title LIKE ? OR m.description LIKE ?
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

// Admin: get bets with user_id for refund
const getBetsForMarketWithUserId = db.prepare(`
  SELECT b.id AS bet_id, b.user_id, b.amount, b.side, b.created_at, u.username
  FROM bets b
  JOIN users u ON b.user_id = u.id
  WHERE b.market_id = ?
  ORDER BY b.created_at DESC
`);

// Admin: refund a single bet
const deleteBet = db.prepare('DELETE FROM bets WHERE id = ?');
const updateMarketPoolDown = db.prepare(
  'UPDATE markets SET yes_pool = yes_pool - ?, no_pool = no_pool - ? WHERE id = ?'
);

const getBetCountForMarket = db.prepare(
  'SELECT COUNT(*) AS cnt FROM bets WHERE market_id = ?'
);

const getUserBets = db.prepare(`
  SELECT b.*, m.title AS market_title, m.resolved, m.resolution, m.yes_pool, m.no_pool
  FROM bets b
  JOIN markets m ON b.market_id = m.id
  WHERE b.user_id = ?
  ORDER BY b.created_at DESC
`);

const getAllUsers = db.prepare('SELECT id, username, role, tokens, must_set_password FROM users ORDER BY id');

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
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password must be 128 characters or less';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain both letters and numbers';
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
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = getUserById.get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.user = { user_id: user.id, username: user.username, role: user.role, tokens: user.tokens };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication required' });
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
      // Use generic error to avoid username enumeration
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // If user hasn't set a password yet, allow login without a password
    if (user.must_set_password === 1) {
      return res.json({ must_set_password: true, username: user.username });
    }

    if (!password) return res.status(400).json({ error: 'Password required' });

    if (!bcrypt.compareSync(password, user.password_hash)) {
      // Use generic error to avoid user enumeration
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRY, algorithm: 'HS256' });

    logActivity(user.id, 'login', 'Logged in');
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
    const token = jwt.sign({ userId: updatedUser.id }, JWT_SECRET, { expiresIn: JWT_EXPIRY, algorithm: 'HS256' });

    logActivity(updatedUser.id, 'set_password', 'Set password');
    res.json({ token, user: { id: updatedUser.id, username: updatedUser.username, role: updatedUser.role, tokens: updatedUser.tokens } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set password' });
  }
});

app.post('/api/logout', requireAuth, (req, res) => {
  logActivity(req.user.user_id, 'logout', 'Logged out', req.ip);
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
    const { title, description, min_stake, max_stake, expires_at } = req.body;
    const cleanTitle = sanitizeHtml(title);
    const cleanDesc = sanitizeHtml(description || '');
    if (!cleanTitle || cleanTitle.trim().length === 0) return res.status(400).json({ error: 'Title is required' });
    if (cleanTitle.trim().length > 200) return res.status(400).json({ error: 'Title must be 200 characters or less' });
    if (cleanDesc.trim().length > 2000) return res.status(400).json({ error: 'Description must be 2000 characters or less' });

    const minStake = parseInt(min_stake) || 1;
    const maxStake = max_stake ? parseInt(max_stake) : null;

    if (minStake < 1) return res.status(400).json({ error: 'Min stake must be at least 1' });
    if (maxStake !== null && maxStake < minStake) return res.status(400).json({ error: 'Max stake must be >= min stake' });

    // Parse expires_at — expected as ISO string from the client (local time)
    let expiresAt = null;
    if (expires_at) {
      const expDate = new Date(expires_at);
      if (isNaN(expDate.getTime())) return res.status(400).json({ error: 'Invalid expiry date' });
      if (expDate.getTime() <= Date.now()) return res.status(400).json({ error: 'Expiry must be in the future' });
      expiresAt = Math.floor(expDate.getTime() / 1000);
    }

    const result = insertMarket.run(
      req.user.user_id,
      cleanTitle.trim(),
      cleanDesc.trim(),
      minStake,
      maxStake,
      expiresAt,
      Math.floor(Date.now() / 1000)
    );

    const market = getMarketById.get(result.lastInsertRowid);
    logActivity(req.user.user_id, 'create_market', `Created market: ${market.title}`);
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

app.get('/api/markets', requireAuth, (req, res) => {
  try {
    const type = req.query.type || 'all';
    const search = req.query.search || '';
    let markets;

    if (search) {
      const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const pattern = `%${escaped}%`;
      markets = searchMarkets.all(pattern, pattern);
      // Filter by type if specified
      if (type === 'active') markets = markets.filter(m => m.resolved === 0);
      else if (type === 'resolved') markets = markets.filter(m => m.resolved === 1);
    } else if (type === 'active') {
      markets = getActiveMarkets.all(Math.floor(Date.now() / 1000));
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

// --- Input Sanitization Helper ---
function sanitizeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '');
}

// --- Market Edit Endpoint ---
app.patch('/api/markets/:id', requireAuth, (req, res) => {
  try {
    const marketId = parseInt(req.params.id);
    const { title, description, expires_at } = req.body;

    const market = getMarketById.get(marketId);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.resolved) return res.status(400).json({ error: 'Cannot edit a resolved market' });

    // Only creator or admin can edit
    if (market.creator_id !== req.user.user_id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the creator or an admin can edit this market' });
    }

    const cleanTitle = sanitizeHtml(title);
    if (!cleanTitle || cleanTitle.trim().length === 0) return res.status(400).json({ error: 'Title is required' });
    if (cleanTitle.trim().length > 200) return res.status(400).json({ error: 'Title must be 200 characters or less' });
    const cleanDesc = sanitizeHtml(description || '');
    if (cleanDesc.trim().length > 2000) return res.status(400).json({ error: 'Description must be 2000 characters or less' });

    // Parse expires_at if provided
    let expiresAt = market.expires_at; // keep existing value
    if (expires_at !== undefined) {
      if (expires_at) {
        const expDate = new Date(expires_at);
        if (isNaN(expDate.getTime())) return res.status(400).json({ error: 'Invalid expiry date' });
        if (expDate.getTime() <= Date.now()) return res.status(400).json({ error: 'Expiry must be in the future' });
        expiresAt = Math.floor(expDate.getTime() / 1000);
      } else {
        expiresAt = null; // clear expiry
      }
    }

    updateMarket.run(cleanTitle.trim(), cleanDesc.trim(), expiresAt, marketId);
    const updated = getMarketById.get(marketId);
    logActivity(req.user.user_id, 'edit_market', `Edited market: ${updated.title}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update market' });
  }
});

// --- Market Delete Endpoint ---
app.delete('/api/markets/:id', requireAuth, (req, res) => {
  try {
    const marketId = parseInt(req.params.id);

    const market = getMarketById.get(marketId);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.resolved) return res.status(400).json({ error: 'Cannot delete a resolved market' });

    // Only creator or admin can delete
    if (market.creator_id !== req.user.user_id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the creator or an admin can delete this market' });
    }

    deleteMarket.run(marketId);
    logActivity(req.user.user_id, 'delete_market', `Deleted market: ${market.title}`);
    res.json({ ok: true, title: market.title });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete market' });
  }
});

// --- Market Bets Endpoint ---
app.get('/api/markets/:id/bets', requireAuth, (req, res) => {
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
app.get('/api/leaderboard', requireAuth, (_req, res) => {
  try {
    const users = db.prepare('SELECT id, username, tokens, role FROM users ORDER BY tokens DESC').all();
    const result = users.map(u => {
      const bets = getUserBets.all(u.id);
      const resolvedBets = bets.filter(b => b.resolved === 1);
      let wins = 0;
      let totalStaked = 0;
      let totalReturned = 0;
      bets.forEach(b => {
        totalStaked += b.amount;
        if (b.resolved === 1 && b.side === b.resolution) {
          wins++;
          const winningPool = b.side === 'yes' ? b.yes_pool : b.no_pool;
          const losingPool = b.side === 'yes' ? b.no_pool : b.yes_pool;
          const payout = b.amount + Math.floor((b.amount / winningPool) * losingPool);
          totalReturned += payout;
        }
      });
      const losses = resolvedBets.length - wins;
      const winRate = resolvedBets.length > 0 ? Math.round((wins / resolvedBets.length) * 100) : 0;
      const netProfit = totalReturned - totalStaked;
      return { id: u.id, username: u.username, tokens: u.tokens, wins, losses, winRate, netProfit };
    });
    res.json(result);
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

    // Check if market has expired
    if (market.expires_at && Math.floor(Date.now() / 1000) >= market.expires_at) {
      return res.status(400).json({ error: 'This market has expired and is no longer accepting bets' });
    }

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

    // Atomic bet placement — use a transaction to prevent race conditions
    const placeBetTx = db.transaction(() => {
      // Re-read user tokens inside the transaction to prevent race conditions
      const currentUser = getUserById.get(req.user.user_id);
      if (!currentUser) throw new Error('User not found');
      if (currentUser.tokens < betAmount) throw new Error('Insufficient tokens');

      // 20% cap — checked inside transaction to prevent race condition bypass
      const maxBet = Math.floor(currentUser.tokens * 0.2);
      if (betAmount > maxBet) throw new Error(`Maximum bet is ${maxBet} tokens (20% of balance)`);

      // Deduct tokens
      updateUserTokens.run(currentUser.tokens - betAmount, currentUser.id);

      // Add to pool
      const yesAdd = side === 'yes' ? betAmount : 0;
      const noAdd = side === 'no' ? betAmount : 0;
      updateMarketPools.run(yesAdd, noAdd, market_id);

      // Record bet
      insertBet.run(currentUser.id, market_id, side, betAmount, Math.floor(Date.now() / 1000));
    });

    placeBetTx();

    const updatedUser = getUserById.get(req.user.user_id);
    const updatedMarket = getMarketById.get(market_id);

    logActivity(req.user.user_id, 'place_bet', `Bet ${betAmount} ${side} on market #${market_id}`);
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

    // Calculate payouts — use a transaction to prevent race conditions
    const payoutStmt = db.transaction((bets) => {
      for (const bet of bets) {
        if (winningPool > 0) {
          const share = Math.floor((bet.amount / winningPool) * losingPool);
          const payout = bet.amount + share;
          // Re-read user inside transaction for accurate balance
          const user = getUserById.get(bet.user_id);
          if (user) {
            updateUserTokens.run(user.tokens + payout, bet.user_id);
          }
        }
      }
      resolveMarket.run(resolution, market_id);
    });

    payoutStmt(winningBets);

    const updatedMarket = getMarketById.get(market_id);
    logActivity(req.user.user_id, 'resolve_market', `Resolved market #${market_id} → ${resolution} (${winningBets.length} payouts)`);
    res.json({ market: updatedMarket, payouts: winningBets.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve market' });
  }
});

// --- Bet History Endpoint ---
app.get('/api/history', requireAuth, (req, res) => {
  try {
    const bets = getUserBets.all(req.user.user_id);
    // Calculate payout info for resolved bets
    const betsWithPayout = bets.map(bet => {
      if (bet.resolved === 1 && bet.resolution) {
        const won = bet.side === bet.resolution;
        const winningPool = bet.side === 'yes' ? bet.yes_pool : bet.no_pool;
        const losingPool = bet.side === 'yes' ? bet.no_pool : bet.yes_pool;
        let payout = 0;
        let profit = 0;
        if (won && winningPool > 0) {
          payout = bet.amount + Math.floor((bet.amount / winningPool) * losingPool);
          profit = payout - bet.amount;
        }
        return { ...bet, payout, profit, won };
      }
      return { ...bet, payout: 0, profit: 0, won: false };
    });
    res.json(betsWithPayout);
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

    logActivity(req.user.user_id, 'create_user', `Created user ${username} (role: ${role})`);
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
    logActivity(req.user.user_id, 'reset_password', `Reset password for ${user.username}`);
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

    const oldRole = user.role;
    updateUserRole.run(role, userId);
    const updated = getUserById.get(userId);
    logActivity(req.user.user_id, 'change_role', `Changed ${user.username} role ${oldRole} → ${role}`);
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

    // Delete markets created by this user (unresolved only — resolved markets are history)
    const deleteMarketsByUser = db.prepare('DELETE FROM markets WHERE creator_id = ? AND resolved = 0');
    deleteMarketsByUser.run(userId);

    const username = user.username;
    deleteUser.run(userId);
    logActivity(req.user.user_id, 'delete_user', `Deleted user ${username}`);
    res.json({ ok: true, username });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

const topUpUsersPrepared = db.prepare("UPDATE users SET tokens = tokens + ? WHERE role = 'user'");

app.post('/admin/topup', requireAuth, requireAdmin, (req, res) => {
  try {
    const amount = parseInt(req.body?.amount) || 50;
    const result = topUpUsersPrepared.run(amount);
    logActivity(req.user.user_id, 'topup', `Topped up ${result.changes} users with ${amount} tokens`);
    res.json({ ok: true, users_updated: result.changes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to top up users' });
  }
});

// --- Admin: Grant Tokens to Specific User ---
app.post('/admin/grant-tokens', requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, amount } = req.body;
    if (!username || !amount || amount <= 0) return res.status(400).json({ error: 'Username and valid amount required' });
    const user = getUserByUsername.get(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    updateUserTokens.run(user.tokens + amount, user.id);
    logActivity(req.user.user_id, 'grant_tokens', `Granted ${amount} tokens to ${username}`);
    res.json({ ok: true, new_balance: user.tokens + amount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to grant tokens' });
  }
});

// --- Backup Endpoints ---
app.post('/admin/backup', requireAuth, requireAdmin, (req, res) => {
  try {
    const info = backupDatabase('manual');
    logActivity(req.user.user_id, 'backup', `Created backup: ${info.filename}`);
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

app.get('/admin/backup', requireAuth, requireAdmin, (_req, res) => {
  try {
    res.json({ backups: listBackups() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// --- Admin: Activity Log Endpoint ---
app.get('/admin/activity-log', requireAuth, requireAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const action = req.query.action || '';
    const search = req.query.search || '';

    let query = `
      SELECT al.*, u.username AS actor
      FROM activity_log al
      LEFT JOIN users u ON al.user_id = u.id
    `;
    const params = [];
    const whereClauses = [];

    if (action) {
      whereClauses.push('al.action = ?');
      params.push(action);
    }

    if (search) {
      const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const pattern = `%${escaped}%`;
      whereClauses.push('(al.details LIKE ? OR u.username LIKE ?)');
      params.push(pattern, pattern);
    }

    if (whereClauses.length > 0) {
      query += ' WHERE ' + whereClauses.join(' AND ');
    }

    query += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const logs = db.prepare(query).all(...params);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) AS cnt FROM activity_log';
    const countParams = [];
    const countWhereClauses = [];

    if (action) {
      countWhereClauses.push('action = ?');
      countParams.push(action);
    }

    if (search) {
      const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const pattern = `%${escaped}%`;
      countWhereClauses.push('(details LIKE ? OR EXISTS (SELECT 1 FROM users WHERE users.id = activity_log.user_id AND users.username LIKE ?))');
      countParams.push(pattern, pattern);
    }

    if (countWhereClauses.length > 0) {
      countQuery += ' WHERE ' + countWhereClauses.join(' AND ');
    }

    const total = db.prepare(countQuery).get(...countParams).cnt;

    // Get available actions for filter dropdown
    const actions = db.prepare('SELECT DISTINCT action FROM activity_log ORDER BY action').all();

    res.json({ logs, total, actions: actions.map(a => a.action) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch activity log' });
  }
});

// --- Admin: Get bets for a market (with user_id for refund) ---
app.get('/admin/markets/:id/bets', requireAuth, requireAdmin, (req, res) => {
  try {
    const marketId = parseInt(req.params.id);
    const market = getMarketById.get(marketId);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.resolved) return res.status(400).json({ error: 'Cannot refund bets on a resolved market' });

    const bets = getBetsForMarketWithUserId.all(marketId);
    res.json({ bets, market_title: market.title });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

// --- Admin: Refund a single bet ---
app.post('/admin/bets/:id/refund', requireAuth, requireAdmin, (req, res) => {
  try {
    const betId = parseInt(req.params.id);
    const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
    if (!bet) return res.status(404).json({ error: 'Bet not found' });

    const market = getMarketById.get(bet.market_id);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.resolved) return res.status(400).json({ error: 'Cannot refund bets on a resolved market' });

    // Refund tokens to user
    const user = getUserById.get(bet.user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    updateUserTokens.run(user.tokens + bet.amount, bet.user_id);

    // Remove bet from pool
    if (bet.side === 'yes') {
      updateMarketPoolDown.run(bet.amount, 0, bet.market_id);
    } else {
      updateMarketPoolDown.run(0, bet.amount, bet.market_id);
    }

    // Delete the bet
    deleteBet.run(betId);

    logActivity(req.user.user_id, 'refund_bet', `Refunded ${bet.amount} tokens to ${user.username} on market #${bet.market_id}`);
    res.json({ ok: true, refunded: bet.amount, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Failed to refund bet' });
  }
});

// --- User Profile Endpoint ---
app.get('/api/users/:username', requireAuth, (req, res) => {
  try {
    const user = getUserByUsername.get(req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get user's bets with market info
    const bets = getUserBets.all(user.id);
    const totalBets = bets.length;
    const openBets = bets.filter(b => b.resolved !== 1).length;
    const resolvedBets = bets.filter(b => b.resolved === 1);

    // Calculate wins/losses
    let wins = 0;
    let totalStaked = 0;
    let totalReturned = 0;
    let biggestWin = 0;
    let biggestLoss = 0;

    bets.forEach(b => {
      totalStaked += b.amount;
      if (b.resolved === 1) {
        const won = b.side === b.resolution;
        if (won) {
          wins++;
          const winningPool = b.side === 'yes' ? b.yes_pool : b.no_pool;
          const losingPool = b.side === 'yes' ? b.no_pool : b.yes_pool;
          const payout = b.amount + Math.floor((b.amount / winningPool) * losingPool);
          totalReturned += payout;
          biggestWin = Math.max(biggestWin, payout - b.amount);
        } else {
          biggestLoss = Math.max(biggestLoss, b.amount);
        }
      }
    });

    const losses = resolvedBets.length - wins;
    const winRate = resolvedBets.length > 0 ? Math.round((wins / resolvedBets.length) * 100) : 0;
    const netProfit = totalReturned - totalStaked;

    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      tokens: user.tokens,
      totalBets,
      openBets,
      wins,
      losses,
      winRate,
      netProfit,
      biggestWin,
      biggestLoss,
      joinedAt: db.prepare('SELECT created_at FROM markets WHERE creator_id = ? ORDER BY created_at ASC LIMIT 1').get(user.id)?.created_at ?? null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// --- Admin: Refund all bets on a market and delete the market ---
app.post('/admin/markets/:id/refund-and-delete', requireAuth, requireAdmin, (req, res) => {
  try {
    const marketId = parseInt(req.params.id);
    const market = getMarketById.get(marketId);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.resolved) return res.status(400).json({ error: 'Cannot refund bets on a resolved market' });

    // Get all bets
    const bets = getBetsForMarketWithUserId.all(marketId);
    let refundedCount = 0;

    // Refund each bet and remove from pools
    for (const bet of bets) {
      const user = getUserById.get(bet.user_id);
      if (user) {
        updateUserTokens.run(user.tokens + bet.amount, bet.user_id);
        // Remove from pool
        if (bet.side === 'yes') {
          updateMarketPoolDown.run(bet.amount, 0, bet.market_id);
        } else {
          updateMarketPoolDown.run(0, bet.amount, bet.market_id);
        }
        refundedCount++;
      }
    }

    // Delete the market (CASCADE will delete all bets)
    deleteMarket.run(marketId);

    logActivity(req.user.user_id, 'refund_and_delete', `Refunded ${refundedCount} bets and deleted market: ${market.title}`);
    res.json({ ok: true, refunded_count: refundedCount, title: market.title });
  } catch (err) {
    res.status(500).json({ error: 'Failed to refund and delete market' });
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
  console.log('Admin: username=admin (password from ADMIN_PASSWORD env var)');
});
