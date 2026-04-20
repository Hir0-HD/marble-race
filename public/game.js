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
// Palette & helpers arc
// =====================
const CYAN   = 0x00ccdd;
const WALL_W = 24;

// Points le long d'un arc (système Y-vers-le-bas de Phaser)
function arcPoints(cx, cy, r, startA, endA, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = startA + (endA - startA) * (i / steps);
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

// Dessine un arc épais rempli
function drawThickArc(gfx, cx, cy, r, t, startA, endA, color) {
  const inner = arcPoints(cx, cy, r - t / 2, startA, endA, 18);
  const outer = arcPoints(cx, cy, r + t / 2, startA, endA, 18);
  gfx.fillStyle(color);
  gfx.fillPoints([...outer, ...inner.reverse()], true);
}

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
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#99ddee');
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

  // Fond noir pur
  gfx.fillStyle(0x000000);
  gfx.fillRect(0, 0, W, WORLD_H);

  // Étoiles (200 petites + 40 brillantes avec croix)
  for (let i = 0; i < 240; i++) {
    const sx = Math.random() * W, sy = Math.random() * WORLD_H;
    const big = i < 40;
    const r = big ? 1.5 : 0.7;
    gfx.fillStyle(0xffffff, Math.random() * 0.5 + 0.3);
    gfx.fillCircle(sx, sy, r);
    if (big) {
      gfx.fillStyle(0xffffff, 0.18);
      gfx.fillRect(sx - 4, sy - 0.5, 8, 1);
      gfx.fillRect(sx - 0.5, sy - 4, 1, 8);
    }
  }

  // Murs latéraux cyan
  const wallOpts = { isStatic: true, restitution: 0.15, friction: 0, frictionStatic: 0 };
  gfx.fillStyle(CYAN);
  gfx.fillRect(0, 0, WALL_W, WORLD_H);
  gfx.fillRect(W - WALL_W, 0, WALL_W, WORLD_H);
  scene.matter.add.rectangle(WALL_W / 2, WORLD_H / 2, WALL_W, WORLD_H, wallOpts);
  scene.matter.add.rectangle(W - WALL_W / 2, WORLD_H / 2, WALL_W, WORLD_H, wallOpts);

  // Entonnoir de départ (cyan)
  addFunnel(scene, gfx, SPAWN_Y + 160, 460, 85);

  // --- Sections ---
  // 1. Bols courbés (descente initiale dramatique)
  addBowlSection(scene, gfx, 380, 900, 0);
  addFunnel(scene, gfx, 1320, 340, 90);

  // 2. Plinko / pachinko
  addPlinkoSection(scene, gfx, 1380, 850);
  addFunnel(scene, gfx, 2280, 340, 90);

  // 3. Spinners (palettes rotatives)
  addSpinnerSection(scene, 2340, 880);
  addFunnel(scene, gfx, 3270, 340, 90);

  // 4. Bols courbés décalés à gauche
  addBowlSection(scene, gfx, 3330, 880, -60);
  addFunnel(scene, gfx, 4260, 340, 90);

  // 5. Bumpers rebondissants
  addBumperSection(scene, gfx, 4320, 900);
  addFunnel(scene, gfx, FINISH_Y - 140, 360, 90);

  // Sensor ligne d'arrivée
  scene.matter.add.rectangle(W / 2, FINISH_Y + 15, W + 50, 30, {
    isStatic: true, isSensor: true, label: 'finish',
  });
}

// ---- BOL courbe : arc épais avec gap au fond pour laisser passer les billes ----
function addBowl(scene, gfx, cx, cy, r, gapW) {
  const t = 26;
  const halfGap = Math.asin(Math.min((gapW / 2) / r, 0.95));
  const edgeA = 0.42; // angle (~24°) où les parois latérales commencent

  // Arc droit : de edgeA jusqu'à (π/2 - halfGap)
  const ra1 = edgeA, ra2 = Math.PI / 2 - halfGap;
  // Arc gauche : de (π/2 + halfGap) jusqu'à (π - edgeA)
  const la1 = Math.PI / 2 + halfGap, la2 = Math.PI - edgeA;

  drawThickArc(gfx, cx, cy, r, t, ra1, ra2, CYAN);
  drawThickArc(gfx, cx, cy, r, t, la1, la2, CYAN);

  // Connecteurs horizontaux mur → bord du bol (empêche les billes de bypasser)
  const bowlRightX = cx + r * Math.cos(edgeA);
  const bowlLeftX  = cx + r * Math.cos(Math.PI - edgeA);
  const bowlEdgeY  = cy + r * Math.sin(edgeA);
  const connH = t;

  // Connecteur droit (bord bol → mur droit)
  if (W - WALL_W - bowlRightX > 4) {
    const cw = W - WALL_W - bowlRightX;
    gfx.fillStyle(CYAN);
    gfx.fillRect(bowlRightX, bowlEdgeY - connH / 2, cw, connH);
    scene.matter.add.rectangle(bowlRightX + cw / 2, bowlEdgeY, cw, connH,
      { isStatic: true, friction: 0, restitution: 0.1, frictionStatic: 0 });
  }
  // Connecteur gauche (mur gauche → bord bol)
  if (bowlLeftX - WALL_W > 4) {
    const cw = bowlLeftX - WALL_W;
    gfx.fillStyle(CYAN);
    gfx.fillRect(WALL_W, bowlEdgeY - connH / 2, cw, connH);
    scene.matter.add.rectangle(WALL_W + cw / 2, bowlEdgeY, cw, connH,
      { isStatic: true, friction: 0, restitution: 0.1, frictionStatic: 0 });
  }

  // Physique : 5 segments par arc
  const opts = { isStatic: true, friction: 0, restitution: 0.15, frictionStatic: 0 };
  const N = 5;
  for (let i = 0; i < N; i++) {
    for (const [a1, a2] of [[ra1 + (ra2 - ra1) * i / N, ra1 + (ra2 - ra1) * (i + 1) / N],
                             [la1 + (la2 - la1) * i / N, la1 + (la2 - la1) * (i + 1) / N]]) {
      const aMid = (a1 + a2) / 2;
      scene.matter.add.rectangle(
        cx + r * Math.cos(aMid), cy + r * Math.sin(aMid),
        r * Math.abs(a2 - a1) * 1.2, t,
        { ...opts, angle: aMid + Math.PI / 2 }
      );
    }
  }
}

