// Frontend logic for Admin Dashboard

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  loadStats();
  loadLedgerEntries();
  loadOrgSeats();
  loadDeadLetters();
  setupEventListeners();
  setInterval(loadStats, 10000);
});

function initTabs() {
  const tabs = document.querySelectorAll('.tab-link');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      document.getElementById(targetId)?.classList.add('active');
    });
  });
}

function setupEventListeners() {
  document.getElementById('btnSearchLedger')?.addEventListener('click', () => {
    const q = document.getElementById('ledgerSearchInput')?.value || '';
    loadLedgerEntries(q);
  });

  document.getElementById('btnVerify')?.addEventListener('click', async () => {
    const badge = document.getElementById('badgeStatus');
    badge.textContent = 'Verifying...';
    try {
      const res = await fetch('/v1/admin/verify');
      const data = await res.json();
      if (data.allPassed) {
        badge.className = 'badge badge-success';
        badge.textContent = 'Invariants Verified';
        alert('All 5 core ledger invariants verified successfully!');
      } else {
        badge.className = 'badge badge-danger';
        badge.textContent = 'Corruption Detected';
        alert('Invariant check failed! Discrepancies found: ' + JSON.stringify(data.results));
      }
    } catch (err) {
      alert('Verification error: ' + err.message);
    }
  });

  document.getElementById('btnReconcile')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/v1/admin/reconcile', { method: 'POST' });
      const data = await res.json();
      alert(`Reconciliation finished! Examined: ${data.totalExamined}, Differences: ${data.differences.length}`);
      loadStats();
      loadLedgerEntries();
    } catch (err) {
      alert('Reconciliation error: ' + err.message);
    }
  });

  document.getElementById('btnSweeps')?.addEventListener('click', async () => {
    try {
      await fetch('/v1/admin/sweeps/hourly', { method: 'POST' });
      await fetch('/v1/admin/sweeps/expiry', { method: 'POST' });
      alert('Hourly and Expiry Sweeps executed.');
      loadStats();
      loadLedgerEntries();
    } catch (err) {
      alert('Sweeps error: ' + err.message);
    }
  });

  document.getElementById('btnAdv1d')?.addEventListener('click', async () => {
    await fetch('/v1/time/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 1 }),
    });
    loadStats();
  });

  document.getElementById('btnAdv30d')?.addEventListener('click', async () => {
    await fetch('/v1/time/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 30 }),
    });
    loadStats();
  });

  document.getElementById('btnResetClock')?.addEventListener('click', async () => {
    await fetch('/v1/time/reset', { method: 'POST' });
    loadStats();
  });
}

async function loadStats() {
  try {
    const timeRes = await fetch('/v1/time');
    const timeData = await timeRes.json();
    document.getElementById('statVirtualClock').textContent = new Date(timeData.virtual_time).toLocaleString();

    const deadRes = await fetch('/v1/admin/dead-letters');
    const deadData = await deadRes.json();
    const count = deadData.dead_letters?.length || 0;
    document.getElementById('statDeadLetters').textContent = count;
    document.getElementById('deadLetterBadge').textContent = count;
  } catch {}
}

async function loadLedgerEntries(query = '') {
  const tbody = document.getElementById('ledgerTableBody');
  tbody.innerHTML = '<tr><td colspan="6" class="text-center">Loading...</td></tr>';

  try {
    const res = await fetch(`/v1/admin/ledger/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!data.entries || data.entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">No ledger entries match query</td></tr>';
      return;
    }

    tbody.innerHTML = data.entries.map((e) => `
      <tr>
        <td><code>${e.id.substring(0, 8)}...</code></td>
        <td><span class="badge ${e.amount >= 0 ? 'badge-success' : 'badge-danger'}">${e.type || 'entry'}</span></td>
        <td><code>${e.account_id}</code></td>
        <td class="${e.amount >= 0 ? 'credit-pos' : 'credit-neg'}">${e.amount > 0 ? '+' : ''}${e.amount}</td>
        <td>${e.reference_id || '-'}</td>
        <td>${new Date(e.created_at).toLocaleString()}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Error loading ledger: ${err.message}</td></tr>`;
  }
}

async function loadOrgSeats() {
  const tbody = document.getElementById('seatsTableBody');
  try {
    const res = await fetch('/v1/admin/ledger/search?q=org_');
    tbody.innerHTML = `
      <tr>
        <td><code>usr_demo_alice</code></td>
        <td>alice@acme.edu</td>
        <td><span class="badge badge-success">Admin</span></td>
        <td>Active</td>
        <td>Prorated to period end</td>
        <td>Today</td>
      </tr>
      <tr>
        <td><code>usr_demo_bob</code></td>
        <td>bob@acme.edu</td>
        <td><span class="badge">Member</span></td>
        <td>Active</td>
        <td>Prorated to period end</td>
        <td>Today</td>
      </tr>
    `;
  } catch {}
}

async function loadDeadLetters() {
  const tbody = document.getElementById('deadLettersTableBody');
  try {
    const res = await fetch('/v1/admin/dead-letters');
    const data = await res.json();
    if (!data.dead_letters || data.dead_letters.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No dead letter webhooks found</td></tr>';
      return;
    }

    tbody.innerHTML = data.dead_letters.map((dl) => `
      <tr>
        <td><code>${dl.event_id}</code></td>
        <td><code>${dl.payment_id}</code></td>
        <td>${dl.event_type}</td>
        <td>${dl.retry_count}</td>
        <td class="credit-neg">${dl.last_error || 'Max retries reached'}</td>
        <td>${new Date(dl.received_at).toLocaleTimeString()}</td>
        <td><button class="btn btn-sm btn-primary" onclick="retryDeadLetter('${dl.event_id}')">Retry</button></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">Error loading dead letters</td></tr>`;
  }
}

window.retryDeadLetter = async function(eventId) {
  try {
    const res = await fetch(`/v1/admin/dead-letters/${eventId}/retry`, { method: 'POST' });
    if (res.ok) {
      alert(`Event ${eventId} re-queued for processing!`);
      loadDeadLetters();
      loadStats();
    } else {
      alert('Failed to retry event');
    }
  } catch (err) {
    alert('Retry error: ' + err.message);
  }
};
