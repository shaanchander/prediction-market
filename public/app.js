// --- State ---
let token = localStorage.getItem('pm_token');
let currentUser = null;
let currentPage = 'markets';
let pendingUsername = null; // username waiting to set password

// --- Live Polling ---
let pollingInterval = null;
const POLL_INTERVAL_MS = 10000; // 10 seconds

function startPolling() {
  stopPolling();
  pollingInterval = setInterval(pollUpdates, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

async function pollUpdates() {
  if (!token || !currentUser) return;

  // Update token balance
  try {
    const user = await api('/api/me');
    if (user.tokens !== currentUser.tokens) {
      currentUser.tokens = user.tokens;
      updateUserBar();
    }
  } catch {}

  // Update market pools if on markets page
  if (currentPage === 'markets') {
    try {
      const search = $('#market-search')?.value.trim() || '';
      const params = new URLSearchParams({ type: 'active' });
      if (search) params.set('search', search);
      const markets = await api(`/api/markets?${params}`);
      updateMarketsInPlace(markets);
    } catch {}
  }
}

// Update market cards without full re-render (preserves expanded voter panels)
function updateMarketsInPlace(markets) {
  const marketMap = {};
  markets.forEach(m => { marketMap[m.id] = m; });

  // Update each market card that exists in the DOM
  markets.forEach(m => {
    const card = document.querySelector(`.market-card[data-market-id="${m.id}"]`);
    if (!card) return;

    // Update probability bar
    const yesPct = poolPercent(m.yes_pool, m.no_pool, 'yes');
    const noPct = poolPercent(m.yes_pool, m.no_pool, 'no');
    const barYes = card.querySelector('.probability-bar-yes');
    if (barYes) barYes.style.width = yesPct + '%';

    const probYes = card.querySelector('.prob-yes');
    if (probYes) probYes.textContent = `Yes ${yesPct}%`;
    const probNo = card.querySelector('.prob-no');
    if (probNo) probNo.textContent = `No ${noPct}%`;

    // Update pool amounts
    const poolYes = card.querySelector('.pool-yes .pool-amount');
    if (poolYes) poolYes.textContent = m.yes_pool;
    const poolNo = card.querySelector('.pool-no .pool-amount');
    if (poolNo) poolNo.textContent = m.no_pool;

    // Update bet count badge
    const badge = card.querySelector('.bet-count-badge');
    if (badge) {
      badge.textContent = m.bet_count + (m.bet_count !== 1 ? ' bets' : ' bet');
    }
  });

  // Check if markets were added or removed — full re-render if count mismatch
  const existingCards = document.querySelectorAll('.market-card[data-market-id]');
  if (existingCards.length !== markets.length) {
    loadMarkets();
  }
}

// Add data-market-id to market cards (called during initial render)
// This is handled in renderMarkets below.

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

// --- Network Error Banner ---
function showNetworkBanner(message) {
  const banner = $('#network-banner');
  $('#network-banner-msg').textContent = message;
  show(banner);
}

function hideNetworkBanner() {
  hide($('#network-banner'));
}

// --- Helper to check if error is a network error ---
function isNetworkError(err) {
  if (!err) return false;
  return err.message === 'Failed to fetch' || 
         err.message === 'NetworkError when attempting to fetch resource' ||
         err.message.includes('Network') ||
         err.type === 'network';
}

// --- Network Event Listeners ---
$('#network-banner-close').addEventListener('click', hideNetworkBanner);

window.addEventListener('offline', () => {
  showNetworkBanner('⚠️ You are offline. Changes will not sync until you reconnect.');
});

window.addEventListener('online', () => {
  hideNetworkBanner();
  showToast('Connection restored', 'success');
});

// --- Custom Confirmation Modal ---
let confirmResolve = null;

function showConfirmModal(title, message) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('#confirm-modal-title').textContent = title;
    $('#confirm-modal-message').textContent = message;
    show($('#confirm-modal'));
    $('#confirm-modal-ok').focus();
  });
}

$('#confirm-modal-ok').addEventListener('click', () => {
  hide($('#confirm-modal'));
  if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
});

$('#confirm-modal-cancel').addEventListener('click', () => {
  hide($('#confirm-modal'));
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
});

// --- Custom Prompt Modal ---
let promptResolve = null;

function showPromptModal(title, label, defaultValue, isTextarea = false) {
  return new Promise((resolve) => {
    promptResolve = resolve;
    $('#prompt-modal-title').textContent = title;
    $('#prompt-modal-label').textContent = label;
    const input = $('#prompt-modal-input');
    const textarea = $('#prompt-modal-textarea');
    if (isTextarea) {
      hide(input);
      show(textarea);
      textarea.value = defaultValue || '';
      textarea.focus();
    } else {
      show(input);
      hide(textarea);
      input.value = defaultValue || '';
      input.focus();
    }
    show($('#prompt-modal'));
  });
}

$('#prompt-modal-ok').addEventListener('click', () => {
  const value = $('#prompt-modal-input').classList.contains('hidden')
    ? $('#prompt-modal-textarea').value
    : $('#prompt-modal-input').value;
  hide($('#prompt-modal'));
  if (promptResolve) { promptResolve(value); promptResolve = null; }
});

