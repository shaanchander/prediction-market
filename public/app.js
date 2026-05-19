// --- State ---
let token = localStorage.getItem('pm_token');
let currentUser = null;
let currentPage = 'markets';
let pendingUsername = null; // username waiting to set password

// --- Toast Notification System ---
function showToast(message, type = 'error') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger reflow for animation
  toast.offsetHeight;
  toast.classList.add('toast-show');

  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// --- Helpers ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

// Format timestamp as "X time ago"
function timeAgo(timestamp) {
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

// Build voter rows HTML
function renderVoterList(voters) {
  if (!voters.length) return '<div class="voter-empty">No bets yet</div>';
  return voters.map(v => `
    <div class="voter-row">
      <span class="voter-avatar">${esc(v.username[0].toUpperCase())}</span>
      <span class="voter-name">${esc(v.username)}</span>
      <span class="voter-amount">${v.amount}</span>
      <span class="voter-time">${timeAgo(v.created_at)}</span>
    </div>`).join('');
}

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(path, { ...opts, headers: { ...headers, ...opts.headers } })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    });
}

function flashMsg(el, msg, type = 'error') {
  el.textContent = msg;
  el.className = `form-msg ${type}`;
  if (type === 'success') {
    setTimeout(() => { el.textContent = ''; el.className = 'form-msg'; }, 4000);
  }
}

// --- Login ---
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (data.must_set_password) {
      // User hasn't set a password yet — show the set-password form
      pendingUsername = data.username;
      hide($('#login-form'));
      show($('#set-password-form'));
      $('#set-password').focus();
    } else {
      token = data.token;
      currentUser = data.user;
      localStorage.setItem('pm_token', token);
      onAuth();
    }
  } catch (err) {
    flashMsg($('#login-msg'), err.message);
  }
});

// --- Logout ---
$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  token = null;
  currentUser = null;
  localStorage.removeItem('pm_token');
  onLogout();
});

// --- Set Password ---
$('#set-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#set-password').value;
  const confirmPassword = $('#set-password-confirm').value;

  if (password !== confirmPassword) {
    return flashMsg($('#set-password-msg'), 'Passwords do not match');
  }

  try {
    const data = await api('/api/set-password', { method: 'POST', body: JSON.stringify({ username: pendingUsername, password }) });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('pm_token', token);
    pendingUsername = null;
    onAuth();
  } catch (err) {
    flashMsg($('#set-password-msg'), err.message);
  }
});

// --- Back to Login ---
$('#back-to-login-btn').addEventListener('click', () => {
  hide($('#set-password-form'));
  show($('#login-form'));
  $('#set-password').value = '';
  $('#set-password-confirm').value = '';
  $('#set-password-msg').textContent = '';
  pendingUsername = null;
});

// --- Create Market ---
$('#market-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#market-title').value.trim();
  const description = $('#market-desc').value.trim();
  const min_stake = parseInt($('#market-min').value) || 1;
  const max_stake = $('#market-max').value ? parseInt($('#market-max').value) : null;
  try {
    await api('/api/markets', { method: 'POST', body: JSON.stringify({ title, description, min_stake, max_stake }) });
    flashMsg($('#market-msg'), 'Market created!', 'success');
    $('#market-form').reset();
    hide($('#create-market'));
    show($('#new-market-btn'));
    loadMarkets();
  } catch (err) {
    flashMsg($('#market-msg'), err.message);
  }
});

// --- Admin Top Up ---
$('#topup-btn').addEventListener('click', async () => {
  try {
    const data = await api('/admin/topup', { method: 'POST' });
    flashMsg($('#admin-msg'), `Topped up ${data.users_updated} users.`, 'success');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    flashMsg($('#admin-msg'), err.message);
  }
});

// --- Admin Create User ---
$('#create-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#new-username').value.trim();
  const role = $('#new-role').value;
  try {
    await api('/admin/users', { method: 'POST', body: JSON.stringify({ username, role }) });
    flashMsg($('#create-user-msg'), `User "${username}" created! They'll set their own password on first login.`, 'success');
    $('#create-user-form').reset();
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    flashMsg($('#create-user-msg'), err.message);
  }
});

// --- Pool Probability Helper ---
function poolPercent(yesPool, noPool, side) {
  const total = yesPool + noPool;
  if (total === 0) return '50';
  const pct = side === 'yes' ? yesPool : noPool;
  return Math.round((pct / total) * 100);
}

