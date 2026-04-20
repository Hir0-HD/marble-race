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

  socket.on('race_reset', () => location.reload());
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

  // Caméra suit le leader
  const leader = getLeader();
  if (leader) {
    const target = leader.body.position.y - H * 0.35;
    _scene.cameras.main.scrollY = Phaser.Math.Linear(_scene.cameras.main.scrollY, target, 0.07);
    uiLeader.setText('▶ Leader : ' + leader.username);
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
    restitution: 0.3, friction: 0.08, frictionAir: 0.012,
    density: 0.002, sleepThreshold: 600,
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

  if (m.rank === 1) showWinner(m);

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
  return best || marbles[0] || null;
}

// =====================
// Track generation
// =====================
function buildTrack(scene) {
  const gfx = scene.add.graphics().setDepth(1);

  for (let y = 0; y < WORLD_H; y += 1000) {
    gfx.fillStyle(y % 2000 === 0 ? 0x0d0d1a : 0x111126);
    gfx.fillRect(0, y, W, 1000);
  }

  // Murs
  gfx.fillStyle(0x1e1e4a);
  gfx.fillRect(0, 0, 18, WORLD_H);
  gfx.fillRect(W - 18, 0, 18, WORLD_H);
  scene.matter.add.rectangle(9, WORLD_H / 2, 18, WORLD_H, { isStatic: true });
  scene.matter.add.rectangle(W - 9, WORLD_H / 2, 18, WORLD_H, { isStatic: true });

  // Entonnoir départ
  addFunnel(scene, gfx, SPAWN_Y + 150, 420, 100);

  const types = ['pegs', 'ramps', 'bumpers'];
  const sectionH = 700;
  const startY = SPAWN_Y + 340;
  const numSections = Math.floor((FINISH_Y - startY - 100) / sectionH);

  for (let i = 0; i < numSections; i++) {
    const yBase = startY + i * sectionH;
    const type = types[i % types.length];
    if (type === 'pegs')    addPegs(scene, gfx, yBase, sectionH);
    if (type === 'ramps')   addRamps(scene, gfx, yBase, sectionH);
    if (type === 'bumpers') addBumpers(scene, gfx, yBase, sectionH);
    if (i < numSections - 1) addFunnel(scene, gfx, yBase + sectionH - 50, 220, 80);
  }

  // Sensor arrivée
  scene.matter.add.rectangle(W / 2, FINISH_Y + 15, W + 50, 30, {
    isStatic: true, isSensor: true, label: 'finish'
  });
}

function addRamp(scene, gfx, cx, cy, w, h, deg, color) {
  const rad = Phaser.Math.DegToRad(deg);
  scene.matter.add.rectangle(cx, cy, w, h, { isStatic: true, angle: rad, friction: 0.02, restitution: 0.3 });
  gfx.fillStyle(color);
  gfx.fillPoints(rotatedCorners(cx, cy, w, h, rad), true);
}

function addFunnel(scene, gfx, cy, openW, gapW) {
  const arm = (openW - gapW) / 2;
  addRamp(scene, gfx, W/2 - gapW/2 - arm/2, cy, arm, 12, -22, 0x2a2a6a);
  addRamp(scene, gfx, W/2 + gapW/2 + arm/2, cy, arm, 12,  22, 0x2a2a6a);
}

function addPegs(scene, gfx, yBase, height) {
  const rows = 7, cols = 6, padX = 35;
  const dx = (W - padX * 2) / (cols - 1);
  const dy = height / (rows + 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = padX + c * dx + (r % 2 === 0 ? 0 : dx / 2);
      const y = yBase + (r + 1) * dy;
      if (x < 22 || x > W - 22) continue;
      const pr = 6 + Math.random() * 4;
      scene.matter.add.circle(x, y, pr, { isStatic: true, restitution: 0.45, friction: 0.02 });
      gfx.fillStyle(0x5566cc); gfx.fillCircle(x, y, pr);
      gfx.lineStyle(1.5, 0x8899ff, 0.6); gfx.strokeCircle(x, y, pr);
    }
  }
}

function addRamps(scene, gfx, yBase, height) {
  const count = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    const x = 50 + Math.random() * (W - 100);
    const y = yBase + (height / count) * i + 50 + Math.random() * 60;
    const w = 80 + Math.random() * 120;
    addRamp(scene, gfx, x, y, w, 12, (Math.random() - 0.5) * 50, 0x4455aa);
  }
}

function addBumpers(scene, gfx, yBase, height) {
  const count = 5 + Math.floor(Math.random() * 5);
  for (let i = 0; i < count; i++) {
    const x = 40 + Math.random() * (W - 80);
    const y = yBase + Math.random() * height * 0.85 + 50;
    const r = 14 + Math.random() * 14;
    scene.matter.add.circle(x, y, r, { isStatic: true, restitution: 1.05, friction: 0 });
    gfx.fillStyle(0xcc2255); gfx.fillCircle(x, y, r);
    gfx.lineStyle(2.5, 0xff4488, 0.8); gfx.strokeCircle(x, y, r);
  }
}