$('#prompt-modal-cancel').addEventListener('click', () => {
  hide($('#prompt-modal'));
  if (promptResolve) { promptResolve(null); promptResolve = null; }
});

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  // Escape closes modals
  if (e.key === 'Escape') {
    if (!$('#confirm-modal').classList.contains('hidden')) {
      $('#confirm-modal-cancel').click();
      return;
    }
    if (!$('#prompt-modal').classList.contains('hidden')) {
      $('#prompt-modal-cancel').click();
      return;
    }
    // Close create market form
    if (!$('#create-market-sheet-overlay').classList.contains('hidden')) {
      hide($('#create-market-sheet-overlay'));
      return;
    }
  }
  // Ctrl+K / Cmd+K focuses search
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const searchInput = $('#market-search');
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }
});

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
      <span class="voter-name clickable-username" data-username="${esc(v.username)}">${esc(v.username)}</span>
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
    })
    .catch(err => {
      if (isNetworkError(err)) {
        showNetworkBanner('⚠️ Cannot reach server. Check connection and try again.');
      }
      throw err;
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
      $('#login-form').reset();
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
  const expires_at = $('#market-expires').value || null;
  try {
    await api('/api/markets', { method: 'POST', body: JSON.stringify({ title, description, min_stake, max_stake, expires_at }) });
    showToast('Market created!', 'success');
    const overlay = $('#create-market-sheet-overlay');
    overlay.classList.remove('bet-sheet-open');
    setTimeout(() => {
      overlay.classList.add('hidden');
      $('#market-form').reset();
    }, 250);
    loadMarkets();
  } catch (err) {
    flashMsg($('#market-msg'), err.message);
  }
});

// --- Admin Top Up ---
$('#topup-btn').addEventListener('click', async () => {
  const amount = await showPromptModal('Top Up All Users', 'Token amount:', '50');
  if (amount === null) return;
  const parsed = parseInt(amount);
  if (!parsed || parsed <= 0) return flashMsg($('#admin-msg'), 'Enter a valid amount');
  try {
    const data = await api('/admin/topup', { method: 'POST', body: JSON.stringify({ amount: parsed }) });
    flashMsg($('#admin-msg'), `Topped up ${data.users_updated} users with ${parsed} tokens each.`, 'success');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    flashMsg($('#admin-msg'), err.message);
  }
});

// --- Admin Grant Tokens ---
function populateGrantUserSelect(users) {
  const select = $('#grant-user-select');
  select.innerHTML = '<option value="">— Select user —</option>';
  users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.username;
    opt.textContent = `${esc(u.username)} (${u.tokens} tokens)`;
    select.appendChild(opt);
  });
}

$('#grant-tokens-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#grant-user-select').value;
  const amount = parseInt($('#grant-amount').value);
  if (!username || !amount || amount <= 0) {
    return flashMsg($('#grant-tokens-msg'), 'Select a user and enter a valid amount');
  }
  try {
    const data = await api('/admin/grant-tokens', { method: 'POST', body: JSON.stringify({ username, amount }) });
    flashMsg($('#grant-tokens-msg'), `Granted ${amount} tokens to "${esc(username)}". New balance: ${data.new_balance}.`, 'success');
    $('#grant-tokens-form').reset();
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    flashMsg($('#grant-tokens-msg'), err.message);
  }
});

// --- Admin User Search & Sort ---
let adminUsersData = [];
let adminUserSearchDebounce = null;

$('#admin-user-search')?.addEventListener('input', () => {
  clearTimeout(adminUserSearchDebounce);
  adminUserSearchDebounce = setTimeout(renderAdminUsersTable, 200);
});
$('#admin-user-sort')?.addEventListener('change', renderAdminUsersTable);

function renderAdminUsersTable() {
  const search = ($('#admin-user-search')?.value || '').trim().toLowerCase();
  const sort = $('#admin-user-sort')?.value || 'tokens-desc';

  let filtered = adminUsersData.filter(u => u.username.toLowerCase().includes(search));

  filtered.sort((a, b) => {
    if (sort === 'tokens-desc') return b.tokens - a.tokens;
    if (sort === 'tokens-asc') return a.tokens - b.tokens;
    if (sort === 'name-asc') return a.username.localeCompare(b.username);
    return b.username.localeCompare(a.username);
  });

  const tbody = $('#users-table tbody');
  tbody.innerHTML = filtered.map((u) => {
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
        <button class="btn btn-sm btn-outline action-btn admin-reset-pw-btn" data-user-id="${u.id}" data-user-name="${esc(u.username)}" title="Reset password">Reset PW</button>
        <button class="btn btn-sm btn-outline action-btn admin-change-role-btn" data-user-id="${u.id}" data-new-role="${newRole}" data-role-label="${esc(roleLabel)}" title="${esc(roleLabel)}">${roleLabel}</button>
        <button class="btn btn-sm btn-outline action-btn btn-danger-outline admin-delete-user-btn" data-user-id="${u.id}" data-user-name="${esc(u.username)}" title="Delete user">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

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

// --- Expiry Preset Buttons ---
$$('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $('#market-expires');
    if (btn.classList.contains('preset-clear')) {
      input.value = '';
    } else {
      const hours = parseInt(btn.dataset.hours);
      const d = new Date(Date.now() + hours * 60 * 60 * 1000);
      // Format as datetime-local value (YYYY-MM-DDTHH:MM) in local time
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      const h = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      input.value = `${y}-${mo}-${da}T${h}:${mi}`;
    }
    // Toggle hint visibility
    const hint = document.querySelector('.datetime-hint');
    if (hint) hint.classList.toggle('hidden', !!input.value);
  });
});

// Watch for manual changes to the datetime picker
$('#market-expires')?.addEventListener('input', () => {
  const hint = document.querySelector('.datetime-hint');
  if (hint) hint.classList.toggle('hidden', !!$('#market-expires').value);
});

