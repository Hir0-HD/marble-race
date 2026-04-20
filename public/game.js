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
let spinners = [];

// Raccourci vers Matter.Body pour les spinners
const MBody = Phaser.Physics.Matter.Matter.Body;

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
      gravity: { y: 1.3 },
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

  // Seulement top/bottom via setBounds — les murs latéraux sont dans buildTrack
  this.matter.world.setBounds(0, 0, W, WORLD_H, 50, false, false, true, true);
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

  // Rotation des palettes
  for (const s of spinners) {
    MBody.setAngle(s.body, s.body.angle + s.speed);
    s.visual.setRotation(s.body.angle);
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
    restitution: 0.4, friction: 0.01, frictionAir: 0.001,
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

  // Fond
  for (let y = 0; y < WORLD_H; y += 1000) {
    gfx.fillStyle(y % 2000 === 0 ? 0x0d0d1a : 0x111126);
    gfx.fillRect(0, y, W, 1000);
  }

  // Murs latéraux uniques (24px, restitution légère pour ne pas perdre de vitesse)
  const wallOpts = { isStatic: true, restitution: 0.15, friction: 0, frictionStatic: 0 };
  gfx.fillStyle(0x1e1e4a);
  gfx.fillRect(0, 0, 24, WORLD_H);
  gfx.fillRect(W - 24, 0, 24, WORLD_H);
  scene.matter.add.rectangle(12, WORLD_H / 2, 24, WORLD_H, wallOpts);
  scene.matter.add.rectangle(W - 12, WORLD_H / 2, 24, WORLD_H, wallOpts);

  // Entonnoir de départ : regroupe les billes
  addFunnel(scene, gfx, SPAWN_Y + 160, 460, 85);

  // ---- Sections alternées ----
  // 1. Zigzag large → descente rapide, billes se séparent
  addZigzagSection(scene, gfx, 380, 900);
  addFunnel(scene, gfx, 1310, 340, 100);

  // 2. Plinko (pachinko) → les billes se dispersent aléatoirement
  addPlinkoSection(scene, gfx, 1370, 850);
  addFunnel(scene, gfx, 2260, 340, 100);

  // 3. Spinners → palettes rotatives qui ralentissent les rapides / boostent les lentes
  addSpinnerSection(scene, 2320, 900);
  addFunnel(scene, gfx, 3260, 340, 100);

  // 4. Bumpers → rebonds chaotiques, possibilité de dépassement
  addBumperSection(scene, gfx, 3320, 900);
  addFunnel(scene, gfx, 4260, 340, 100);

  // 5. Zigzag serré + pegs → sprint final tendu
  addZigzagTightSection(scene, gfx, 4320, 1000);
  addFunnel(scene, gfx, FINISH_Y - 130, 380, 100);

  // Sensor ligne d'arrivée
  scene.matter.add.rectangle(W / 2, FINISH_Y + 15, W + 50, 30, {
    isStatic: true, isSensor: true, label: 'finish',
  });
}

// Section 1 — Zigzag large : 4 rampes alternées, angle prononcé
function addZigzagSection(scene, gfx, startY, height) {
  const count = 4;
  const spacing = height / (count + 1);
  for (let i = 0; i < count; i++) {
    const y = startY + (i + 1) * spacing;
    const fromLeft = i % 2 === 0;
    const rampW = 370;
    const cx = fromLeft ? 24 + rampW / 2 : W - 24 - rampW / 2;
    addRamp(scene, gfx, cx, y, rampW, 16, fromLeft ? 20 : -20, 0x3a55cc);
  }
}

// Section 2 — Plinko : grille de pegs décalés (style pachinko)
function addPlinkoSection(scene, gfx, startY, height) {
  const rows = 8, cols = 5;
  const padX = 55;
  const dx = (W - padX * 2) / (cols - 1);
  const dy = height / (rows + 1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const offset = r % 2 === 0 ? 0 : dx / 2;
      const x = padX + c * dx + offset;
      const y = startY + (r + 1) * dy;
      if (x < 30 || x > W - 30) continue;
      const pr = 7;
      scene.matter.add.circle(x, y, pr, { isStatic: true, restitution: 0.55, friction: 0, frictionStatic: 0 });
      gfx.fillStyle(0x4466dd); gfx.fillCircle(x, y, pr);
      gfx.lineStyle(2, 0x88aaff, 0.8); gfx.strokeCircle(x, y, pr);
    }
  }
}

