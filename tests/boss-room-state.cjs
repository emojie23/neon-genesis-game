const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const port = 8893;
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, clean === '/' ? 'index.html' : clean);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

let browser;
(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__GENESIS_DEBUG__);
  await page.evaluate(() => window.__GENESIS_DEBUG__.start());

  const bossIds = ['cherub', 'matriarch', 'hexa', 'cherub', 'matriarch', 'hexa'];
  const lockMatrix = [];
  for (let floor = 1; floor <= 6; floor++) {
    const intro = await page.evaluate(currentFloor => {
      const d = window.__GENESIS_DEBUG__;
      d.loadFloor(currentFloor);
      d.forceEnterType('boss');
      const state = d.bossRoomState();
      const attempted = d.attemptDoor(state.exits[0]);
      return { state, attempted };
    }, floor);
    assert.strictEqual(intro.state.room, 'boss', `floor ${floor} did not enter its boss room`);
    assert.strictEqual(intro.state.mode, 'bossintro', `floor ${floor} boss intro mode missing`);
    assert.strictEqual(intro.state.introVisible, true, `floor ${floor} boss intro overlay missing`);
    assert.strictEqual(intro.state.timerActive, true, `floor ${floor} boss intro timer missing`);
    assert.strictEqual(intro.state.bossCount, 0, `floor ${floor} spawned before its intro ended`);
    assert.strictEqual(intro.attempted.entered, false, `floor ${floor} escaped during boss intro`);

    const phases = await page.evaluate(() => {
      const d = window.__GENESIS_DEBUG__;
      d.spawnBossNow();
      d.tick(30);
      return [0, 1, 2].map(phase => {
        d.setBossPhase(phase);
        const before = d.bossRoomState();
        const attempted = d.attemptDoor(before.exits[0]);
        return { phase, before, attempted, after: d.bossRoomState() };
      });
    });
    for (const result of phases) {
      assert.strictEqual(result.before.bossId, bossIds[floor - 1], `floor ${floor} has the wrong boss`);
      assert.strictEqual(result.before.bossPhase, result.phase, `floor ${floor} phase ${result.phase + 1} failed`);
      assert.strictEqual(result.before.cleared, false, `floor ${floor} was marked clear during combat`);
      assert.strictEqual(result.before.portalPresent, false, `floor ${floor} opened a portal during combat`);
      assert.strictEqual(result.attempted.entered, false, `floor ${floor} phase ${result.phase + 1} door was not locked`);
      assert.strictEqual(result.after.roomKey, result.before.roomKey, `floor ${floor} phase ${result.phase + 1} changed rooms`);
      assert.strictEqual(result.after.bossId, result.before.bossId, `floor ${floor} phase ${result.phase + 1} lost its boss`);
    }
    lockMatrix.push({ floor, boss: phases[0].before.bossId, phases: phases.map(result => !result.attempted.entered) });
  }

  await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.loadFloor(1);
    d.forceEnterType('boss');
  });
  let active = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.spawnBossNow();
    d.tick(30);
    return d.bossRoomState();
  });
  const exit = active.exits[0];
  const boundary = {
    left: { x: 104, y: 365, key: 'a', minX: 104 },
    right: { x: 1176, y: 365, key: 'd', maxX: 1176 },
    up: { x: 640, y: 96, key: 'w', minY: 96 },
    down: { x: 640, y: 634, key: 's', maxY: 634 }
  }[exit];
  assert.ok(boundary, `boss room exposed an unknown exit: ${exit}`);
  await page.evaluate(({ x, y }) => window.__GENESIS_DEBUG__.setPlayer(x, y), boundary);
  await page.keyboard.down(boundary.key);
  const collision = await page.evaluate(() => window.__GENESIS_DEBUG__.simulate(45));
  await page.keyboard.up(boundary.key);
  assert.strictEqual(collision.room, 'boss', 'holding movement against the boss door escaped the room');
  if ('minX' in boundary) assert.ok(collision.x >= boundary.minX, `player crossed the left boss wall: ${collision.x}`);
  if ('maxX' in boundary) assert.ok(collision.x <= boundary.maxX, `player crossed the right boss wall: ${collision.x}`);
  if ('minY' in boundary) assert.ok(collision.y >= boundary.minY, `player crossed the upper boss wall: ${collision.y}`);
  if ('maxY' in boundary) assert.ok(collision.y <= boundary.maxY, `player crossed the lower boss wall: ${collision.y}`);

  await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.loadFloor(1);
    d.forceEnterType('boss');
    d.loadFloor(2);
  });
  await page.waitForTimeout(1650);
  const staleTimer = await page.evaluate(() => window.__GENESIS_DEBUG__.bossRoomState());
  assert.strictEqual(staleTimer.floor, 2, 'stale boss timer changed the current floor');
  assert.strictEqual(staleTimer.room, 'start', 'stale boss timer changed the current room');
  assert.strictEqual(staleTimer.mode, 'playing', 'stale boss timer changed gameplay mode');
  assert.strictEqual(staleTimer.bossCount, 0, 'stale boss timer spawned into a safe room');
  assert.strictEqual(staleTimer.timerActive, false, 'stale boss timer remained active');
  assert.strictEqual(staleTimer.introVisible, false, 'stale boss intro overlay remained visible');

  await page.evaluate(() => window.__GENESIS_DEBUG__.forceEnterType('boss'));
  await page.waitForTimeout(1550);
  const naturalSpawn = await page.evaluate(() => window.__GENESIS_DEBUG__.bossRoomState());
  assert.strictEqual(naturalSpawn.mode, 'playing', 'natural boss intro did not return to gameplay');
  assert.strictEqual(naturalSpawn.bossId, 'matriarch', 'natural boss intro spawned the wrong boss');
  assert.strictEqual(naturalSpawn.bossCount, 1, 'natural boss intro did not spawn exactly one boss');
  assert.strictEqual(naturalSpawn.timerActive, false, 'natural boss intro did not clear its timer');
  assert.strictEqual(naturalSpawn.introVisible, false, 'natural boss intro overlay remained visible');

  const recovered = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.setBossPhase(1);
    const beforeDrop = d.bossRoomState();
    d.dropBoss();
    const dropped = d.bossRoomState();
    d.tick(1);
    const afterDrop = d.bossRoomState();
    d.forceEnterType('start');
    const away = d.bossRoomState();
    d.forceEnterType('boss');
    d.spawnBossNow();
    const afterReentry = d.bossRoomState();
    return { beforeDrop, dropped, afterDrop, away, afterReentry };
  });
  assert.strictEqual(recovered.beforeDrop.bossId, 'matriarch', 'second-floor recovery setup failed');
  assert.strictEqual(recovered.dropped.bossCount, 0, 'fault injection did not remove the boss');
  assert.strictEqual(recovered.dropped.portalPresent, false, 'missing boss incorrectly opened a portal');
  assert.strictEqual(recovered.afterDrop.bossId, 'matriarch', 'missing active boss was not rebuilt');
  assert.strictEqual(recovered.afterDrop.bossCount, 1, 'boss recovery created the wrong number of bosses');
  assert.strictEqual(recovered.afterDrop.portalPresent, false, 'boss recovery opened an early portal');
  assert.strictEqual(recovered.away.room, 'start', 'forced fault injection could not leave the boss room');
  assert.strictEqual(recovered.afterReentry.bossId, 'matriarch', 'boss did not safely restart after abnormal reentry');
  assert.strictEqual(recovered.afterReentry.bossCount, 1, 'abnormal reentry did not restore exactly one boss');

  const defeated = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.injectThreats();
    d.killBoss();
    const killed = d.bossRoomState();
    const rewards = d.progressionState().pedestals.map(item => item.id);
    d.forceEnterType('start');
    d.forceEnterType('boss');
    const returned = d.bossRoomState();
    d.tick(30);
    const unlocked = d.attemptDoor(returned.exits[0]);
    d.forceEnterType('boss');
    const restoredAgain = d.bossRoomState();
    d.takePortal();
    return { killed, rewards, returned, unlocked, restoredAgain, advanced: d.snapshot() };
  });
  assert.strictEqual(defeated.killed.cleared, true, 'boss death did not clear the room');
  assert.strictEqual(defeated.killed.bossActive, false, 'boss death left the room active');
  assert.strictEqual(defeated.killed.bossCount, 0, 'boss survived defeat');
  assert.strictEqual(defeated.killed.enemyBullets, 0, 'boss bullets survived defeat');
  assert.strictEqual(defeated.killed.hazards, 0, 'boss hazards survived defeat');
  assert.strictEqual(defeated.killed.portalReady, true, 'boss death did not persist portal readiness');
  assert.strictEqual(defeated.killed.portalPresent, true, 'boss death did not create a portal');
  assert.strictEqual(defeated.rewards.length, 3, 'boss death did not create three reward choices');
  assert.strictEqual(defeated.returned.bossCount, 0, 'defeated boss respawned on reentry');
  assert.strictEqual(defeated.returned.portalPresent, true, 'portal was lost after leaving and reentering');
  assert.strictEqual(defeated.unlocked.entered, true, 'boss exit stayed locked after defeat');
  assert.strictEqual(defeated.restoredAgain.portalPresent, true, 'portal was lost after a second reentry');
  assert.strictEqual(defeated.advanced.floor, 3, 'restored second-floor portal did not advance');
  assert.strictEqual(defeated.advanced.room, 'start', 'restored portal did not land in the next safe room');

  const selfHealed = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.loadFloor(1);
    d.forceEnterType('boss');
    d.spawnBossNow();
    const broken = d.setBossRoomState({ cleared: true, portalReady: false, bossActive: false });
    d.tick(1);
    return { broken, healed: d.bossRoomState() };
  });
  assert.strictEqual(selfHealed.broken.portalPresent, false, 'soft-lock fault injection did not remove the portal');
  assert.strictEqual(selfHealed.healed.cleared, true, 'soft-lock repair changed the defeated state');
  assert.strictEqual(selfHealed.healed.portalReady, true, 'soft-lock repair did not restore portal readiness');
  assert.strictEqual(selfHealed.healed.portalPresent, true, 'soft-lock repair did not restore the portal');
  assert.strictEqual(selfHealed.healed.bossCount, 0, 'soft-lock repair respawned a defeated boss');

  const illegalPortal = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.loadFloor(1);
    d.forceEnterType('boss');
    d.spawnBossNow();
    const broken = d.setBossRoomState({ cleared: false, portalReady: true, bossActive: false });
    d.tick(1);
    return { broken, healed: d.bossRoomState() };
  });
  assert.strictEqual(illegalPortal.broken.portalReady, true, 'illegal portal fault injection failed');
  assert.strictEqual(illegalPortal.healed.cleared, false, 'illegal portal repair cleared a live fight');
  assert.strictEqual(illegalPortal.healed.portalReady, false, 'illegal portal readiness survived repair');
  assert.strictEqual(illegalPortal.healed.portalPresent, false, 'illegal live-fight portal survived repair');
  assert.strictEqual(illegalPortal.healed.bossActive, true, 'illegal portal repair did not reactivate the boss state');
  assert.strictEqual(illegalPortal.healed.bossCount, 1, 'illegal portal repair lost or duplicated the boss');

  assert.deepStrictEqual(errors, [], `browser errors occurred: ${errors.join(' | ')}`);
  console.log(JSON.stringify({
    ok: true,
    lockMatrix,
    physicalDoor: { exit, room: collision.room, x: collision.x, y: collision.y },
    staleTimer,
    naturalSpawn,
    recovery: recovered.afterDrop,
    portalRestore: defeated.returned,
    softLockRepair: selfHealed.healed,
    illegalPortalRepair: illegalPortal.healed
  }, null, 2));

  await browser.close();
  server.close();
})().catch(async error => {
  console.error(error.stack || error);
  await browser?.close().catch(() => {});
  server.close();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 50);
});