// --- Toggle Create Market ---
$('#new-market-btn').addEventListener('click', () => {
  hide($('#new-market-btn'));
  show($('#create-market'));
  $('#market-title').focus();
});
$('#close-create-market').addEventListener('click', () => {
  hide($('#create-market'));
});

// --- Toggle Voters ---
window.toggleVoters = async function(marketId, button) {
  const content = document.getElementById(`voters-${marketId}`);
  const isExpanded = button.classList.contains('expanded');
  
  if (isExpanded) {
    button.classList.remove('expanded');
    content.classList.remove('expanded');
    return;
  }

  // Load voter data if not already loaded
  if (!content.dataset.loaded) {
    try {
      const data = await api(`/api/markets/${marketId}/bets`);
      const yesHtml = data.yes_voters.length 
        ? renderVoterList(data.yes_voters)
        : '<div class="voter-empty">No bets yet</div>';
      const noHtml = data.no_voters.length
        ? renderVoterList(data.no_voters)
        : '<div class="voter-empty">No bets yet</div>';
      
      content.innerHTML = `
        <div class="voters-side">
          <div class="voters-side-header voters-side-yes">Yes (${data.yes_voters.length})</div>
          ${yesHtml}
        </div>
        <div class="voters-side">
          <div class="voters-side-header voters-side-no">No (${data.no_voters.length})</div>
          ${noHtml}
        </div>`;
      content.dataset.loaded = 'true';
    } catch (err) {
      content.innerHTML = '<div class="voter-empty">Failed to load voters</div>';
    }
  }
  
  button.classList.add('expanded');
  content.classList.add('expanded');
};

// --- Render Markets ---
function renderMarkets(markets) {
  const container = $('#markets-list');
  if (!markets.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <div class="empty-state-text">No active markets yet</div>
        <button class="btn btn-primary" onclick="$('#new-market-btn').click()">Create First Market</button>
      </div>`;
    return;
  }

  const yesPct = (m) => poolPercent(m.yes_pool, m.no_pool, 'yes');
  const noPct = (m) => poolPercent(m.yes_pool, m.no_pool, 'no');

  container.innerHTML = markets.map((m) => {
    const resolved = m.resolved === 1;
    const badge = resolved
      ? `<span class="resolved-badge resolved-${m.resolution}">Resolved: ${m.resolution.toUpperCase()}</span>`
      : '';

    const betSection = resolved
      ? ''
      : `
        <div class="bet-row">
          <input type="number" id="bet-amount-${m.id}" min="${m.min_stake}" placeholder="Amount" />
          <div class="quick-bet">
            <button class="quick-bet-btn" onclick="document.getElementById('bet-amount-${m.id}').value=10">10</button>
            <button class="quick-bet-btn" onclick="document.getElementById('bet-amount-${m.id}').value=50">50</button>
            <button class="quick-bet-btn" onclick="document.getElementById('bet-amount-${m.id}').value=100">100</button>
          </div>
          <button class="btn btn-sm btn-yes" onclick="placeBet(${m.id}, 'yes')">Bet Yes</button>
          <button class="btn btn-sm btn-no" onclick="placeBet(${m.id}, 'no')">Bet No</button>
        </div>
        <span class="bet-hint">Min ${m.min_stake}${m.max_stake ? ` / Max ${m.max_stake}` : ''}</span>`;

    const resolveSection = resolved
      ? ''
      : (currentUser && currentUser.role === 'admin'
        ? `<div class="resolve-row">
            <button class="btn btn-sm btn-yes" onclick="resolveMarket(${m.id}, 'yes')">Resolve Yes</button>
            <button class="btn btn-sm btn-no" onclick="resolveMarket(${m.id}, 'no')">Resolve No</button>
           </div>`
        : '');

    const betCountBadge = m.bet_count > 0 ? `<span class="bet-count-badge">${m.bet_count} bet${m.bet_count !== 1 ? 's' : ''}</span>` : '';
    const timeAgoLabel = m.created_at ? timeAgo(m.created_at) : '';

    return `
      <div class="market-card">
        <div class="market-header">
          <span class="market-title">${esc(m.title)}</span>
          <div class="market-header-right">
            ${betCountBadge}
            ${badge}
          </div>
        </div>
        ${m.description ? `<div class="market-desc">${esc(m.description)}</div>` : ''}
        <div class="market-meta">
          <span class="creator-icon">${esc(m.creator_username[0].toUpperCase())}</span>
          <span class="creator-label">Created by</span>
          <span class="creator-name">${esc(m.creator_username)}</span>
          <span class="market-meta-spacer"></span>
          <span class="market-time">${timeAgoLabel}</span>
        </div>
        <div class="probability-bar">
          <div class="probability-bar-yes" style="width:${yesPct(m)}%"></div>
          <div class="probability-bar-no"></div>
        </div>
        <div class="probability-labels">
          <span class="prob-label prob-yes">Yes ${yesPct(m)}%</span>
          <span class="prob-label prob-no">No ${noPct(m)}%</span>
        </div>
        <div class="pools">
          <div class="pool pool-yes">
            <span class="pool-label">Yes Pool</span>
            <span class="pool-amount">${m.yes_pool}</span>
          </div>
          <div class="pool pool-no">
            <span class="pool-label">No Pool</span>
            <span class="pool-amount">${m.no_pool}</span>
          </div>
        </div>
        <div class="voters-section">
          <button class="voters-toggle" onclick="toggleVoters(${m.id}, this)">👥 See voters</button>
          <div class="voters-content" id="voters-${m.id}">
            <div class="voters-loading">Loading...</div>
          </div>
        </div>
        ${betSection}
        ${resolveSection}
      </div>`;
  }).join('');
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// --- Render Bet History ---
function renderBetHistory(bets) {
  const container = $('#history-list');
  if (!bets.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎲</div>
        <div class="empty-state-text">No bets yet. Place one on the Markets page!</div>
      </div>`;
    return;
  }

  container.innerHTML = bets.map((b) => {
    const sideClass = b.side === 'yes' ? 'pool-yes' : 'pool-no';
    const resolvedBadge = b.resolved === 1
      ? `<span class="resolved-badge resolved-${b.resolution}">Resolved: ${b.resolution.toUpperCase()}</span>`
      : '<span class="resolved-badge">Open</span>';

    return `
      <div class="history-card">
        <div class="history-header">
          <span class="history-market">${esc(b.market_title)}</span>
          ${resolvedBadge}
        </div>
        <div class="history-details">
          <span class="history-side ${sideClass}">${b.side.toUpperCase()}</span>
          <span class="history-amount">${b.amount} tokens</span>
          <span class="history-date">${new Date(b.created_at * 1000).toLocaleString()}</span>
        </div>
      </div>`;
  }).join('');
}