// Section bols : 3 bols empilés avec décalage horizontal alterné
function addBowlSection(scene, gfx, startY, height, shift) {
  const r = 200, gapW = 75;
  const spacing = height / 3.5;
  for (let i = 0; i < 3; i++) {
    const cx = W / 2 + (i % 2 === 0 ? shift : -shift);
    const cy = startY + (i + 0.8) * spacing;
    addBowl(scene, gfx, cx, cy, r, gapW);
  }
}

// Section Plinko
function addPlinkoSection(scene, gfx, startY, height) {
  const rows = 8, cols = 5, padX = 55;
  const dx = (W - padX * 2) / (cols - 1);
  const dy = height / (rows + 1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = padX + c * dx + (r % 2 === 0 ? 0 : dx / 2);
      const y = startY + (r + 1) * dy;
      if (x < 30 || x > W - 30) continue;
      const pr = 9;
      scene.matter.add.circle(x, y, pr, { isStatic: true, restitution: 0.55, friction: 0, frictionStatic: 0 });
      gfx.fillStyle(CYAN); gfx.fillCircle(x, y, pr);
      gfx.lineStyle(2, 0xaaffff, 0.5); gfx.strokeCircle(x, y, pr + 4);
    }
  }
}

// Section Spinners
function addSpinnerSection(scene, startY, height) {
  const configs = [
    { x: W * 0.33, y: startY + height * 0.18, w: 170, speed:  0.022 },
    { x: W * 0.67, y: startY + height * 0.40, w: 150, speed: -0.030 },
    { x: W * 0.30, y: startY + height * 0.62, w: 160, speed:  0.025 },
    { x: W * 0.70, y: startY + height * 0.82, w: 140, speed: -0.020 },
  ];
  for (const c of configs) {
    const body = scene.matter.add.rectangle(c.x, c.y, c.w, 14, {
      isStatic: true, friction: 0, restitution: 0.4, frictionStatic: 0, label: 'spinner',
    });
    const visual = scene.add.rectangle(c.x, c.y, c.w, 14, 0xffffff).setDepth(5);
    scene.add.rectangle(c.x, c.y, c.w + 8, 22, 0x88eeff, 0.2).setDepth(4);
    spinners.push({ body, visual, speed: c.speed });
  }
}

// Section Bumpers (cyan au lieu de rouge)
function addBumperSection(scene, gfx, startY, height) {
  const pos = [
    { x: 0.25, y: 0.12 }, { x: 0.75, y: 0.12 },
    { x: 0.50, y: 0.28 },
    { x: 0.20, y: 0.46 }, { x: 0.80, y: 0.46 },
    { x: 0.50, y: 0.62 },
    { x: 0.28, y: 0.80 }, { x: 0.72, y: 0.80 },
  ];
  for (const p of pos) {
    const x = W * p.x, y = startY + p.y * height, r = 22;
    scene.matter.add.circle(x, y, r, { isStatic: true, restitution: 0.9, friction: 0, frictionStatic: 0 });
    gfx.fillStyle(CYAN); gfx.fillCircle(x, y, r);
    gfx.lineStyle(3, 0xaaffff, 0.9); gfx.strokeCircle(x, y, r);
    gfx.lineStyle(10, 0x00ccdd, 0.15); gfx.strokeCircle(x, y, r + 8);
  }
}

function addRamp(scene, gfx, cx, cy, w, h, deg, color) {
  const rad = Phaser.Math.DegToRad(deg);
  scene.matter.add.rectangle(cx, cy, w, h, { isStatic: true, angle: rad, friction: 0, restitution: 0.05, frictionStatic: 0 });
  gfx.fillStyle(color);
  gfx.fillPoints(rotatedCorners(cx, cy, w, h, rad), true);
}

function addFunnel(scene, gfx, cy, openW, gapW) {
  const arm = (openW - gapW) / 2;
  addRamp(scene, gfx, W / 2 - gapW / 2 - arm / 2, cy, arm, 14, -22, CYAN);
  addRamp(scene, gfx, W / 2 + gapW / 2 + arm / 2, cy, arm, 14,  22, CYAN);
}
