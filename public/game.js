// =====================
// Constants
// =====================
const W = 540;
const H = 960;
const WORLD_H = 6000;
const MARBLE_R = 8;
const SPAWN_Y = 80;
const FINISH_Y = WORLD_H - 220;
const SPAWN_RATE_MS = 55;

// =====================
// State
// =====================
let marbles = [];
let marbleMap = {};
let results = [];
let raceStarted = false;
let firstFinished = false;
let spawnQueue = [];
let lastSpawnTime = 0;
let _scene = null;
let socket;
let uiLeader, uiCount, uiFinished;
let winnerPopup = null;

// =====================
// Phaser Config
// =====================
const config = {
  type: Phaser.AUTO,
  width: W,
  height: H,
  backgroundColor: '#0d0d1a',
  parent: 'game-container',
  resolution: window.devicePixelRatio || 1,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: W,
    height: H,
  },
  physics: {
    default: 'matter',
    matter: {
      gravity: { y: 0.8 },
      debug: false,
      positionIterations: 12,
      velocityIterations: 8,
      constraintIterations: 4,
    }
  },
  scene: { preload, create, update }
};

new Phaser.Game(config);

// =====================
// Helpers
// =====================
function rotatedCorners(cx, cy, w, h, rad) {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const hw = w / 2, hh = h / 2;
  return [
    { x: cx + (-hw) * cos - (-hh) * sin, y: cy + (-hw) * sin + (-hh) * cos },
    { x: cx + ( hw) * cos - (-hh) * sin, y: cy + ( hw) * sin + (-hh) * cos },
    { x: cx + ( hw) * cos - ( hh) * sin, y: cy + ( hw) * sin + ( hh) * cos },
    { x: cx + (-hw) * cos - ( hh) * sin, y: cy + (-hw) * sin + ( hh) * cos },
  ];
}

// Crée une texture circulaire depuis une URL (CORS via proxy serveur)
function loadAvatarTexture(scene, key, url) {
  return new Promise((resolve) => {
    if (scene.textures.exists(key)) { resolve(key); return; }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const D = MARBLE_R * 2 + 2;
      const canvas = document.createElement('canvas');
      canvas.width = D; canvas.height = D;
      const ctx = canvas.getContext('2d');
      ctx.beginPath();
      ctx.arc(D / 2, D / 2, MARBLE_R, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, 0, 0, D, D);
      // Shine
      ctx.beginPath();
      ctx.arc(D / 2 - 3, D / 2 - 3, MARBLE_R * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fill();
      try {
        scene.textures.addCanvas(key, canvas);
        resolve(key);
      } catch(e) { resolve('marble_gray'); }
    };
    img.onerror = () => resolve('marble_gray');
    img.src = url;
  });
}

