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
const BET_TAX_RATE = 0.03; // 3% tax on bets, burned (deflationary)
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

// --- Input Sanitization Helper ---
function sanitizeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '');
}

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

// Trust proxy so rate limiter reads X-Forwarded-For correctly
app.set('trust proxy', 1);

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
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
    tokens INTEGER NOT NULL DEFAULT 1000,
    must_set_password INTEGER NOT NULL DEFAULT 0
  );



  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL DEFAULT '#6c5ce7',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS market_tags (
    market_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (market_id, tag_id),
    FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER NOT NULL,
    category_id INTEGER,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    yes_pool INTEGER NOT NULL DEFAULT 0,
    no_pool INTEGER NOT NULL DEFAULT 0,
    min_stake INTEGER NOT NULL DEFAULT 1,
    max_stake INTEGER,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolution TEXT CHECK(resolution IN ('yes', 'no', NULL)),
    expires_at INTEGER,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    pin_order INTEGER NOT NULL DEFAULT 0,
    tax_burned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (creator_id) REFERENCES users(id),
    FOREIGN KEY (category_id) REFERENCES categories(id)
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
// --- Migration: add is_pinned and pin_order columns if they don't exist ---
try { db.exec('ALTER TABLE markets ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE markets ADD COLUMN pin_order INTEGER NOT NULL DEFAULT 0'); } catch {}
// --- Migration: add tax_burned column if it doesn't exist ---
try { db.exec('ALTER TABLE markets ADD COLUMN tax_burned INTEGER NOT NULL DEFAULT 0'); } catch {}
// --- Migration: add category_id column if it doesn't exist ---
try { db.exec('ALTER TABLE markets ADD COLUMN category_id INTEGER REFERENCES categories(id)'); } catch {}
// --- Migration: create tags tables if they don't exist ---
try { db.exec(`CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL COLLATE NOCASE)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS market_tags (
  market_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (market_id, tag_id),
  FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
)`); } catch {}
// --- Migration: create tags tables if they don't exist ---
try { db.exec('CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL COLLATE NOCASE)'); } catch {}
try { db.exec('CREATE TABLE IF NOT EXISTS market_tags (market_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (market_id, tag_id), FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE, FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE)'); } catch {}

// --- Migration: make username case-insensitive (recreate table with COLLATE NOCASE) ---
try {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (schema && !schema.sql.includes('COLLATE NOCASE')) {
    db.pragma('foreign_keys = OFF');
    try { db.exec('DROP TABLE IF EXISTS users_new'); } catch {}
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
        tokens INTEGER NOT NULL DEFAULT 1000,
        must_set_password INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users_new SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.pragma('foreign_keys = ON');
    console.log('Migrated users table to case-insensitive usernames');
  }
} catch (err) {
  db.pragma('foreign_keys = ON');
  console.log('Username case-insensitive migration skipped:', err.message);
}

// --- Migration: announcements + dismissed_announcements tables ---
try { db.exec(`CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  creator_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES users(id)
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS dismissed_announcements (
  user_id INTEGER NOT NULL,
  announcement_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, announcement_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE
)`); } catch {}


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
  'INSERT INTO markets (creator_id, category_id, title, description, min_stake, max_stake, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const updateMarket = db.prepare(
  'UPDATE markets SET title = ?, description = ?, expires_at = ? WHERE id = ?'
);
const deleteMarket = db.prepare('DELETE FROM markets WHERE id = ?');
const updateMarketPin = db.prepare('UPDATE markets SET is_pinned = ?, pin_order = ? WHERE id = ?');

