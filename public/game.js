// =====================
// Constants
// =====================
const W = 480;
const H = 854;
const WORLD_H = 9000;
const MARBLE_R = 7;
const SPAWN_Y = 70;
const FINISH_Y = WORLD_H - 200;
const SPAWN_RATE_MS = 60; // ms entre chaque spawn

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

// Phaser objects
let marbleGfx = null;
let uiLeader, uiCount, uiFinished;
let socket;

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
  },
  physics: {
    default: 'matter',
    matter: {
      gravity: { y: 1.8 },
      debug: false,
      positionIterations: 6,
      velocityIterations: 4,
    }
  },
  scene: { preload, create, update }
};

new Phaser.Game(config);

// =====================
// Helpers
// =====================
function hslToInt(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

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

// =====================
// Phaser lifecycle
// =====================
function preload() {}

function create() {
  _scene = this;

  this.matter.world.setBounds(0, 0, W, WORLD_H);
  this.cameras.main.setBounds(0, 0, W, WORLD_H);
  this.matter.world.engine.enableSleeping = true;

  buildTrack(this);

  marbleGfx = this.add.graphics().setDepth(10);

  // UI fixée à la caméra
  uiLeader = this.add.text(10, 10, '', {
    fontSize: '14px', color: '#ffffff',
    backgroundColor: '#00000099', padding: { x: 7, y: 4 }
  }).setScrollFactor(0).setDepth(100);

  uiCount = this.add.text(W - 10, 10, '', {
    fontSize: '14px', color: '#ffffff',
    backgroundColor: '#00000099', padding: { x: 7, y: 4 }
  }).setScrollFactor(0).setDepth(100).setOrigin(1, 0);

  uiFinished = this.add.text(W / 2, H - 16, '', {
    fontSize: '13px', color: '#facc15',
    backgroundColor: '#00000099', padding: { x: 7, y: 4 }
  }).setScrollFactor(0).setDepth(100).setOrigin(0.5, 1);

  // Ligne d'arrivée
  this.add.rectangle(W / 2, FINISH_Y, W, 6, 0xfacc15).setDepth(5);
  this.add.text(W / 2, FINISH_Y - 22, '🏁  ARRIVÉE', {
    fontSize: '20px', color: '#facc15',
    stroke: '#000', strokeThickness: 3
  }).setOrigin(0.5).setDepth(6);

  // Collision finish
  this.matter.world.on('collisionstart', (event) => {
    for (const { bodyA, bodyB } of event.pairs) {
      let mb = null;
      if (bodyB.label === 'finish') mb = bodyA;
      else if (bodyA.label === 'finish') mb = bodyB;
      if (mb && mb.label && mb.label.startsWith('m:')) {
        onFinish(mb.label.slice(2));
      }
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
    document.getElementById('marble-count').textContent =
      parseInt(document.getElementById('marble-count').textContent || '0') + 1;
    if (raceStarted) spawnQueue.push(f);
    else {
      // Mise à jour du compteur avant départ
    }
  });

  socket.on('race_reset', () => location.reload());
}

function update(time) {
  // Spawn progressif
  if (spawnQueue.length > 0 && time - lastSpawnTime >= SPAWN_RATE_MS) {
    doSpawn(spawnQueue.shift());
    lastSpawnTime = time;
  }

  if (!raceStarted || marbles.length === 0) return;

  const camY = _scene.cameras.main.scrollY;

  // Redessine toutes les billes
  marbleGfx.clear();

  for (const m of marbles) {
    const { x, y } = m.body.position;
    const inView = y >= camY - 120 && y <= camY + H + 120;

    if (m.label) m.label.setVisible(inView);
    if (!inView) continue;

    // Corps de la bille
    marbleGfx.fillStyle(m.color, 1);
    marbleGfx.fillCircle(x, y, MARBLE_R);

    // Reflet
    marbleGfx.fillStyle(0xffffff, 0.45);
    marbleGfx.fillCircle(x - 2.5, y - 2.5, 2.5);

    // Update label
    if (m.label) m.label.setPosition(x, y - MARBLE_R - 6);
  }

  // Caméra suit le leader
  const leader = getLeader();
  if (leader) {
    const target = leader.body.position.y - H * 0.35;
    _scene.cameras.main.scrollY = Phaser.Math.Linear(_scene.cameras.main.scrollY, target, 0.07);
    uiLeader.setText('🏆 ' + leader.username);
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

function doSpawn(follower) {
  const x = W / 2 + (Math.random() - 0.5) * 80;
  const hue = Math.random() * 360;
  const colorInt = hslToInt(hue, 80, 62);

  const body = _scene.matter.add.circle(x, SPAWN_Y, MARBLE_R, {
    restitution: 0.55,
    friction: 0.05,
    frictionAir: 0.002,
    density: 0.003,
    sleepThreshold: 120,
    label: `m:${follower.id}`,
  });

  const label = _scene.add.text(x, SPAWN_Y, follower.username, {
    fontSize: '8px', color: '#fff',
    stroke: '#000', strokeThickness: 2,
  }).setOrigin(0.5).setDepth(15);

  const marble = { id: String(follower.id), username: follower.username, body, label, color: colorInt, finished: false };
  marbles.push(marble);
  marbleMap[String(follower.id)] = marble;
}

function onFinish(id) {
  const m = marbleMap[id];
  if (!m || m.finished) return;
  m.finished = true;
  m.rank = results.length + 1;
  results.push(m);

  fetch('/api/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: m.username, position: m.rank }),
  });
}

function getLeader() {
  let best = null, maxY = -Infinity;
  for (const m of marbles) {
    if (!m.finished && m.body.position.y > maxY) {
      maxY = m.body.position.y;
      best = m;
    }
  }
  return best || marbles[0] || null;
}

// =====================
// Track generation
// =====================
function buildTrack(scene) {
  const gfx = scene.add.graphics().setDepth(1);

  // Fond alterné par bandes
  for (let y = 0; y < WORLD_H; y += 900) {
    gfx.fillStyle(y % 1800 === 0 ? 0x0d0d1a : 0x111126, 1);
    gfx.fillRect(0, y, W, 900);
  }

  // Murs latéraux
  gfx.fillStyle(0x1e1e4a);
  gfx.fillRect(0, 0, 18, WORLD_H);
  gfx.fillRect(W - 18, 0, 18, WORLD_H);
  scene.matter.add.rectangle(9, WORLD_H / 2, 18, WORLD_H, { isStatic: true, label: 'wall' });
  scene.matter.add.rectangle(W - 9, WORLD_H / 2, 18, WORLD_H, { isStatic: true, label: 'wall' });

  // Entonnoir de départ
  addFunnel(scene, gfx, SPAWN_Y + 130, 360, 90);

  // Sections de piste
  const types = ['pegs', 'ramps', 'bumpers'];
  const sectionH = 650;
  const startY = SPAWN_Y + 300;
  const numSections = Math.floor((FINISH_Y - startY - 100) / sectionH);

  for (let i = 0; i < numSections; i++) {
    const yBase = startY + i * sectionH;
    const type = types[i % types.length];

    if (type === 'pegs')    addPegs(scene, gfx, yBase, sectionH);
    if (type === 'ramps')   addRamps(scene, gfx, yBase, sectionH);
    if (type === 'bumpers') addBumpers(scene, gfx, yBase, sectionH);

    // Mini-entonnoir entre sections
    if (i < numSections - 1) addFunnel(scene, gfx, yBase + sectionH - 40, 200, 70);
  }

  // Sensor d'arrivée (invisible)
  scene.matter.add.rectangle(W / 2, FINISH_Y + 10, W + 50, 30, {
    isStatic: true, isSensor: true, label: 'finish'
  });
}

function addRamp(scene, gfx, cx, cy, w, h, deg, color) {
  const rad = Phaser.Math.DegToRad(deg);
  scene.matter.add.rectangle(cx, cy, w, h, {
    isStatic: true, angle: rad, friction: 0.02, restitution: 0.3, label: 'ramp'
  });
  gfx.fillStyle(color);
  gfx.fillPoints(rotatedCorners(cx, cy, w, h, rad), true);
}

function addFunnel(scene, gfx, cy, openW, gapW) {
  const armLen = (openW - gapW) / 2;
  const deg = 22;
  const lx = W / 2 - gapW / 2 - armLen / 2;
  const rx = W / 2 + gapW / 2 + armLen / 2;
  addRamp(scene, gfx, lx, cy, armLen, 10, -deg, 0x2a2a6a);
  addRamp(scene, gfx, rx, cy, armLen, 10,  deg, 0x2a2a6a);
}

function addPegs(scene, gfx, yBase, height) {
  const rows = 7, cols = 6, padX = 32;
  const dx = (W - padX * 2) / (cols - 1);
  const dy = height / (rows + 2);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const offset = r % 2 === 0 ? 0 : dx / 2;
      const x = padX + c * dx + offset;
      const y = yBase + (r + 1) * dy;
      if (x < 22 || x > W - 22) continue;

      const pr = 5 + Math.random() * 4;
      scene.matter.add.circle(x, y, pr, { isStatic: true, restitution: 0.45, friction: 0.02 });
      gfx.fillStyle(0x5566cc); gfx.fillCircle(x, y, pr);
      gfx.lineStyle(1.5, 0x8899ff, 0.6); gfx.strokeCircle(x, y, pr);
    }
  }
}

function addRamps(scene, gfx, yBase, height) {
  const count = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    const x = 45 + Math.random() * (W - 90);
    const y = yBase + (height / count) * i + 40 + Math.random() * 60;
    const w = 75 + Math.random() * 110;
    const deg = (Math.random() - 0.5) * 50;
    addRamp(scene, gfx, x, y, w, 10, deg, 0x4455aa);
  }
}

function addBumpers(scene, gfx, yBase, height) {
  const count = 5 + Math.floor(Math.random() * 5);
  for (let i = 0; i < count; i++) {
    const x = 35 + Math.random() * (W - 70);
    const y = yBase + Math.random() * height * 0.85 + 40;
    const r = 13 + Math.random() * 13;
    scene.matter.add.circle(x, y, r, { isStatic: true, restitution: 1.05, friction: 0 });
    gfx.fillStyle(0xcc2255); gfx.fillCircle(x, y, r);
    gfx.lineStyle(2.5, 0xff4488, 0.8); gfx.strokeCircle(x, y, r);
  }
}
