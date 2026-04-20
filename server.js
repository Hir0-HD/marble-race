require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());

// Jeu réservé à l'admin (URL privée)
app.get('/game', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Public → leaderboard uniquement
app.get('/', (_req, res) => res.redirect('/leaderboard.html'));

app.use(express.static(path.join(__dirname, 'public')));

// Injecte le mot de passe admin dans la page (côté client)
const ADMIN_PWD = process.env.ADMIN_PASSWORD || 'admin1234';
app.get('/admin.html', (_req, res) => {
  const fs = require('fs');
  let html = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
  html = html.replace('window.__ADMIN_PWD__', `"${ADMIN_PWD}"`);
  res.send(html);
});

// Proxy avatar TikTok (évite les problèmes CORS)
app.get('/api/avatar', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).end();
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' } });
    res.set('Content-Type', resp.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(resp.data);
  } catch { res.status(404).end(); }
});

// =====================
// State
// =====================
let followers = [];
let results = [];
let knownIds = new Set();
let raceActive = false;

const MOCK_MODE = !process.env.TIKTOK_SESSION_ID;
const POLL_MS = parseInt(process.env.POLL_INTERVAL || '30000', 10);
const TT_USER = process.env.TIKTOK_USERNAME || 'demo';
const MAX_MARBLES = parseInt(process.env.MAX_MARBLES || '10', 10);

const MOCK_POOL = [
  'shadow_wolf','neon_rider','pixel_fox','storm_eagle','cyber_cat',
  'drift_king','blade_runner','ghost_rider','thunder_bolt','ice_queen',
  'fire_dancer','moon_walker','star_chaser','dark_phoenix','lava_lord',
  'wind_spirit','rock_solid','ocean_wave','sky_hunter','night_owl',
  'turbo_rex','zero_cool','hyper_beam','flash_tiger','sonic_wave',
  'atomic_bee','solar_flair','lunar_tick','cosmic_dust','nova_burst',
];
let mockIdx = 0;

// =====================
// TikTok polling
// =====================
async function fetchNewFollowers() {
  if (MOCK_MODE) {
    const count = Math.floor(Math.random() * 2) + 1;
    const batch = [];
    for (let i = 0; i < count; i++) {
      const name = '@' + MOCK_POOL[mockIdx % MOCK_POOL.length] + '_' + (mockIdx + 1);
      batch.push({ id: Date.now() + i, username: name });
      mockIdx++;
    }
    return batch;
  }

  try {
    const res = await axios.get(`https://www.tiktok.com/@${TT_USER}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': `sessionid=${process.env.TIKTOK_SESSION_ID}`,
      },
      timeout: 10000,
    });
    const match = res.data.match(/"followerCount":(\d+)/);
    const total = match ? parseInt(match[1], 10) : followers.length;
    const diff = total - followers.length;
    if (diff <= 0) return [];
    const batch = [];
    for (let i = 0; i < diff; i++) {
      batch.push({ id: Date.now() + i, username: `@follower_${(Date.now() + i).toString(36)}` });
    }
    return batch;
  } catch (e) {
    console.error('[TikTok]', e.message);
    return [];
  }
}

async function poll() {
  if (MOCK_MODE && followers.length >= MAX_MARBLES) return;
  const newOnes = await fetchNewFollowers();
  for (const f of newOnes) {
    if (!knownIds.has(f.id)) {
      if (MOCK_MODE && followers.length >= MAX_MARBLES) break;
      knownIds.add(f.id);
      followers.push(f);
      io.emit('new_follower', f);
      console.log(`[+] ${f.username} (total: ${followers.length})`);
    }
  }
}

function seedFollowers(n) {
  for (let i = 0; i < n; i++) {
    const name = '@' + MOCK_POOL[i % MOCK_POOL.length] + '_' + (i + 1);
    const f = { id: i + 1, username: name };
    followers.push(f);
    knownIds.add(f.id);
  }
  mockIdx = n;
  console.log(`[Init] ${n} billes seed (mode ${MOCK_MODE ? 'mock' : 'TikTok'})`);
}

seedFollowers(MOCK_MODE ? MAX_MARBLES : 0);
setInterval(poll, POLL_MS);

// =====================
// Routes
// =====================
app.get('/api/state', (_req, res) => {
  res.json({ followers, results, raceActive, mockMode: MOCK_MODE });
});

app.post('/api/start', (_req, res) => {
  raceActive = true;
  io.emit('race_start', { followers });
  console.log(`[Race] Départ ! ${followers.length} billes`);
  res.json({ ok: true });
});

app.post('/api/result', (req, res) => {
  const { username, position } = req.body;
  if (!username) return res.status(400).json({ error: 'username requis' });
  const existing = results.find(r => r.username === username);
  if (existing) return res.json({ ok: true });
  results.push({ username, position, timestamp: Date.now() });
  results.sort((a, b) => a.position - b.position);
  io.emit('leaderboard_update', results);
  res.json({ ok: true });
});

app.post('/api/reset', (_req, res) => {
  followers = []; results = []; knownIds = new Set();
  raceActive = false; mockIdx = 0;
  seedFollowers(MOCK_MODE ? MAX_MARBLES : 0);
  io.emit('race_reset');
  console.log('[Race] Reset');
  res.json({ ok: true });
});

// =====================
// WebSocket
// =====================
io.on('connection', (socket) => {
  console.log('[WS] Connecté:', socket.id);
  socket.emit('init', { followers, results, raceActive, mockMode: MOCK_MODE });
  socket.on('disconnect', () => console.log('[WS] Déconnecté:', socket.id));
});

// =====================
// Start
// =====================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🎱 Marble Race → http://localhost:${PORT}`);
  console.log(`📊 Classement  → http://localhost:${PORT}/leaderboard.html\n`);
});