const getActiveMarkets = db.prepare(`
  SELECT m.*, NULL AS creator_username, c.name AS category_name, c.color AS category_color
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  LEFT JOIN categories c ON m.category_id = c.id
  WHERE m.resolved = 0 AND (m.expires_at IS NULL OR m.expires_at > ?)
  ORDER BY m.is_pinned DESC, m.pin_order ASC, m.created_at DESC
`);
const getResolvedMarkets = db.prepare(`
  SELECT m.*, u.username AS creator_username, c.name AS category_name, c.color AS category_color
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  LEFT JOIN categories c ON m.category_id = c.id
  WHERE m.resolved = 1
  ORDER BY m.is_pinned DESC, m.pin_order ASC, m.created_at DESC
`);
const getAllMarkets = db.prepare(`
  SELECT m.*, u.username AS creator_username, c.name AS category_name, c.color AS category_color
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  LEFT JOIN categories c ON m.category_id = c.id
  ORDER BY m.is_pinned DESC, m.pin_order ASC, m.created_at DESC
`);
const searchMarkets = db.prepare(`
  SELECT m.*, u.username AS creator_username, c.name AS category_name, c.color AS category_color
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  LEFT JOIN categories c ON m.category_id = c.id
  WHERE m.title LIKE ? OR m.description LIKE ?
  ORDER BY m.is_pinned DESC, m.pin_order ASC, m.created_at DESC
`);
const searchMarketsByCategory = db.prepare(`
  SELECT m.*, u.username AS creator_username, c.name AS category_name, c.color AS category_color
  FROM markets m 
  JOIN users u ON m.creator_id = u.id 
  LEFT JOIN categories c ON m.category_id = c.id
  WHERE m.category_id = ?
  ORDER BY m.is_pinned DESC, m.pin_order ASC, m.created_at DESC
`);
const getMarketById = db.prepare('SELECT * FROM markets WHERE id = ?');

const getAllCategories = db.prepare('SELECT * FROM categories ORDER BY name');
const insertCategory = db.prepare('INSERT INTO categories (name, color, created_at) VALUES (?, ?, ?)');
const updateMarketCategory = db.prepare('UPDATE markets SET category_id = ? WHERE id = ?');
const updateCategory = db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?');
const deleteCategory = db.prepare('DELETE FROM categories WHERE id = ?');

const insertBet = db.prepare(
  'INSERT INTO bets (user_id, market_id, side, amount, created_at) VALUES (?, ?, ?, ?, ?)'
);
const updateUserTokens = db.prepare('UPDATE users SET tokens = ? WHERE id = ?');
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

const updateMarketPools = db.prepare(
  'UPDATE markets SET yes_pool = yes_pool + ?, no_pool = no_pool + ? WHERE id = ?'
);
const accumulateMarketTax = db.prepare(
  'UPDATE markets SET tax_burned = tax_burned + ? WHERE id = ?'
);
const resolveMarket = db.prepare(
  'UPDATE markets SET resolved = 1, resolution = ? WHERE id = ?'
);

const getBetsByMarketAndSide = db.prepare(
  'SELECT * FROM bets WHERE market_id = ? AND side = ?'
);
const getUserBetsOnMarket = db.prepare(
  'SELECT side, SUM(amount) AS total FROM bets WHERE user_id = ? AND market_id = ? GROUP BY side'
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
    (SELECT COALESCE(SUM(yes_pool + no_pool), 0) FROM markets) AS total_volume,
    (SELECT COALESCE(SUM(tax_burned), 0) FROM markets) AS total_tax_burned
`);

// --- Create default admin on startup ---
function ensureDefaultAdmin() {
  const existing = getUserByUsername.get('admin');
  const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';
  const hash = bcrypt.hashSync(adminPassword, 10);
  if (!existing) {
    insertUser.run('admin', hash, 'admin', 1000, 0);
    console.log('Created default admin user');
  } else {
    // Always sync admin password from .env
    db.prepare('UPDATE users SET password_hash = ?, must_set_password = 0 WHERE username = ?').run(hash, 'admin');
    console.log('Synced admin password from .env');
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
    const { title, description, min_stake, max_stake, expires_at, category_id, tags } = req.body;
    const cleanTitle = sanitizeHtml(title);
    const cleanDesc = sanitizeHtml(description || '');
    if (!cleanTitle || cleanTitle.trim().length === 0) return res.status(400).json({ error: 'Title is required' });
    if (cleanTitle.trim().length > 200) return res.status(400).json({ error: 'Title must be 200 characters or less' });
    if (cleanDesc.trim().length > 2000) return res.status(400).json({ error: 'Description must be 2000 characters or less' });

    const minStake = parseInt(min_stake) || 1;
    const maxStake = max_stake ? parseInt(max_stake) : null;

    if (minStake < 1) return res.status(400).json({ error: 'Min stake must be at least 1' });
    if (maxStake !== null && maxStake < minStake) return res.status(400).json({ error: 'Max stake must be >= min stake' });

    // Validate category_id if provided
    let categoryId = null;
    if (category_id) {
      const catId = parseInt(category_id);
      const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(catId);
      if (!cat) return res.status(400).json({ error: 'Invalid category' });
      categoryId = catId;
    }

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
      categoryId,
      cleanTitle.trim(),
      cleanDesc.trim(),
      minStake,
      maxStake,
      expiresAt,
      Math.floor(Date.now() / 1000)
    );

    // Handle tags
    if (tags && Array.isArray(tags)) {
      const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
      const getTagId = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE');
      const insertMarketTag = db.prepare('INSERT OR IGNORE INTO market_tags (market_id, tag_id) VALUES (?, ?)');
      for (const tagName of tags) {
        const cleanTag = sanitizeHtml(tagName.trim());
        if (!cleanTag) continue;
        insertTag.run(cleanTag);
        const tag = getTagId.get(cleanTag);
        if (tag) insertMarketTag.run(result.lastInsertRowid, tag.id);
      }
    }

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

// Helper to get tags for a list of market IDs
function getTagsForMarkets(marketIds) {
  const tags = {};
  if (!marketIds.length) return tags;
  const placeholders = marketIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT mt.market_id, t.name
    FROM market_tags mt
    JOIN tags t ON mt.tag_id = t.id
    WHERE mt.market_id IN (${placeholders})
  `).all(...marketIds);
  for (const row of rows) {
    if (!tags[row.market_id]) tags[row.market_id] = [];
    tags[row.market_id].push(row.name);
  }
  return tags;
}