// --- Place Bet ---
window.placeBet = async function (marketId, side) {
  const input = $(`#bet-amount-${marketId}`);
  const amount = parseInt(input.value);
  if (!amount || amount <= 0) return showToast('Enter a valid amount');

  try {
    const data = await api('/api/bet', { method: 'POST', body: JSON.stringify({ market_id: marketId, side, amount }) });
    currentUser.tokens = data.user.tokens;
    updateUserBar();
    loadMarkets();
    showToast(`Bet placed: ${amount} tokens on ${side.toUpperCase()}`, 'success');
  } catch (err) {
    showToast(err.message);
  }
};

// --- Resolve Market ---
window.resolveMarket = async function (marketId, resolution) {
  if (!confirm(`Resolve this market as ${resolution.toUpperCase()}?`)) return;
  try {
    await api('/api/resolve', { method: 'POST', body: JSON.stringify({ market_id: marketId, resolution }) });
    loadMarkets();
    if (currentUser) api('/api/me').then((u) => { currentUser = u; updateUserBar(); });
    showToast(`Market resolved as ${resolution.toUpperCase()}`, 'success');
  } catch (err) {
    showToast(err.message);
  }
};

// --- Nav Click Handlers ---
$$('.nav-link').forEach((btn) => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

// --- Load Data ---
async function loadMarkets() {
  try {
    const markets = await api('/api/markets?type=active');
    renderMarkets(markets);
  } catch {
    renderMarkets([]);
  }
}

async function loadLegacyMarkets() {
  try {
    const markets = await api('/api/markets?type=resolved');
    renderMarketsLegacy(markets);
  } catch {
    renderMarketsLegacy([]);
  }
}

async function loadLeaderboard() {
  try {
    const users = await api('/api/leaderboard');
    renderLeaderboard(users);
  } catch {
    $('#leaderboard-list').innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:2rem;">Failed to load leaderboard.</p>';
  }
}

async function loadBetHistory() {
  try {
    const bets = await api('/api/history');
    renderBetHistory(bets);
  } catch (err) {
    $('#history-list').innerHTML = `<p style="color:var(--text-dim);text-align:center;padding:2rem;">Failed to load history: ${esc(err.message)}</p>`;
  }
}

async function loadAdminUsers() {
  try {
    const users = await api('/admin/users');
    const tbody = $('#users-table tbody');
    tbody.innerHTML = users.map((u) => {
      const statusBadge = u.must_set_password === 1
        ? '<span class="status-badge status-pending">⏳ Needs setup</span>'
        : '<span class="status-badge status-active">✓ Active</span>';

      const newRole = u.role === 'admin' ? 'user' : 'admin';
      const roleLabel = u.role === 'admin' ? 'Make User' : 'Make Admin';

      return `<tr>
        <td data-label="ID">${u.id}</td>
        <td data-label="Username">${esc(u.username)}</td>
        <td data-label="Role">${u.role}</td>
        <td data-label="Tokens">${u.tokens}</td>
        <td data-label="Status">${statusBadge}</td>
        <td class="actions-cell" data-label="Actions">
          <button class="btn btn-sm btn-outline action-btn" onclick="resetPassword(${u.id}, '${esc(u.username)}')" title="Reset password">Reset PW</button>
          <button class="btn btn-sm btn-outline action-btn" onclick="changeRole(${u.id}, '${newRole}', '${roleLabel}')" title="${roleLabel}">${roleLabel}</button>
          <button class="btn btn-sm btn-outline action-btn btn-danger-outline" onclick="deleteUser(${u.id}, '${esc(u.username)}')" title="Delete user">Delete</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

// --- Admin: Reset Password ---
window.resetPassword = async function (userId, username) {
  if (!confirm(`Reset password for "${username}"? They'll need to set a new password on next login.`)) return;
  try {
    await api(`/admin/users/${userId}/reset-password`, { method: 'POST' });
    showToast('Password reset for ' + username, 'success');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    showToast(err.message);
  }
};

// --- Admin: Change Role ---
window.changeRole = async function (userId, newRole, label) {
  if (!confirm(`Change this user's role to "${newRole}"?`)) return;
  try {
    await api(`/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ role: newRole }) });
    showToast('Role updated to ' + newRole, 'success');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    showToast(err.message);
  }
};

// --- Admin: Delete User ---
window.deleteUser = async function (userId, username) {
  if (!confirm(`Delete user "${username}"? This will also remove their bets and markets.`)) return;
  try {
    await api(`/admin/users/${userId}`, { method: 'DELETE' });
    showToast('User "' + username + '" deleted', 'success');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    showToast(err.message);
  }
};

async function loadAdminStats() {
  try {
    const stats = await api('/admin/stats');
    const statsEl = $('#admin-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="stat-item"><span class="stat-value">${stats.total_users}</span><span class="stat-label">Users</span></div>
        <div class="stat-item"><span class="stat-value">${stats.total_markets}</span><span class="stat-label">Markets</span></div>
        <div class="stat-item"><span class="stat-value">${stats.active_markets}</span><span class="stat-label">Active</span></div>
        <div class="stat-item"><span class="stat-value">${stats.total_bets}</span><span class="stat-label">Bets</span></div>
        <div class="stat-item"><span class="stat-value">${stats.total_volume}</span><span class="stat-label">Volume</span></div>
        <div class="stat-item"><span class="stat-value">${stats.total_tokens}</span><span class="stat-label">Tokens</span></div>
      `;
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// --- Render Leaderboard ---
function renderLeaderboard(users) {
  const container = $('#leaderboard-list');
  if (!users.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🏆</div>
        <div class="empty-state-text">No users on the leaderboard yet</div>
      </div>`;
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  container.innerHTML = users.map((u, i) => {
    const rank = i < 3 ? medals[i] : `#${i + 1}`;
    const isCurrentUser = currentUser && currentUser.id === u.id;
    const highlight = isCurrentUser ? ' style="border-color:var(--primary);background:rgba(108,92,231,0.08);" class="highlight"' : '';
    return `
      <div class="leaderboard-row"${highlight}>
        <span class="leaderboard-rank">${rank}</span>
        <span class="leaderboard-name">${esc(u.username)}${isCurrentUser ? ' (You)' : ''}</span>
        <span class="leaderboard-tokens">${u.tokens} tokens</span>
      </div>`;
  }).join('');
}

// --- Render Legacy Markets (simplified, no betting) ---
function renderMarketsLegacy(markets) {
  const container = $('#legacy-list');
  if (!markets.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📜</div>
        <div class="empty-state-text">No resolved markets yet</div>
      </div>`;
    return;
  }

  const yesPct = (m) => poolPercent(m.yes_pool, m.no_pool, 'yes');
  const noPct = (m) => poolPercent(m.yes_pool, m.no_pool, 'no');

  container.innerHTML = markets.map((m) => {
    const badge = `<span class="resolved-badge resolved-${m.resolution}">Resolved: ${m.resolution.toUpperCase()}</span>`;
    const betCountBadge = m.bet_count > 0 ? `<span class="bet-count-badge">${m.bet_count} bet${m.bet_count !== 1 ? 's' : ''}</span>` : '';
    const timeAgoLabel = m.created_at ? timeAgo(m.created_at) : '';
    return `
      <div class="market-card">
        <div class="market-header">
          <span class="market-title">${esc(m.title)}</span>
          <div class="market-header-right">
            ${betCountBadge}
            ${badge}
          </div>
        </div>
        ${m.description ? `<div class="market-desc">${esc(m.description)}</div>` : ''}
        <div class="market-meta">
          <span class="creator-icon">${esc(m.creator_username[0].toUpperCase())}</span>
          <span class="creator-label">Created by</span>
          <span class="creator-name">${esc(m.creator_username)}</span>
          <span class="market-meta-spacer"></span>
          <span class="market-time">${timeAgoLabel}</span>
        </div>
        <div class="probability-bar">
          <div class="probability-bar-yes" style="width:${yesPct(m)}%"></div>
          <div class="probability-bar-no"></div>
        </div>
        <div class="probability-labels">
          <span class="prob-label prob-yes">Yes ${yesPct(m)}%</span>
          <span class="prob-label prob-no">No ${noPct(m)}%</span>
        </div>
        <div class="pools">
          <div class="pool pool-yes">
            <span class="pool-label">Yes Pool</span>
            <span class="pool-amount">${m.yes_pool}</span>
          </div>
          <div class="pool pool-no">
            <span class="pool-label">No Pool</span>
            <span class="pool-amount">${m.no_pool}</span>
          </div>
        </div>
        <div class="voters-section">
          <button class="voters-toggle" onclick="toggleVoters(${m.id}, this)">👥 See voters</button>
          <div class="voters-content" id="voters-${m.id}">
            <div class="voters-loading">Loading...</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

// --- Navigation ---
function navigateTo(page) {
  currentPage = page;
  $$('.nav-link').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  $$('.page').forEach((section) => hide(section));

  if (page === 'markets') {
    show($('#markets-section'));
    show($('#new-market-btn'));
    hide($('#create-market'));
    loadMarkets();
  } else if (page === 'legacy') {
    show($('#legacy-section'));
    hide($('#new-market-btn'));
    loadLegacyMarkets();
  } else if (page === 'leaderboard') {
    show($('#leaderboard-section'));
    hide($('#create-market'));
    hide($('#new-market-btn'));
    loadLeaderboard();
  } else if (page === 'history') {
    show($('#history-section'));
    hide($('#create-market'));
    hide($('#new-market-btn'));
    loadBetHistory();
  } else if (page === 'admin') {
    show($('#admin-panel'));
    hide($('#create-market'));
    hide($('#new-market-btn'));
    loadAdminUsers();
    loadAdminStats();
  }
}

// --- UI State ---
function updateUserBar() {
  if (!currentUser) return;
  $('#user-tokens').textContent = `🪙 ${currentUser.tokens}`;
  const adminBadge = currentUser.role === 'admin' ? ' <span style="color:var(--warning);font-size:0.7rem;">(Admin)</span>' : '';
  $('#user-name').innerHTML = `${currentUser.username}${adminBadge}`;
}

function onAuth() {
  hide($('#auth-panel'));
  show($('#user-bar'));
  show($('#nav-bar'));
  updateUserBar();

  // Show admin nav link for admins
  $$('.admin-only').forEach((el) => {
    if (currentUser.role === 'admin') show(el);
    else hide(el);
  });

  navigateTo('markets');
}

function onLogout() {
  show($('#auth-panel'));
  show($('#login-form'));
  hide($('#set-password-form'));
  hide($('#create-market'));
  hide($('#new-market-btn'));
  hide($('#user-bar'));
  hide($('#nav-bar'));
  hide($('#admin-panel'));
  hide($('#markets-section'));
  hide($('#history-section'));
  pendingUsername = null;
}

// --- Init ---
async function init() {
  if (token) {
    try {
      currentUser = await api('/api/me');
      onAuth();
    } catch {
      onLogout();
    }
  }
}

init();