// Section 3 — Spinners : palettes rotatives (static + setAngle chaque frame)
function addSpinnerSection(scene, startY, height) {
  const configs = [
    { x: W * 0.33, y: startY + height * 0.20, w: 170, speed:  0.022 },
    { x: W * 0.67, y: startY + height * 0.42, w: 150, speed: -0.030 },
    { x: W * 0.30, y: startY + height * 0.64, w: 160, speed:  0.025 },
    { x: W * 0.70, y: startY + height * 0.84, w: 140, speed: -0.020 },
  ];
  for (const c of configs) {
    const body = scene.matter.add.rectangle(c.x, c.y, c.w, 14, {
      isStatic: true, friction: 0, restitution: 0.4, frictionStatic: 0, label: 'spinner',
    });
    // Rectangle Phaser pour le visuel (tourne avec le body)
    const visual = scene.add.rectangle(c.x, c.y, c.w, 14, 0xffaa00).setDepth(5);
    // Halo
    scene.add.rectangle(c.x, c.y, c.w + 6, 20, 0xff6600, 0.25).setDepth(4);
    spinners.push({ body, visual, speed: c.speed });
  }
}

// Section 4 — Bumpers : gros ronds rebondissants en losange
function addBumperSection(scene, gfx, startY, height) {
  const pos = [
    { x: 0.25, y: 0.12 }, { x: 0.75, y: 0.12 },
    { x: 0.50, y: 0.28 },
    { x: 0.20, y: 0.46 }, { x: 0.80, y: 0.46 },
    { x: 0.50, y: 0.62 },
    { x: 0.28, y: 0.80 }, { x: 0.72, y: 0.80 },
  ];
  for (const p of pos) {
    const x = W * p.x, y = startY + p.y * height, r = 20;
    scene.matter.add.circle(x, y, r, { isStatic: true, restitution: 0.9, friction: 0, frictionStatic: 0 });
    gfx.fillStyle(0xcc2255); gfx.fillCircle(x, y, r);
    gfx.lineStyle(3, 0xff4488, 0.9); gfx.strokeCircle(x, y, r);
    gfx.lineStyle(8, 0xff4488, 0.2); gfx.strokeCircle(x, y, r + 7);
  }
}

// Section 5 — Zigzag serré + rangée de pegs alternée
function addZigzagTightSection(scene, gfx, startY, height) {
  const count = 5;
  const spacing = height / (count * 2);
  for (let i = 0; i < count; i++) {
    const y = startY + (i * 2 + 1) * spacing;
    const fromLeft = i % 2 === 0;
    const rampW = 310;
    const cx = fromLeft ? 24 + rampW / 2 : W - 24 - rampW / 2;
    addRamp(scene, gfx, cx, y, rampW, 14, fromLeft ? 16 : -16, 0x2244aa);
    // Rangée de 3 pegs au milieu entre deux rampes
    const pegY = y + spacing * 0.8;
    for (let p = 0; p < 3; p++) {
      const px = W * (0.25 + p * 0.25);
      scene.matter.add.circle(px, pegY, 6, { isStatic: true, restitution: 0.45, friction: 0, frictionStatic: 0 });
      gfx.fillStyle(0x5566cc); gfx.fillCircle(px, pegY, 6);
    }
  }
}

function addRamp(scene, gfx, cx, cy, w, h, deg, color) {
  const rad = Phaser.Math.DegToRad(deg);
  // friction:0 + frictionStatic:0 → les billes glissent sans perdre de vitesse sur les rampes
  scene.matter.add.rectangle(cx, cy, w, h, { isStatic: true, angle: rad, friction: 0, restitution: 0.05, frictionStatic: 0 });
  gfx.fillStyle(color);
  gfx.fillPoints(rotatedCorners(cx, cy, w, h, rad), true);
}

function addFunnel(scene, gfx, cy, openW, gapW) {
  const arm = (openW - gapW) / 2;
  addRamp(scene, gfx, W / 2 - gapW / 2 - arm / 2, cy, arm, 12, -22, 0x2a2a6a);
  addRamp(scene, gfx, W / 2 + gapW / 2 + arm / 2, cy, arm, 12,  22, 0x2a2a6a);
}