app.get('/api/markets', requireAuth, (req, res) => {
  try {
    const type = req.query.type || 'all';
    const search = req.query.search || '';
    const categoryId = req.query.category_id || '';
    let markets;

    if (search) {
      const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const pattern = `%${escaped}%`;
      markets = searchMarkets.all(pattern, pattern);
      if (type === 'active') markets = markets.filter(m => m.resolved === 0);
      else if (type === 'resolved') markets = markets.filter(m => m.resolved === 1);
      if (categoryId) markets = markets.filter(m => m.category_id === parseInt(categoryId));
    } else if (categoryId && type === 'active') {
      markets = searchMarketsByCategory.all(parseInt(categoryId));
      markets = markets.filter(m => m.resolved === 0 && (!m.expires_at || m.expires_at > Math.floor(Date.now() / 1000)));
    } else if (categoryId) {
      markets = searchMarketsByCategory.all(parseInt(categoryId));
      if (type === 'resolved') markets = markets.filter(m => m.resolved === 1);
    } else if (type === 'active') {
      markets = getActiveMarkets.all(Math.floor(Date.now() / 1000));
    } else if (type === 'resolved') {
      markets = getResolvedMarkets.all();
    } else {
      markets = getAllMarkets.all();
    }

    // Attach bet counts and tags
    const marketIds = markets.map(m => m.id);
    const betCounts = getBetCounts(marketIds);
    const marketTags = getTagsForMarkets(marketIds);
    markets = markets.map(m => ({ ...m, bet_count: betCounts[m.id] || 0, tags: marketTags[m.id] || [] }));

    res.json(markets);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

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

// --- Market Pin/Unpin Endpoint (admin only) ---
app.patch('/api/markets/:id/pin', requireAuth, requireAdmin, (req, res) => {
  try {
    const marketId = parseInt(req.params.id);
    const { pinned } = req.body;

    const market = getMarketById.get(marketId);
    if (!market) return res.status(404).json({ error: 'Market not found' });

    // If pinning, get the current max pin_order and add 1
    let pinOrder = 0;
    if (pinned) {
      const maxOrder = db.prepare('SELECT COALESCE(MAX(pin_order), -1) as max_val FROM markets').get();
      pinOrder = maxOrder.max_val + 1;
    }

    updateMarketPin.run(pinned ? 1 : 0, pinOrder, marketId);
    const updated = getMarketById.get(marketId);
    logActivity(req.user.user_id, pinned ? 'pin_market' : 'unpin_market', `${pinned ? 'Pinned' : 'Unpinned'} market: ${updated.title}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update pin status' });
  }
});

// --- Market Bets Endpoint ---
app.get('/api/markets/:id/bets', requireAuth, (req, res) => {
  try {
    const marketId = parseInt(req.params.id);
    const market = getMarketById.get(marketId);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    if (market.resolved !== 1) return res.status(403).json({ error: 'Voters only visible after market is resolved' });

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

    // Calculate tax (rounded up)
    const tax = Math.ceil(betAmount * BET_TAX_RATE);
    const totalCost = betAmount + tax;

    // Sufficient balance (bet + tax)
    if (totalCost > user.tokens) return res.status(400).json({ error: 'Insufficient tokens' });

    // Atomic bet placement — use a transaction to prevent race conditions
    const placeBetTx = db.transaction(() => {
      // Re-read user tokens inside the transaction to prevent race conditions
      const currentUser = getUserById.get(req.user.user_id);
      if (!currentUser) throw new Error('User not found');
      if (currentUser.tokens < betAmount) throw new Error('Insufficient tokens');

      // 20% cap — checked inside transaction to prevent race condition bypass
      const maxBet = Math.floor(currentUser.tokens * 0.2);
      if (betAmount > maxBet) throw new Error(`Maximum bet is ${maxBet} tokens (20% of balance)`);

      // Prevent betting on both sides of the same market
      const existingBets = getUserBetsOnMarket.all(currentUser.id, market_id);
      const hasYes = existingBets.some(b => b.side === 'yes');
      const hasNo = existingBets.some(b => b.side === 'no');
      if (side === 'yes' && hasNo) throw new Error(`You already bet NO on this market. You can't bet on both sides.`);
      if (side === 'no' && hasYes) throw new Error(`You already bet YES on this market. You can't bet on both sides.`);

      // Calculate tax (rounded up)
      const tax = Math.ceil(betAmount * BET_TAX_RATE);
      const totalCost = betAmount + tax;

      // Deduct tokens (bet + tax)
      updateUserTokens.run(currentUser.tokens - totalCost, currentUser.id);

      // Add to pool (bet amount only, tax is burned)
      const yesAdd = side === 'yes' ? betAmount : 0;
      const noAdd = side === 'no' ? betAmount : 0;
      updateMarketPools.run(yesAdd, noAdd, market_id);

      // Accumulate tax burned on market
      accumulateMarketTax.run(tax, market_id);

      // Record bet
      insertBet.run(currentUser.id, market_id, side, betAmount, Math.floor(Date.now() / 1000));
    });

    placeBetTx();

    const updatedUser = getUserById.get(req.user.user_id);
    const updatedMarket = getMarketById.get(market_id);

    logActivity(req.user.user_id, 'place_bet', `Bet ${betAmount} ${side} on market #${market_id}`);
    res.json({
      bet: { market_id, side, amount: betAmount, tax: Math.ceil(betAmount * BET_TAX_RATE) },
      user: { tokens: updatedUser.tokens },
      market: { yes_pool: updatedMarket.yes_pool, no_pool: updatedMarket.no_pool }
    });
  } catch (err) {
    // Pass through user-facing validation errors, hide internal errors
    if (err.message && (err.message.includes('already') || err.message.includes('Insufficient') || err.message.includes('Maximum bet'))) {
      return res.status(400).json({ error: err.message });
    }
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

// --- Tags Endpoints ---
app.get('/api/tags', requireAuth, (_req, res) => {
  try {
    const allTags = db.prepare(`
      SELECT t.id, t.name, COUNT(mt.market_id) as marketCount 
      FROM tags t 
      LEFT JOIN market_tags mt ON t.id = mt.tag_id 
      GROUP BY t.id 
      ORDER BY t.name
    `).all();
    res.json(allTags);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// Admin: Create a new tag
app.post('/admin/tags', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tag name required' });
    const cleanName = sanitizeHtml(name.trim());
    if (cleanName.length > 50) return res.status(400).json({ error: 'Tag name too long' });
    
    const inserted = db.prepare('INSERT INTO tags (name) VALUES (?)').run(cleanName);
    logActivity(req.user.user_id, 'create_tag', `Created tag: ${cleanName}`);
    res.json({ id: inserted.lastInsertRowid, name: cleanName });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Tag already exists' });
    }
    res.status(500).json({ error: 'Failed to create tag' });
  }
});

// Admin: Rename a tag
app.patch('/admin/tags/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const tagId = parseInt(req.params.id);
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tag name required' });
    const cleanName = sanitizeHtml(name.trim());
    if (cleanName.length > 50) return res.status(400).json({ error: 'Tag name too long' });
    
    const existing = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(tagId);
    if (!existing) return res.status(404).json({ error: 'Tag not found' });
    
    db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(cleanName, tagId);
    logActivity(req.user.user_id, 'rename_tag', `Renamed tag "${existing.name}" to "${cleanName}"`);
    res.json({ id: tagId, name: cleanName });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Tag already exists' });
    }
    res.status(500).json({ error: 'Failed to rename tag' });
  }
});

app.patch('/api/markets/:id/tags', requireAuth, requireAdmin, (req, res) => {
  try {
    const marketId = parseInt(req.params.id);
    const { tags } = req.body;
    const market = getMarketById.get(marketId);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    
    // Clear existing tags
    db.prepare('DELETE FROM market_tags WHERE market_id = ?').run(marketId);
    
    if (tags && Array.isArray(tags)) {
      const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
      const getTagId = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE');
      const insertMarketTag = db.prepare('INSERT OR IGNORE INTO market_tags (market_id, tag_id) VALUES (?, ?)');
      for (const tagName of tags) {
        const cleanTag = sanitizeHtml(tagName.trim());
        if (!cleanTag) continue;
        insertTag.run(cleanTag);
        const tag = getTagId.get(cleanTag);
        if (tag) insertMarketTag.run(marketId, tag.id);
      }
    }
    
    logActivity(req.user.user_id, 'edit_market_tags', `Updated tags for market: ${market.title}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tags' });
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

    const username = user.username;

    // Disable FK checks temporarily to avoid cascade issues
    db.pragma('foreign_keys = OFF');
    try {
      // Remove all FK references before deleting user
      db.prepare('DELETE FROM dismissed_announcements WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM bets WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM markets WHERE creator_id = ?').run(userId);
      db.prepare('DELETE FROM announcements WHERE creator_id = ?').run(userId);
      db.prepare('DELETE FROM activity_log WHERE user_id = ?').run(userId);

      deleteUser.run(userId);
    } finally {
      db.pragma('foreign_keys = ON');
    }
    logActivity(req.user.user_id, 'delete_user', `Deleted user ${username}`);
    res.json({ ok: true, username });
  } catch (err) {
    console.error('Delete user error:', err.message);
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

    // Calculate current staked amount (bets on unresolved markets)
    let currentStaked = 0;
    bets.forEach(b => {
      if (b.resolved !== 1) currentStaked += b.amount;
    });

    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      tokens: user.tokens,
      totalBets,
      openBets,
      currentStaked,
      totalStaked,
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

    // Delete bets first (FK constraint on existing DBs may not have CASCADE)
    db.prepare('DELETE FROM bets WHERE market_id = ?').run(marketId);

    // Delete the market
    deleteMarket.run(marketId);

    logActivity(req.user.user_id, 'refund_and_delete', `Refunded ${refundedCount} bets and deleted market: ${market.title}`);
    res.json({ ok: true, refunded_count: refundedCount, title: market.title });
  } catch (err) {
    res.status(500).json({ error: 'Failed to refund and delete market' });
  }
});

// --- Category Endpoints (Admin) ---
app.get('/admin/categories', requireAuth, requireAdmin, (_req, res) => {
  try {
    const categories = getAllCategories.all();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

app.post('/admin/categories', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Category name is required' });
    if (name.trim().length > 50) return res.status(400).json({ error: 'Category name must be 50 characters or less' });

    const cleanName = sanitizeHtml(name).trim();
    const cleanColor = color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#6c5ce7';

    const result = insertCategory.run(cleanName, cleanColor, Math.floor(Date.now() / 1000));
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);

    logActivity(req.user.user_id, 'create_category', `Created category: ${cleanName}`);
    res.status(201).json(category);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Category already exists' });
    }
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.delete('/admin/categories/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const categoryId = parseInt(req.params.id);
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    // Un-categorize markets that use this category
    db.prepare('UPDATE markets SET category_id = NULL WHERE category_id = ?').run(categoryId);

    deleteCategory.run(categoryId);
    logActivity(req.user.user_id, 'delete_category', `Deleted category: ${category.name}`);
    res.json({ ok: true, name: category.name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// --- Update Category (Admin) ---
app.patch('/admin/categories/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const categoryId = parseInt(req.params.id);
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const { name, color } = req.body;
    let newName = category.name;
    let newColor = category.color;

    if (name !== undefined) {
      if (name.trim().length === 0) return res.status(400).json({ error: 'Category name cannot be empty' });
      if (name.trim().length > 50) return res.status(400).json({ error: 'Category name must be 50 characters or less' });
      newName = sanitizeHtml(name).trim();
    }

    if (color !== undefined) {
      newColor = /^#[0-9A-Fa-f]{6}$/.test(color) ? color : category.color;
    }

    updateCategory.run(newName, newColor, categoryId);
    const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
    logActivity(req.user.user_id, 'update_category', `Updated category: ${newName}`);
    res.json(updated);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Category name already exists' });
    }
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// --- Assign Category to Market (Admin) ---
app.patch('/admin/markets/:id/category', requireAuth, requireAdmin, (req, res) => {
  try {
    const marketId = parseInt(req.params.id);
    const { category_id } = req.body;

    const market = getMarketById.get(marketId);
    if (!market) return res.status(404).json({ error: 'Market not found' });

    let categoryId = null;
    if (category_id) {
      const catId = parseInt(category_id);
      const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(catId);
      if (!cat) return res.status(400).json({ error: 'Invalid category' });
      categoryId = catId;
    }

    updateMarketCategory.run(categoryId, marketId);
    const updated = getMarketById.get(marketId);
    logActivity(req.user.user_id, 'assign_category', `Set category for market: ${updated.title}`);
    res.json({ ok: true, category_id: categoryId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update market category' });
  }
});

// --- Get Categories (Public for frontend) ---
app.get('/api/categories', requireAuth, (_req, res) => {
  try {
    const categories = getAllCategories.all();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// --- Announcement Endpoints ---
// Get active announcements (not dismissed by current user)
app.get('/api/announcements', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, u.username AS creator_username
      FROM announcements a
      JOIN users u ON a.creator_id = u.id
      WHERE a.id NOT IN (
        SELECT announcement_id FROM dismissed_announcements WHERE user_id = ?
      )
      ORDER BY a.created_at DESC
    `).all(req.user.user_id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

// Dismiss an announcement for current user
app.post('/api/announcements/:id/dismiss', requireAuth, (req, res) => {
  try {
    const announcementId = parseInt(req.params.id);
    const announcement = db.prepare('SELECT id FROM announcements WHERE id = ?').get(announcementId);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });

    db.prepare('INSERT OR IGNORE INTO dismissed_announcements (user_id, announcement_id) VALUES (?, ?)').run(
      req.user.user_id, announcementId
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dismiss announcement' });
  }
});

// Admin: create announcement
app.post('/admin/announcements', requireAuth, requireAdmin, (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });
    const cleanMessage = sanitizeHtml(message.trim());
    if (cleanMessage.length > 1000) return res.status(400).json({ error: 'Message must be 1000 characters or less' });

    const result = db.prepare(
      'INSERT INTO announcements (message, creator_id, created_at) VALUES (?, ?, ?)'
    ).run(cleanMessage, req.user.user_id, Math.floor(Date.now() / 1000));

    const announcement = db.prepare('SELECT a.*, u.username AS creator_username FROM announcements a JOIN users u ON a.creator_id = u.id WHERE a.id = ?').get(result.lastInsertRowid);
    logActivity(req.user.user_id, 'create_announcement', `Created announcement`);
    res.status(201).json(announcement);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

// Admin: delete announcement
app.delete('/admin/announcements/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const announcementId = parseInt(req.params.id);
    const announcement = db.prepare('SELECT id FROM announcements WHERE id = ?').get(announcementId);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });

    // CASCADE will clean up dismissed_announcements
    db.prepare('DELETE FROM announcements WHERE id = ?').run(announcementId);
    logActivity(req.user.user_id, 'delete_announcement', `Deleted announcement #${announcementId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

// Admin: list all announcements (only those from the last week)
app.get('/admin/announcements', requireAuth, requireAdmin, (_req, res) => {
  try {
    const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const rows = db.prepare(`
      SELECT a.*, u.username AS creator_username
      FROM announcements a
      JOIN users u ON a.creator_id = u.id
      WHERE a.created_at >= ?
      ORDER BY a.created_at DESC
    `).all(oneWeekAgo);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch announcements' });
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
