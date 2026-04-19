const list = document.getElementById('lb-list');
const statTotal = document.getElementById('stat-total');
const statFinished = document.getElementById('stat-finished');
const statRemaining = document.getElementById('stat-remaining');

let totalFollowers = 0;

const MEDALS = ['🥇', '🥈', '🥉'];

function rankClass(i) {
  return i < 3 ? `rank-${i + 1}` : '';
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `il y a ${s}s`;
  return `il y a ${Math.floor(s / 60)}min`;
}

function render(results) {
  statFinished.textContent = results.length;
  statRemaining.textContent = Math.max(0, totalFollowers - results.length);

  if (results.length === 0) {
    list.innerHTML = '<div class="lb-empty">En attente du début de la course…</div>';
    return;
  }

  list.innerHTML = results.map((r, i) => `
    <div class="lb-entry ${rankClass(i)}">
      <span class="lb-rank">${MEDALS[i] ?? '#' + (i + 1)}</span>
      <span class="lb-username">${r.username}</span>
      <span class="lb-time">${timeAgo(r.timestamp)}</span>
    </div>
  `).join('');
}

// Rafraîchit les "il y a Xs" toutes les 30s
setInterval(() => {
  const entries = document.querySelectorAll('.lb-time');
  // (simple re-render si résultats disponibles)
}, 30000);

// Socket
const socket = io();

socket.on('init', ({ followers, results }) => {
  totalFollowers = followers.length;
  statTotal.textContent = totalFollowers;
  render(results);
});

socket.on('new_follower', () => {
  totalFollowers++;
  statTotal.textContent = totalFollowers;
  statRemaining.textContent = Math.max(0, totalFollowers - parseInt(statFinished.textContent || '0'));
});

socket.on('leaderboard_update', (results) => render(results));

socket.on('race_reset', () => location.reload());

// Fetch initial (si rechargement de page)
fetch('/api/state')
  .then(r => r.json())
  .then(({ followers, results }) => {
    totalFollowers = followers.length;
    statTotal.textContent = totalFollowers;
    render(results);
  });