// --- Toggle Create Market ---
$('#new-market-btn').addEventListener('click', () => {
  const overlay = $('#create-market-sheet-overlay');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    overlay.classList.add('bet-sheet-open');
  });
  setTimeout(() => $('#market-title')?.focus(), 300);
});
$('#close-create-market').addEventListener('click', () => {
  const overlay = $('#create-market-sheet-overlay');
  overlay.classList.remove('bet-sheet-open');
  setTimeout(() => overlay.classList.add('hidden'), 250);
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

// --- Format expiry time for display ---
function formatExpiry(expiresAt) {
  if (!expiresAt) return null;
  const now = Date.now();
  const diff = expiresAt * 1000 - now;

  // Check if expired
  const isExpired = diff <= 0;
  if (isExpired) return { text: 'Expired', expired: true, urgent: false };

  // Check if urgent (< 1 hour)
  const urgent = diff < 60 * 60 * 1000;

  // Time remaining
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return { text: `Expires in ${days}d ${hours % 24}h`, expired: false, urgent: false };
  }
  if (hours > 0) return { text: `Expires in ${hours}h`, expired: false, urgent: urgent };
  const minutes = Math.floor(diff / (1000 * 60));
  return { text: `Expires in ${minutes}m`, expired: false, urgent: true };
}

// --- Market Actions (edit/delete) ---
function renderMarketActions(m) {
  const isCreator = currentUser && m.creator_username === currentUser.username;
  const isAdmin = currentUser && currentUser.role === 'admin';
  if (!isCreator && !isAdmin) return '';
  if (m.resolved === 1) return '';
  const expiresAtStr = m.expires_at ? new Date(m.expires_at * 1000).toISOString().slice(0, 16) : '';
  // Use data attributes instead of onclick to avoid XSS via inline handlers
  return `
    <div class="market-actions">
      <button class="btn btn-sm btn-outline action-btn edit-market-btn" data-market-id="${m.id}" data-market-title="${esc(m.title)}" data-market-desc="${esc(m.description)}" data-market-expires="${esc(expiresAtStr)}">Edit</button>
      <button class="btn btn-sm btn-outline action-btn btn-danger-outline delete-market-btn" data-market-id="${m.id}" data-market-title="${esc(m.title)}">Delete</button>
    </div>`;
}

// --- Event delegation for market action buttons ---
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('edit-market-btn')) {
    const marketId = parseInt(e.target.dataset.marketId);
    const title = e.target.dataset.marketTitle;
    const description = e.target.dataset.marketDesc;
    const expiresAt = e.target.dataset.marketExpires;
    editMarket(marketId, title, description, expiresAt);
  }
  if (e.target.classList.contains('delete-market-btn')) {
    const marketId = parseInt(e.target.dataset.marketId);
    const title = e.target.dataset.marketTitle;
    deleteMarket(marketId, title);
  }
  // Clickable usernames
  if (e.target.classList.contains('clickable-username')) {
    const username = e.target.dataset.username;
    showUserProfile(username);
    return;
  }
  // Admin user table buttons
  if (e.target.classList.contains('admin-reset-pw-btn')) {
    const userId = parseInt(e.target.dataset.userId);
    const username = e.target.dataset.userName;
    resetPassword(userId, username);
  }
  if (e.target.classList.contains('admin-change-role-btn')) {
    const userId = parseInt(e.target.dataset.userId);
    const newRole = e.target.dataset.newRole;
    const roleLabel = e.target.dataset.roleLabel;
    changeRole(userId, newRole, roleLabel);
  }
  if (e.target.classList.contains('admin-delete-user-btn')) {
    const userId = parseInt(e.target.dataset.userId);
    const username = e.target.dataset.userName;
    deleteUser(userId, username);
  }
});