function makeGrayTexture(scene) {
  const D = MARBLE_R * 2 + 2;
  const canvas = document.createElement('canvas');
  canvas.width = D; canvas.height = D;
  const ctx = canvas.getContext('2d');

  // Corps gris avec dégradé
  const grad = ctx.createRadialGradient(D/2 - 2, D/2 - 2, 1, D/2, D/2, MARBLE_R);
  grad.addColorStop(0, '#aaaaaa');
  grad.addColorStop(1, '#555555');
  ctx.beginPath();
  ctx.arc(D/2, D/2, MARBLE_R, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Reflet
  ctx.beginPath();
  ctx.arc(D/2 - 3, D/2 - 3, MARBLE_R * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fill();

  scene.textures.addCanvas('marble_gray', canvas);
}

// =====================
// Phaser lifecycle
// =====================
function preload() {
  makeGrayTexture(this);
}

function create() {
  _scene = this;

  this.matter.world.setBounds(0, 0, W, WORLD_H);
  this.cameras.main.setBounds(0, 0, W, WORLD_H);
  this.matter.world.engine.enableSleeping = false;

  buildTrack(this);

  // UI fixée caméra
  uiLeader = this.add.text(12, 12, '', {
    fontSize: '15px', color: '#ffffff',
    backgroundColor: '#00000099', padding: { x: 8, y: 5 }
  }).setScrollFactor(0).setDepth(100);

  uiCount = this.add.text(W - 12, 12, '', {
    fontSize: '15px', color: '#ffffff',
    backgroundColor: '#00000099', padding: { x: 8, y: 5 }
  }).setScrollFactor(0).setDepth(100).setOrigin(1, 0);

  uiFinished = this.add.text(W / 2, H - 18, '', {
    fontSize: '14px', color: '#facc15',
    backgroundColor: '#00000099', padding: { x: 8, y: 5 }
  }).setScrollFactor(0).setDepth(100).setOrigin(0.5, 1);

  // Ligne d'arrivée
  this.add.rectangle(W / 2, FINISH_Y, W, 6, 0xfacc15).setDepth(5);
  this.add.text(W / 2, FINISH_Y - 26, '🏁  ARRIVÉE', {
    fontSize: '22px', color: '#facc15', stroke: '#000', strokeThickness: 3
  }).setOrigin(0.5).setDepth(6);

  // Collision finish
  this.matter.world.on('collisionstart', (event) => {
    for (const { bodyA, bodyB } of event.pairs) {
      let mb = bodyB.label === 'finish' ? bodyA : bodyA.label === 'finish' ? bodyB : null;
      if (mb && mb.label && mb.label.startsWith('m:')) onFinish(mb.label.slice(2));
    }
  });

  // Socket
  socket = io();

  socket.on('init', ({ followers, results: saved, raceActive, mockMode }) => {
    document.getElementById('marble-count').textContent = followers.length;
    if (mockMode) document.getElementById('mock-badge').style.display = 'inline-block';
    if (raceActive) beginRace(followers);
  });

  socket.on('race_start', ({ followers }) => {
    document.getElementById('overlay').classList.add('hidden');
    beginRace(followers);
  });

  socket.on('new_follower', (f) => {
    const el = document.getElementById('marble-count');
    if (el) el.textContent = parseInt(el.textContent || '0') + 1;
    if (raceStarted) spawnQueue.push(f);
  });

  socket.on('race_reset', () => { firstFinished = false; location.reload(); });
}

function update(time) {
  if (spawnQueue.length > 0 && time - lastSpawnTime >= SPAWN_RATE_MS) {
    doSpawn(spawnQueue.shift());
    lastSpawnTime = time;
  }

  if (!raceStarted || marbles.length === 0) return;

  const camY = _scene.cameras.main.scrollY;

  // Mise à jour position des sprites
  for (const m of marbles) {
    const { x, y } = m.body.position;
    const inView = y >= camY - 150 && y <= camY + H + 150;
    m.img.setPosition(x, y).setVisible(inView);
  }

  // Caméra : suit le leader avant la 1ère arrivée, fige sur la finish ensuite
  if (!firstFinished) {
    const leader = getLeader();
    if (leader) {
      const target = leader.body.position.y - H * 0.35;
      _scene.cameras.main.scrollY = Phaser.Math.Linear(_scene.cameras.main.scrollY, target, 0.07);
      uiLeader.setText('▶ Leader : ' + leader.username);
    }
  } else {
    const target = FINISH_Y - H * 0.6;
    _scene.cameras.main.scrollY = Phaser.Math.Linear(_scene.cameras.main.scrollY, target, 0.04);
  }

  uiCount.setText('⚪ ' + marbles.length);
  uiFinished.setText(results.length ? `🏁 ${results.length} arrivée${results.length > 1 ? 's' : ''}` : '');
}

// =====================
// Race logic
// =====================
function beginRace(followers) {
  raceStarted = true;
  followers.forEach(f => spawnQueue.push(f));
}

async function doSpawn(follower) {
  const x = W / 2 + (Math.random() - 0.5) * 90;

  // Texture : avatar ou gris
  let texKey = 'marble_gray';
  if (follower.avatar) {
    const proxyUrl = `/api/avatar?url=${encodeURIComponent(follower.avatar)}`;
    texKey = await loadAvatarTexture(_scene, 'av_' + follower.id, proxyUrl);
  }

  const body = _scene.matter.add.circle(x, SPAWN_Y, MARBLE_R, {
    restitution: 0.3, friction: 0.05, frictionAir: 0.010,
    frictionStatic: 0, density: 0.002, sleepThreshold: 600,
    label: `m:${follower.id}`,
  });

  const img = _scene.add.image(x, SPAWN_Y, texKey)
    .setDisplaySize(MARBLE_R * 2, MARBLE_R * 2)
    .setDepth(10);

  const marble = { id: String(follower.id), username: follower.username, body, img, finished: false };
  marbles.push(marble);
  marbleMap[String(follower.id)] = marble;
}

function onFinish(id) {
  const m = marbleMap[id];
  if (!m || m.finished) return;
  m.finished = true;
  m.rank = results.length + 1;
  results.push(m);

  if (m.rank === 1) { firstFinished = true; showWinner(m); }

  fetch('/api/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: m.username, position: m.rank }),
  });
}

function showWinner(m) {
  if (winnerPopup) winnerPopup.destroy();

  const cam = _scene.cameras.main;
  const cx = W / 2;
  const cy = cam.scrollY + H * 0.45;

  // Fond
  const bg = _scene.add.rectangle(cx, cy, 340, 130, 0x000000, 0.85)
    .setDepth(200).setStrokeStyle(3, 0xfacc15);

  const crown = _scene.add.text(cx, cy - 38, '👑 1er arrivé', {
    fontSize: '20px', color: '#facc15', stroke: '#000', strokeThickness: 3
  }).setOrigin(0.5).setDepth(201);

  const name = _scene.add.text(cx, cy + 8, m.username, {
    fontSize: '26px', color: '#ffffff', fontStyle: 'bold',
    stroke: '#000', strokeThickness: 4
  }).setOrigin(0.5).setDepth(201);

  winnerPopup = _scene.add.container(0, 0, [bg, crown, name]).setDepth(200);

  // Disparaît après 5s
  _scene.time.delayedCall(5000, () => { if (winnerPopup) { winnerPopup.destroy(); winnerPopup = null; } });
}

function getLeader() {
  let best = null, maxY = -Infinity;
  for (const m of marbles) {
    if (!m.finished && m.body.position.y > maxY) { maxY = m.body.position.y; best = m; }
  }
  return best;
}

// =====================
// Track generation
// =====================
function buildTrack(scene) {
  const gfx = scene.add.graphics().setDepth(1);

  // Fond alterné
  for (let y = 0; y < WORLD_H; y += 1000) {
    gfx.fillStyle(y % 2000 === 0 ? 0x0d0d1a : 0x111126);
    gfx.fillRect(0, y, W, 1000);
  }

  // Murs latéraux
  gfx.fillStyle(0x1e1e4a);
  gfx.fillRect(0, 0, 18, WORLD_H);
  gfx.fillRect(W - 18, 0, 18, WORLD_H);
  scene.matter.add.rectangle(9, WORLD_H / 2, 18, WORLD_H, { isStatic: true });
  scene.matter.add.rectangle(W - 9, WORLD_H / 2, 18, WORLD_H, { isStatic: true });

  // Entonnoir de départ — regroupe les billes
  addFunnel(scene, gfx, SPAWN_Y + 160, 460, 90);

  // Zigzag : rampes alternées gauche/droite avec rangée de pegs entre chaque paire
  const startY = SPAWN_Y + 360;
  const rampSpacing = 280;
  const numRamps = Math.floor((FINISH_Y - 300 - startY) / rampSpacing);

  for (let i = 0; i < numRamps; i++) {
    const y = startY + i * rampSpacing;
    addZigzagRamp(scene, gfx, y, i % 2 === 0);
    // Rangée de pegs centraux entre deux rampes
    if (i % 2 === 1) addPegRow(scene, gfx, y + rampSpacing * 0.55);
  }

  // Entonnoir final avant la ligne d'arrivée
  addFunnel(scene, gfx, FINISH_Y - 140, 360, 100);

  // Sensor ligne d'arrivée
  scene.matter.add.rectangle(W / 2, FINISH_Y + 15, W + 50, 30, {
    isStatic: true, isSensor: true, label: 'finish',
  });
}

// Rampe zigzag : guide les billes vers le bas à gauche ou à droite
// laisse un gap de ~120px de l'autre côté pour qu'elles tombent
function addZigzagRamp(scene, gfx, y, fromLeft) {
  const rampW = 370;
  const h = 16;
  const angle = 20;
  const cx = fromLeft ? 18 + rampW / 2 : W - 18 - rampW / 2;
  const deg = fromLeft ? angle : -angle;
  addRamp(scene, gfx, cx, y, rampW, h, deg, 0x3a55cc);
}

// Rangée de 4 pegs régulièrement espacés au centre
function addPegRow(scene, gfx, y) {
  const count = 4;
  const pad = 70;
  const step = (W - pad * 2) / (count - 1);
  for (let i = 0; i < count; i++) {
    const x = pad + i * step;
    const r = 8;
    scene.matter.add.circle(x, y, r, { isStatic: true, restitution: 0.35, friction: 0, frictionStatic: 0 });
    gfx.fillStyle(0x5566cc);
    gfx.fillCircle(x, y, r);
    gfx.lineStyle(1.5, 0x8899ff, 0.7);
    gfx.strokeCircle(x, y, r);
  }
}

function addRamp(scene, gfx, cx, cy, w, h, deg, color) {
  const rad = Phaser.Math.DegToRad(deg);
  scene.matter.add.rectangle(cx, cy, w, h, { isStatic: true, angle: rad, friction: 0.01, restitution: 0.2, frictionStatic: 0 });
  gfx.fillStyle(color);
  gfx.fillPoints(rotatedCorners(cx, cy, w, h, rad), true);
}

function addFunnel(scene, gfx, cy, openW, gapW) {
  const arm = (openW - gapW) / 2;
  addRamp(scene, gfx, W / 2 - gapW / 2 - arm / 2, cy, arm, 12, -22, 0x2a2a6a);
  addRamp(scene, gfx, W / 2 + gapW / 2 + arm / 2, cy, arm, 12,  22, 0x2a2a6a);
}
