const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const port = 8895;
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
  if (!file.startsWith(root)) return res.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return res.writeHead(404).end();
    res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
    res.end(data);
  });
});

let browser;
(async () => {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch({channel: 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 810}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1&sprites=1`, {waitUntil: 'networkidle'});
  await page.waitForFunction(() => window.__GENESIS_DEBUG__);
  await page.waitForFunction(() => Object.values(window.__GENESIS_DEBUG__.spriteState()).every(asset => asset.ready));

  const spriteState = await page.evaluate(() => window.__GENESIS_DEBUG__.spriteState());
  assert.deepStrictEqual(Object.keys(spriteState).sort(), ['boss', 'enemy', 'player']);
  for (const [name, asset] of Object.entries(spriteState)) {
    assert.ok(asset.ready && asset.width >= 1200 && asset.height >= 1000, `${name} sprite atlas failed to load`);
  }

  const growth = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.start();
    const model = d.progressionModel();
    const floors = model.powerCurve.map((power, index) => {
      d.loadFloor(index + 1);
      const stats = d.snapshot().stats;
      return {floor: index + 1, power, damage: stats.damage, delay: stats.delay, dps: stats.damage * stats.shots / stats.delay};
    });
    d.start();
    const base = d.snapshot().stats;
    d.giveItem('tune-caliber');
    const caliber = d.snapshot().stats;
    d.giveItem('tune-trigger');
    const trigger = d.snapshot().stats;
    return {model, floors, tuning: {base, caliber, trigger}};
  });
  assert.deepStrictEqual(growth.model.powerCurve, [1, 2, 4, 8, 16, 32]);
  for (let i = 1; i < growth.floors.length; i++) {
    assert.ok(growth.floors[i].damage >= growth.floors[i - 1].damage * 2 - 1e-9,
      `floor ${i + 1} did not at least double player damage`);
    assert.ok(growth.floors[i].dps >= growth.floors[i - 1].dps * 2 - 1e-9,
      `floor ${i + 1} did not at least double player DPS`);
  }
  assert.ok(growth.tuning.caliber.damage >= growth.tuning.base.damage + .74,
    'caliber tuning remains too weak');
  assert.ok(growth.tuning.trigger.delay <= growth.tuning.caliber.delay * .91,
    'trigger tuning remains too weak');

  await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.start();
    d.forceEnterType('combat');
    d.setInvuln(999);
    d.tick(45);
    d.fire(1, 0);
    d.renderNow();
  });
  await page.screenshot({path: path.join(root, 'neon-genesis-sprite-combat.png')});

  await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.loadFloor(3);
    d.forceEnterType('boss');
    d.spawnBossNow();
    d.setBossPhase(2);
    d.setInvuln(999);
    d.tick(20);
    d.renderNow();
  });
  await page.screenshot({path: path.join(root, 'neon-genesis-sprite-boss.png')});

  assert.deepStrictEqual(errors, [], `browser errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ok: true, spriteState, floors: growth.floors, tuning: {
    baseDamage: growth.tuning.base.damage,
    caliberDamage: growth.tuning.caliber.damage,
    triggerDelay: growth.tuning.trigger.delay
  }}, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