// --- Render Markets ---
function renderMarkets(markets, emptyIcon = '📊', emptyText = 'No active markets yet') {
  const container = $('#markets-list');
  if (!markets.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${emptyIcon}</div>
        <div class="empty-state-text">${emptyText}</div>
        ${emptyText.includes('active') ? '<button class="btn btn-primary" onclick="$(\'#new-market-btn\').click()">Create First Market</button>' : ''}
      </div>`;
    return;
  }

  const yesPct = (m) => poolPercent(m.yes_pool, m.no_pool, 'yes');
  const noPct = (m) => poolPercent(m.yes_pool, m.no_pool, 'no');

  container.innerHTML = markets.map((m) => {
    const resolved = m.resolved === 1;
    const expiryInfo = formatExpiry(m.expires_at);
    const isExpired = expiryInfo && expiryInfo.expired;

    const badge = resolved
      ? `<span class="resolved-badge resolved-${m.resolution}">Resolved: ${m.resolution.toUpperCase()}</span>`
      : '';
    const expiryClass = isExpired ? 'expiry-expired' : (expiryInfo?.urgent ? 'expiry-urgent' : 'expiry-active');
    const expiryBadge = expiryInfo
      ? `<span class="expiry-badge ${expiryClass}">${expiryInfo.text}</span>`
      : '';

    const betSection = resolved || isExpired
      ? (isExpired ? '<div class="expired-notice">⏱ Betting is closed — market has expired</div>' : '')
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
        <span class="bet-hint">Min ${m.min_stake}${m.max_stake ? ` / Max ${m.max_stake}` : ''}</span>
        <button class="btn btn-primary bet-sheet-trigger" onclick="openBetSheet(${m.id}, ${m.min_stake}, ${m.max_stake || 'null'}, '${esc(m.title)}')">Place Bet</button>`;

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
      <div class="market-card" data-market-id="${m.id}">
        <div class="market-header">
          <span class="market-title">${esc(m.title)}</span>
          <div class="market-header-right">
            ${betCountBadge}
            ${expiryBadge}
            ${badge}
          </div>
        </div>
        ${m.description ? `<div class="market-desc">${esc(m.description)}</div>` : ''}
        <div class="market-probability-row">
          <div class="market-probability-bar-wrap">
            <div class="market-probability-bar">
              <div class="market-probability-bar-yes" style="width:${yesPct(m)}%"></div>
            </div>
            <div class="market-probability-labels">
              <span class="prob-label prob-yes">Yes ${yesPct(m)}%</span>
              <span class="prob-label prob-no">No ${noPct(m)}%</span>
            </div>
          </div>
          <div class="market-pools-compact">
            <span class="pool-compact pool-yes-compact">🟢 ${m.yes_pool}</span>
            <span class="pool-compact pool-no-compact">🔴 ${m.no_pool}</span>
          </div>
        </div>
        <div class="market-meta">
          <span class="creator-icon">${esc(m.creator_username[0].toUpperCase())}</span>
          <span class="creator-name clickable-username" data-username="${esc(m.creator_username)}">${esc(m.creator_username)}</span>
          <span class="market-meta-spacer"></span>
          <span class="market-time">${timeAgoLabel}</span>
        </div>
        <div class="market-card-body">
          ${renderUserPosition(m.id)}
          ${renderMarketActions(m)}
          ${betSection}
          ${resolveSection}
        </div>
        <div class="voters-section">
          <button class="voters-toggle" onclick="toggleVoters(${m.id}, this)">👥 See voters${m.bet_count > 0 ? ` (${m.bet_count})` : ''}</button>
          <div class="voters-content" id="voters-${m.id}"></div>
        </div>
      </div>`;
  }).join('');
}

// Show user's current position on a market
function renderUserPosition(marketId) {
  const bet = userBetsMap[marketId];
  if (!bet) return '';
  // Determine dominant side for coloring
  const sideClass = bet.yes >= bet.no ? 'yes' : 'no';
  const parts = [];
  if (bet.yes > 0) parts.push(`${bet.yes} tokens on YES`);
  if (bet.no > 0) parts.push(`${bet.no} tokens on NO`);
  return `<div class="user-position user-position-${sideClass}">You bet ${parts.join(', ')}</div>`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// --- Render User Stats ---
function renderUserStats(bets) {
  const container = $('#user-stats');
  if (!bets.length) {
    container.innerHTML = '';
    return;
  }

  const totalBets = bets.length;
  const openBets = bets.filter(b => b.resolved !== 1).length;
  const resolvedBets = bets.filter(b => b.resolved === 1);
  const wins = resolvedBets.filter(b => b.won).length;
  const losses = resolvedBets.length - wins;
  const winRate = resolvedBets.length > 0 ? Math.round((wins / resolvedBets.length) * 100) : 0;

  // Calculate total profit/loss
  let totalStaked = 0;
  let totalReturned = 0;
  let biggestWin = 0;
  let biggestLoss = 0;

  bets.forEach(b => {
    totalStaked += b.amount;
    if (b.resolved === 1) {
      if (b.won) {
        totalReturned += b.payout;
        biggestWin = Math.max(biggestWin, b.profit);
      } else {
        biggestLoss = Math.max(biggestLoss, b.amount);
      }
    }
  });

  const netProfit = totalReturned - totalStaked;
  const profitClass = netProfit >= 0 ? 'stats-positive' : 'stats-negative';

  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-card-value">${totalBets}</div>
        <div class="stat-card-label">Total Bets</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${openBets}</div>
        <div class="stat-card-label">Open</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${wins}W / ${losses}L</div>
        <div class="stat-card-label">Record (${winRate}%)</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value ${profitClass}">${netProfit >= 0 ? '+' : ''}${netProfit}</div>
        <div class="stat-card-label">Net Profit/Loss</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value stats-positive">+${biggestWin}</div>
        <div class="stat-card-label">Biggest Win</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value stats-negative">-${biggestLoss}</div>
        <div class="stat-card-label">Biggest Loss</div>
      </div>
    </div>`;
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
    renderUserStats([]);
    return;
  }

  renderUserStats(bets);

  container.innerHTML = bets.map((b) => {
    const sideClass = b.side === 'yes' ? 'pool-yes' : 'pool-no';
    const resolvedBadge = b.resolved === 1
      ? `<span class="resolved-badge resolved-${b.resolution}">Resolved: ${b.resolution.toUpperCase()}</span>`
      : '<span class="resolved-badge">Open</span>';

    let payoutInfo = '';
    if (b.resolved === 1) {
      if (b.won) {
        payoutInfo = `
          <div class="payout-info payout-win">
            <span class="payout-label">Won</span>
            <span class="payout-amount">+${b.profit} tokens</span>
            <span class="payout-total">(received ${b.payout})</span>
          </div>`;
      } else {
        payoutInfo = `
          <div class="payout-info payout-loss">
            <span class="payout-label">Lost</span>
            <span class="payout-amount">-${b.amount} tokens</span>
          </div>`;
      }
    }

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
        ${payoutInfo}
      </div>`;
  }).join('');
}

// --- Edit Market ---
window.editMarket = async function (marketId, title, description, expiresAt) {
  const newTitle = await showPromptModal('Edit Market', 'Title:', title);
  if (newTitle === null) return;
  if (!newTitle.trim()) return showToast('Title cannot be empty');
  const newDesc = await showPromptModal('Edit Market', 'Description:', description, true);
  if (newDesc === null) return;
  // For expiry, show current value formatted for datetime-local input
  const currentExpiry = expiresAt ? new Date(expiresAt).toISOString().slice(0, 16) : '';
  const newExpiry = await showPromptModal('Edit Market', 'Expiry (datetime-local format, or leave blank to keep current):', currentExpiry);
  if (newExpiry === null) return;
  try {
    await api(`/api/markets/${marketId}`, { method: 'PATCH', body: JSON.stringify({ title: newTitle.trim(), description: newDesc, expires_at: newExpiry || null }) });
    loadMarkets();
    showToast('Market updated', 'success');
  } catch (err) {
    showToast(err.message);
  }
}

// --- Delete Market ---
window.deleteMarket = async function (marketId, title) {
  const confirmed = await showConfirmModal('Delete Market', `Delete market "${esc(title)}"? This will also remove all bets on it.`);
  if (!confirmed) return;
  try {
    await api(`/api/markets/${marketId}`, { method: 'DELETE' });
    loadMarkets();
    showToast('Market deleted', 'success');
  } catch (err) {
    showToast(err.message);
  }
};

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
    showToast(`✓ ${amount} on ${side.toUpperCase()} · Balance: ${data.user.tokens.toLocaleString()}`, 'success');
  } catch (err) {
    showToast(err.message);
  }
};

// --- Bet Bottom Sheet (mobile) ---
let currentBetMarketId = null;
let userBetsMap = {}; // market_id → { side, amount }

// Build a map of current user's open bets for display on market cards
async function loadUserBetsMap() {
  try {
    const bets = await api('/api/history');
    userBetsMap = {};
    bets.forEach(b => {
      if (b.resolved !== 1) {
        if (!userBetsMap[b.market_id]) {
          userBetsMap[b.market_id] = { yes: 0, no: 0 };
        }
        const side = b.side.toUpperCase();
        userBetsMap[b.market_id][side.toLowerCase()] += b.amount;
      }
    });
  } catch {}
}

window.openBetSheet = function (marketId, minStake, maxStake, title) {
  currentBetMarketId = marketId;
  $('#bet-sheet-title').textContent = title || 'Place Bet';
  $('#bet-sheet-amount').min = minStake;
  $('#bet-sheet-amount').value = '';
  const maxBet = Math.floor(currentUser.tokens * 0.2);
  let hint = 'Min ' + minStake;
  if (maxStake) hint += ' / Max ' + maxStake;
  hint += ' · Max bet: ' + maxBet + ' (20% of balance)';
  $('#bet-sheet-hint').textContent = hint;
  const overlay = $('#bet-sheet-overlay');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    overlay.classList.add('bet-sheet-open');
  });
};

window.closeBetSheet = function () {
  const overlay = $('#bet-sheet-overlay');
  overlay.classList.remove('bet-sheet-open');
  setTimeout(() => {
    overlay.classList.add('hidden');
    currentBetMarketId = null;
  }, 250);
};

// Sheet bet buttons
$('#bet-sheet-yes')?.addEventListener('click', async () => {
  const amount = parseInt($('#bet-sheet-amount').value);
  if (!amount || amount <= 0) return showToast('Enter a valid amount');
  try {
    const data = await api('/api/bet', { method: 'POST', body: JSON.stringify({ market_id: currentBetMarketId, side: 'yes', amount }) });
    currentUser.tokens = data.user.tokens;
    updateUserBar();
    loadMarkets();
    showToast(`✓ ${amount} on YES · Balance: ${data.user.tokens.toLocaleString()}`, 'success');
    closeBetSheet();
  } catch (err) {
    showToast(err.message);
  }
});

$('#bet-sheet-no')?.addEventListener('click', async () => {
  const amount = parseInt($('#bet-sheet-amount').value);
  if (!amount || amount <= 0) return showToast('Enter a valid amount');
  try {
    const data = await api('/api/bet', { method: 'POST', body: JSON.stringify({ market_id: currentBetMarketId, side: 'no', amount }) });
    currentUser.tokens = data.user.tokens;
    updateUserBar();
    loadMarkets();
    showToast(`✓ ${amount} on NO · Balance: ${data.user.tokens.toLocaleString()}`, 'success');
    closeBetSheet();
  } catch (err) {
    showToast(err.message);
  }
});

// Sheet close button
$('#bet-sheet-close')?.addEventListener('click', closeBetSheet);

// Close on overlay background tap
$('#bet-sheet-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'bet-sheet-overlay') closeBetSheet();
});

// Close create market sheet on overlay background tap
$('#create-market-sheet-overlay')?.addEventListener('click', (e) => {
  if (!e.target.closest('.bet-sheet')) {
    const overlay = $('#create-market-sheet-overlay');
    overlay.classList.remove('bet-sheet-open');
    setTimeout(() => overlay.classList.add('hidden'), 250);
  }
});

// --- Resolve Market ---
window.resolveMarket = async function (marketId, resolution) {
  const confirmed = await showConfirmModal('Resolve Market', `Resolve this market as ${resolution.toUpperCase()}? Payouts will be distributed immediately.`);
  if (!confirmed) return;
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
$$('.bottom-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

// --- Load Data ---
async function loadMarkets() {
  try {
    const search = $('#market-search')?.value.trim() || '';
    const sort = $('#market-sort')?.value || 'newest';
    const params = new URLSearchParams({ type: 'active' });
    if (search) params.set('search', search);
    let markets = await api(`/api/markets?${params}`);

    // Client-side sorting
    if (sort === 'oldest') markets.sort((a, b) => a.created_at - b.created_at);
    else if (sort === 'popular') markets.sort((a, b) => (b.bet_count || 0) - (a.bet_count || 0));

    await loadUserBetsMap();
    renderMarkets(markets, '📊', search ? 'No markets match your search' : 'No active markets yet');
  } catch (err) {
    if (!isNetworkError(err)) renderMarkets([]);
  }
}

async function loadLegacyMarkets() {
  try {
    const search = $('#legacy-search')?.value.trim() || '';
    const params = new URLSearchParams({ type: 'resolved' });
    if (search) params.set('search', search);
    let markets = await api(`/api/markets?${params}`);

    renderMarketsLegacy(markets, search ? 'No resolved markets match your search' : 'No resolved markets yet');
  } catch (err) {
    if (!isNetworkError(err)) renderMarketsLegacy([]);
  }
}

// --- Search & Sort Handlers ---
let searchDebounce = null;
$('#market-search')?.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadMarkets, 300);
});
$('#market-sort')?.addEventListener('change', loadMarkets);
let legacySearchDebounce = null;
$('#legacy-search')?.addEventListener('input', () => {
  clearTimeout(legacySearchDebounce);
  legacySearchDebounce = setTimeout(loadLegacyMarkets, 300);
});

async function loadLeaderboard() {
  try {
    const users = await api('/api/leaderboard');
    renderLeaderboard(users);
  } catch (err) {
    if (!isNetworkError(err)) {
      $('#leaderboard-list').innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:2rem;">Failed to load leaderboard.</p>';
    }
  }
}

async function loadBetHistory() {
  try {
    const bets = await api('/api/history');
    renderBetHistory(bets);
  } catch (err) {
    if (!isNetworkError(err)) {
      $('#history-list').innerHTML = `<p style="color:var(--text-dim);text-align:center;padding:2rem;">Failed to load history: ${esc(err.message)}</p>`;
    }
  }
}

async function loadAdminUsers() {
  try {
    adminUsersData = await api('/admin/users');
    renderAdminUsersTable();
    populateGrantUserSelect(adminUsersData);
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

// --- Admin: Reset Password ---
window.resetPassword = async function (userId, username) {
  const confirmed = await showConfirmModal('Reset Password', `Reset password for "${esc(username)}"? They'll need to set a new password on next login.`);
  if (!confirmed) return;
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
  const confirmed = await showConfirmModal('Change Role', `Change this user's role to "${esc(newRole)}"?`);
  if (!confirmed) return;
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
  const confirmed = await showConfirmModal('Delete User', `Delete user "${esc(username)}"? This will also remove their bets and markets.`);
  if (!confirmed) return;
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

// --- Admin: Backup ---
$('#backup-btn').addEventListener('click', async () => {
  try {
    const btn = $('#backup-btn');
    btn.textContent = 'Backing up...';
    btn.disabled = true;
    await api('/admin/backup', { method: 'POST' });
    showToast('Database backed up', 'success');
    loadBackupStatus();
  } catch (err) {
    showToast(err.message);
  } finally {
    const btn = $('#backup-btn');
    btn.textContent = 'Backup Database';
    btn.disabled = false;
  }
});

async function loadBackupStatus() {
  try {
    const data = await api('/admin/backup');
    const el = $('#backup-status');
    if (!data.backups.length) {
      el.textContent = 'No backups yet.';
      return;
    }
    const latest = data.backups[0];
    const date = new Date(latest.created).toLocaleString();
    el.textContent = `Last backup: ${date}`;
  } catch (err) {
    console.error('Failed to load backup status:', err);
  }
}

// --- Admin: Load market list for bets management ---
async function loadAdminMarketSelect() {
  try {
    const markets = await api('/api/markets?type=active');
    const select = $('#admin-market-select');
    select.innerHTML = '<option value="">— Select market —</option>';
    markets.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${esc(m.title)} (${m.bet_count || 0} bets)`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to load markets for admin:', err);
  }
}

// --- Admin: Load bets for selected market ---
$('#admin-load-bets-btn').addEventListener('click', async () => {
  const marketId = $('#admin-market-select').value;
  if (!marketId) return showToast('Select a market first');
  try {
    const data = await api(`/admin/markets/${marketId}/bets`);
    $('#admin-bets-market-title').textContent = data.market_title;
    renderAdminBets(data.bets, marketId);
    show($('#admin-bets-container'));
  } catch (err) {
    showToast(err.message);
  }
});

function renderAdminBets(bets, marketId) {
  const container = $('#admin-bets-list');
  if (!bets.length) {
    container.innerHTML = '<div class="voter-empty">No bets on this market</div>';
    return;
  }
  container.innerHTML = bets.map(b => `
    <div class="admin-bet-row">
      <span class="admin-bet-user">${esc(b.username)}</span>
      <span class="admin-bet-side ${b.side}">${b.side.toUpperCase()}</span>
      <span class="admin-bet-amount">${b.amount} tokens</span>
      <button class="btn btn-sm btn-outline admin-bet-refund-btn" onclick="adminRefundBet(${b.bet_id}, '${esc(b.username)}', ${b.amount})">Refund</button>
    </div>`).join('');
}

window.adminRefundBet = async function (betId, username, amount) {
  const confirmed = await showConfirmModal('Refund Bet', `Refund ${amount} tokens to ${esc(username)}?`);
  if (!confirmed) return;
  try {
    await api(`/admin/bets/${betId}/refund`, { method: 'POST' });
    showToast(`Refunded ${amount} tokens to ${esc(username)}`, 'success');
    // Reload bets list and market dropdown
    const marketId = $('#admin-market-select').value;
    if (marketId) {
      const data = await api(`/admin/markets/${marketId}/bets`);
      renderAdminBets(data.bets, marketId);
    }
    loadAdminStats();
    loadAdminMarketSelect();
  } catch (err) {
    showToast(err.message);
  }
};

// --- User Profile Modal ---
window.showUserProfile = async function(username) {
  try {
    const data = await api(`/api/users/${encodeURIComponent(username)}`);
    $('#profile-avatar').textContent = data.username[0].toUpperCase();
    $('#profile-username').textContent = data.username;
    
    const roleEl = $('#profile-role');
    if (data.role === 'admin') {
      roleEl.textContent = 'Admin';
      roleEl.className = 'profile-role profile-role-admin';
    } else {
      roleEl.textContent = '';
      roleEl.className = 'profile-role';
    }

    $('#profile-tokens').textContent = data.tokens.toLocaleString();
    $('#profile-total-bets').textContent = data.totalBets;
    $('#profile-open-bets').textContent = data.openBets;
    $('#profile-record').textContent = `${data.wins}W / ${data.losses}L (${data.winRate}%)`;
    
    const profitEl = $('#profile-profit');
    profitEl.textContent = (data.netProfit >= 0 ? '+' : '') + data.netProfit;
    profitEl.className = data.netProfit >= 0 ? 'profile-stat-value stats-positive' : 'profile-stat-value stats-negative';
    
    $('#profile-biggest-win').textContent = '+' + data.biggestWin;
    $('#profile-biggest-win').className = 'profile-stat-value stats-positive';
    $('#profile-biggest-loss').textContent = '-' + data.biggestLoss;
    $('#profile-biggest-loss').className = 'profile-stat-value stats-negative';
    
    const joinedEl = $('#profile-joined');
    if (data.joinedAt) {
      joinedEl.textContent = new Date(data.joinedAt * 1000).toLocaleDateString();
    } else {
      joinedEl.textContent = '—';
    }

    show($('#profile-modal'));
  } catch (err) {
    showToast(err.message);
  }
};

$('#profile-modal-close').addEventListener('click', () => {
  hide($('#profile-modal'));
});

// Close profile modal on overlay click
$('#profile-modal')?.addEventListener('click', (e) => {
  if (e.target === $('#profile-modal')) hide($('#profile-modal'));
});

// --- Admin: Refund all bets and delete market ---
$('#admin-refund-delete-btn').addEventListener('click', async () => {
  const marketId = $('#admin-market-select').value;
  if (!marketId) return showToast('Select a market first');
  const select = $('#admin-market-select');
  const marketTitle = select.options[select.selectedIndex].text;
  const confirmed = await showConfirmModal('Refund All & Delete', `This will refund all bets on "${esc(marketTitle)}" and permanently delete the market.`);
  if (!confirmed) return;
  try {
    await api(`/admin/markets/${marketId}/refund-and-delete`, { method: 'POST' });
    showToast('Market deleted and all bets refunded', 'success');
    hide($('#admin-bets-container'));
    loadAdminMarketSelect();
    loadAdminStats();
    loadMarkets();
  } catch (err) {
    showToast(err.message);
  }
});

let leaderboardData = [];
let leaderboardSort = 'tokens';

// --- Render Leaderboard ---
function renderLeaderboard(users) {
  leaderboardData = users;
  renderLeaderboardSorted();
}

function renderLeaderboardSorted() {
  const container = $('#leaderboard-list');
  if (!leaderboardData.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🏆</div>
        <div class="empty-state-text">No users on the leaderboard yet</div>
      </div>`;
    return;
  }

  const sorted = [...leaderboardData].sort((a, b) => {
    if (leaderboardSort === 'winRate') return b.winRate - a.winRate;
    if (leaderboardSort === 'netProfit') return b.netProfit - a.netProfit;
    return b.tokens - a.tokens;
  });

  const medals = ['🥇', '🥈', '🥉'];
  container.innerHTML = `
    <div class="leaderboard-table">
      <div class="leaderboard-table-header">
        <span class="lt-rank">#</span>
        <span class="lt-name">Player</span>
        <span class="lt-stat">Tokens</span>
        <span class="lt-stat">Win Rate</span>
        <span class="lt-stat">Profit</span>
      </div>
      ${sorted.map((u, i) => {
        const rank = i < 3 ? medals[i] : `#${i + 1}`;
        const isCurrentUser = currentUser && currentUser.id === u.id;
        const highlight = isCurrentUser ? ' highlight' : '';
        const profitClass = u.netProfit >= 0 ? 'stats-positive' : 'stats-negative';
        const profitStr = (u.netProfit >= 0 ? '+' : '') + u.netProfit;
        const wrClass = u.winRate >= 60 ? 'stats-positive' : (u.winRate < 40 && u.wins + u.losses > 0 ? 'stats-negative' : '');
        return `
          <div class="leaderboard-table-row${highlight}">
            <span class="lt-rank">${rank}</span>
            <span class="lt-name">${esc(u.username)}${isCurrentUser ? ' (You)' : ''}</span>
            <span class="lt-stats">
              <span class="lt-stat">${u.tokens} tokens</span>
              <span class="lt-stat ${wrClass}">${u.wins + u.losses > 0 ? u.winRate + '%' : '—'}</span>
              <span class="lt-stat ${profitClass}">${profitStr}</span>
            </span>
          </div>`;
      }).join('')}
    </div>`;
}

// Sort toggle buttons
$$('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    leaderboardSort = btn.dataset.sort;
    $$('.sort-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderLeaderboardSorted();
  });
});

// --- Render Legacy Markets (simplified, no betting) ---
function renderMarketsLegacy(markets, emptyText = 'No resolved markets yet') {
  const container = $('#legacy-list');
  if (!markets.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📜</div>
        <div class="empty-state-text">${emptyText}</div>
      </div>`;
    return;
  }

  const yesPct = (m) => poolPercent(m.yes_pool, m.no_pool, 'yes');
  const noPct = (m) => poolPercent(m.yes_pool, m.no_pool, 'no');

  container.innerHTML = markets.map((m) => {
    const badge = `<span class="resolved-badge resolved-${m.resolution}">Resolved: ${m.resolution.toUpperCase()}</span>`;
    const expiryInfo = formatExpiry(m.expires_at);
    const isExpired = expiryInfo && expiryInfo.expired;
    const expiryClass = isExpired ? 'expiry-expired' : (expiryInfo?.urgent ? 'expiry-urgent' : 'expiry-active');
    const expiryBadge = expiryInfo
      ? `<span class="expiry-badge ${expiryClass}">${expiryInfo.text}</span>`
      : '';
    const betCountBadge = m.bet_count > 0 ? `<span class="bet-count-badge">${m.bet_count} bet${m.bet_count !== 1 ? 's' : ''}</span>` : '';
    const timeAgoLabel = m.created_at ? timeAgo(m.created_at) : '';
    return `
      <div class="market-card">
        <div class="market-header">
          <span class="market-title">${esc(m.title)}</span>
          <div class="market-header-right">
            ${betCountBadge}
            ${expiryBadge}
            ${badge}
          </div>
        </div>
        ${m.description ? `<div class="market-desc">${esc(m.description)}</div>` : ''}
        <div class="market-probability-row">
          <div class="market-probability-bar-wrap">
            <div class="market-probability-bar">
              <div class="market-probability-bar-yes" style="width:${yesPct(m)}%"></div>
            </div>
            <div class="market-probability-labels">
              <span class="prob-label prob-yes">Yes ${yesPct(m)}%</span>
              <span class="prob-label prob-no">No ${noPct(m)}%</span>
            </div>
          </div>
          <div class="market-pools-compact">
            <span class="pool-compact pool-yes-compact">🟢 ${m.yes_pool}</span>
            <span class="pool-compact pool-no-compact">🔴 ${m.no_pool}</span>
          </div>
        </div>
        <div class="market-meta">
          <span class="creator-icon">${esc(m.creator_username[0].toUpperCase())}</span>
          <span class="creator-name clickable-username" data-username="${esc(m.creator_username)}">${esc(m.creator_username)}</span>
          <span class="market-meta-spacer"></span>
          <span class="market-time">${timeAgoLabel}</span>
        </div>
        <div class="market-card-body">
          ${renderMarketActions(m)}
        </div>
        <div class="voters-section">
          <button class="voters-toggle" onclick="toggleVoters(${m.id}, this)">👥 See voters</button>
          <div class="voters-content" id="voters-${m.id}"></div>
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
  $$('.bottom-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  $$('.page').forEach((section) => hide(section));

  if (page === 'markets') {
    show($('#markets-section'));
    show($('#new-market-btn'));
    hide($('#create-market-sheet-overlay'));
    loadMarkets();
  } else if (page === 'legacy') {
    show($('#legacy-section'));
    hide($('#new-market-btn'));
    loadLegacyMarkets();
  } else if (page === 'leaderboard') {
    show($('#leaderboard-section'));
    hide($('#create-market-sheet-overlay'));
    hide($('#new-market-btn'));
    loadLeaderboard();
  } else if (page === 'history') {
    show($('#history-section'));
    hide($('#create-market-sheet-overlay'));
    hide($('#new-market-btn'));
    loadBetHistory();
  } else if (page === 'admin') {
    stopPolling();
    show($('#admin-panel'));
    hide($('#create-market-sheet-overlay'));
    hide($('#new-market-btn'));
    loadAdminUsers();
    loadAdminStats();
    loadBackupStatus();
    loadAdminMarketSelect();
  }
}

// --- UI State ---
function updateUserBar() {
  if (!currentUser) return;
  $('#user-tokens').textContent = `🪙 ${currentUser.tokens}`;
  const adminBadge = currentUser.role === 'admin' ? ' <span style="color:var(--warning);font-size:0.7rem;">(Admin)</span>' : '';
  $('#user-name').textContent = currentUser.username;
  // Append admin badge as a separate element to avoid innerHTML
  const existingBadge = $('#user-name .admin-badge');
  if (existingBadge) existingBadge.remove();
  if (currentUser.role === 'admin') {
    const badge = document.createElement('span');
    badge.className = 'admin-badge';
    badge.style.cssText = 'color:var(--warning);font-size:0.7rem;';
    badge.textContent = ' (Admin)';
    $('#user-name').appendChild(badge);
  }
}

function onAuth() {
  hide($('#auth-panel'));
  show($('#user-bar'));
  show($('#nav-bar'));
  show($('#bottom-nav'));
  updateUserBar();

  // Show admin nav link for admins
  $$('.admin-only').forEach((el) => {
    if (currentUser.role === 'admin') show(el);
    else hide(el);
  });

  navigateTo('markets');
  startPolling();

  // Show onboarding for first-time users
  if (!localStorage.getItem('pm_onboarded')) {
    setTimeout(() => show($('#onboarding-modal')), 500);
  }
}

$('#onboarding-close-btn').addEventListener('click', () => {
  hide($('#onboarding-modal'));
  localStorage.setItem('pm_onboarded', '1');
});

function onLogout() {
  stopPolling();
  show($('#auth-panel'));
  show($('#login-form'));
  hide($('#set-password-form'));
  hide($('#create-market-sheet-overlay'));
  hide($('#new-market-btn'));
  hide($('#user-bar'));
  hide($('#nav-bar'));
  $$('.page').forEach((section) => hide(section));
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

// Prevent iOS Safari from loading page scrolled down
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}
window.addEventListener('load', () => {
  window.scrollTo(0, 0);
});

init();
