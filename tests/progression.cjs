const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const port = 8892;
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

function unique(values) {
  return new Set(values).size === values.length;
}

function closeTo(actual, expected, epsilon = 1e-9) {
  return Math.abs(actual - expected) <= epsilon;
}

(async () => {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(`http://127.0.0.1:${port}/index.html?test=1&progression=1`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForFunction(() => window.__GENESIS_DEBUG__);
  await page.evaluate(() => window.__GENESIS_DEBUG__.start());

  const model = await page.evaluate(() => window.__GENESIS_DEBUG__.progressionModel());
  const itemMeta = Object.fromEntries(model.items.map(item => [item.id, item]));
  const tuningIds = new Set(model.tunings.map(item => item.id));
  const ascensionIds = new Set(model.ascensions.map(item => item.id));
  assert.strictEqual(model.totalFloors, 6, 'progression must contain exactly six implemented floors');
  assert.strictEqual(model.floors.length, 6, 'progression model and floor count diverged');
  assert.deepStrictEqual(model.powerCurve, [1, 2, 4, 8, 16, 32],
    'floor power curve must at least double after every completed sector');
  assert.strictEqual(model.startKeys, 0, 'the run should begin without a pre-granted deep-room key');
  assert.strictEqual(model.keyCap, 3, 'key inventory cap changed unexpectedly');
  assert.strictEqual(model.pityMax, 2, 'two misses should guarantee growth on the following clear');
  assert.deepStrictEqual(model.gates, { treasure: 0, shop: 0, vault: 1, sanctum: 2 });

  const firstGrowthChances = [];
  for (const floor of model.floors) {
    assert.strictEqual(floor.roomTypes.filter(type => type === 'combat').length, 3,
      `floor ${floor.floor} must expose three normal combat growth opportunities`);
    assert.ok(floor.roomTypes.includes('start') && floor.roomTypes.includes('treasure') &&
      floor.roomTypes.includes('shop') && floor.roomTypes.includes('boss'),
    `floor ${floor.floor} is missing a core room type`);
    assert.strictEqual(floor.growthChances.length, 3,
      `floor ${floor.floor} growth curve does not match its combat rooms`);
    assert.ok(floor.growthChances.every((chance, index, all) =>
      chance > 0 && chance < 1 && (!index || chance > all[index - 1])),
    `floor ${floor.floor} growth chances must rise room by room`);
    assert.ok(closeTo(Object.values(floor.growthTiers).reduce((sum, value) => sum + value, 0), 1),
      `floor ${floor.floor} growth tier weights do not total 1`);
    assert.ok(closeTo(Object.values(floor.supply).reduce((sum, value) => sum + value, 0), 1),
      `floor ${floor.floor} supply weights do not total 1`);
    assert.strictEqual(floor.choiceCount, floor.floor <= 3 ? 2 : 3,
      `floor ${floor.floor} choice count does not transition from two to three`);
    if (floor.floor <= 3) {
      assert.ok(floor.supply.key > 0, `floor ${floor.floor} has no key drop probability`);
      assert.notStrictEqual(floor.keyGuarantee, 'none', `floor ${floor.floor} has no key pity rule`);
    } else {
      assert.strictEqual(floor.supply.key, 0, `floor ${floor.floor} must not generate new keys`);
      assert.strictEqual(floor.keyGuarantee, 'none', `floor ${floor.floor} must not advertise a key guarantee`);
      assert.ok(floor.roomTypes.includes('vault'), `floor ${floor.floor} is missing its keyed vault`);
    }
    firstGrowthChances.push(floor.growthChances[0]);
  }
  assert.ok(firstGrowthChances.every((chance, index) => !index || chance > firstGrowthChances[index - 1]),
    'growth probability must increase from early floors to late floors');
  assert.ok(model.floors[5].roomTypes.includes('sanctum'), 'the final floor is missing its two-key sanctum');

  const previews = await page.evaluate(floors => {
    const d = window.__GENESIS_DEBUG__;
    return floors.flatMap(floor => floor.growthChances.map((probability, rank) => ({
      floor: floor.floor,
      rank,
      probability,
      below: d.previewGrowth(floor.floor, rank, probability - 1e-7, 0, 0.5),
      edge: d.previewGrowth(floor.floor, rank, probability, 0, 0.5),
      pity: d.previewGrowth(floor.floor, rank, 0.999999, 2, 0.5)
    })));
  }, model.floors);
  for (const preview of previews) {
    assert.strictEqual(preview.below.spawn, true,
      `floor ${preview.floor} room ${preview.rank + 1} rejected a roll inside its growth band`);
    assert.strictEqual(preview.edge.spawn, false,
      `floor ${preview.floor} room ${preview.rank + 1} growth boundary must use a strict comparison`);
    assert.strictEqual(preview.pity.spawn, true,
      `floor ${preview.floor} room ${preview.rank + 1} ignored the two-miss pity`);
    assert.strictEqual(preview.below.choices, preview.floor <= 3 ? 2 : 3,
      `floor ${preview.floor} preview exposes the wrong choice count`);
  }

  const freeRooms = [];
  for (let floor = 1; floor <= model.totalFloors; floor++) {
    const result = await page.evaluate(floorNumber => {
      const d = window.__GENESIS_DEBUG__;
      d.loadFloor(floorNumber);
      d.setResources({ keys: 0 });
      const treasureEntry = d.tryEnterType('treasure');
      const treasureFirst = d.progressionState().pedestals;
      d.tryEnterType('start');
      const treasureReentry = d.tryEnterType('treasure');
      const treasureSecond = d.progressionState().pedestals;
      d.tryEnterType('start');
      const shopEntry = d.tryEnterType('shop');
      const shopFirst = d.progressionState().pedestals;
      d.tryEnterType('start');
      const shopReentry = d.tryEnterType('shop');
      const shopSecond = d.progressionState().pedestals;
      d.renderNow();
      return {
        treasureEntry,
        treasureReentry,
        treasureFirst,
        treasureSecond,
        shopEntry,
        shopReentry,
        shopFirst,
        shopSecond
      };
    }, floor);
    assert.ok(result.treasureEntry.entered && result.treasureReentry.entered,
      `floor ${floor} treasure room is not freely enterable`);
    assert.strictEqual(result.treasureEntry.beforeKeys, 0);
    assert.strictEqual(result.treasureEntry.afterKeys, 0);
    assert.strictEqual(result.treasureFirst.length, 2, `floor ${floor} treasure room is not a two-choice reward`);
    assert.ok(result.treasureFirst.every(item => item.cost === 0) &&
      unique(result.treasureFirst.map(item => item.id)),
    `floor ${floor} treasure choices are paid or duplicated`);
    assert.deepStrictEqual(result.treasureSecond.map(item => item.id), result.treasureFirst.map(item => item.id),
      `floor ${floor} treasure choices rerolled after leaving`);
    assert.ok(result.shopEntry.entered && result.shopReentry.entered,
      `floor ${floor} shop is not freely enterable`);
    assert.strictEqual(result.shopEntry.beforeKeys, 0);
    assert.strictEqual(result.shopEntry.afterKeys, 0);
    assert.strictEqual(result.shopFirst.length, 3, `floor ${floor} shop does not contain three offers`);
    assert.ok(result.shopFirst.every(item => item.cost > 0) && unique(result.shopFirst.map(item => item.id)),
      `floor ${floor} shop inventory is free or duplicated`);
    assert.deepStrictEqual(result.shopSecond.map(item => item.id), result.shopFirst.map(item => item.id),
      `floor ${floor} shop inventory rerolled after leaving`);
    freeRooms.push({ floor, treasure: result.treasureFirst.map(item => item.id), shop: result.shopFirst.map(item => item.id) });
  }

  const shopPersistence = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.start();
    d.setResources({ coins: 99 });
    d.tryEnterType('shop');
    const before = d.progressionState();
    d.tick(8);
    const idleAtCenter = { snapshot: d.snapshot(), progression: d.progressionState() };
    const firstId = before.pedestals[0].id;
    const firstCost = before.pedestals[0].cost;
    const claimed = d.takePedestal(0);
    const afterPurchase = { snapshot: d.snapshot(), progression: d.progressionState() };
    d.tryEnterType('start');
    d.tryEnterType('shop');
    const reentered = d.progressionState();
    d.start();
    d.setResources({ coins: 99 });
    d.tryEnterType('shop');
    const staleId = d.progressionState().pedestals[0].id;
    d.giveItem(staleId);
    const staleBeforeCoins = d.snapshot().coins;
    const staleClaimed = d.takePedestal(0);
    const staleAfter = { snapshot: d.snapshot(), progression: d.progressionState() };
    return { before, idleAtCenter, firstId, firstCost, claimed, afterPurchase, reentered, staleId, staleBeforeCoins, staleClaimed, staleAfter };
  });
  assert.ok(shopPersistence.before.pedestals.some(item => item.requiresExit),
    'shop did not arm an overlap-safe middle shelf');
  assert.strictEqual(shopPersistence.idleAtCenter.snapshot.coins, 99,
    'shop automatically charged the player while standing on a newly spawned shelf');
  assert.strictEqual(shopPersistence.idleAtCenter.progression.pedestals.length, 3,
    'shop automatically claimed a newly spawned shelf before the player moved');
  assert.strictEqual(shopPersistence.claimed, true, 'valid shop stock could not be purchased');
  assert.strictEqual(shopPersistence.afterPurchase.snapshot.coins, 99 - shopPersistence.firstCost,
    'valid shop purchase deducted the wrong amount of DATA');
  assert.strictEqual(shopPersistence.afterPurchase.progression.pedestals.length, 2,
    'purchased shop shelf did not disappear immediately');
  assert.strictEqual(shopPersistence.reentered.pedestals.length, 2,
    'purchased shop shelf respawned after leaving');
  assert.ok(!shopPersistence.reentered.pedestals.some(item => item.id === shopPersistence.firstId),
    'purchased shop item returned after reentry');
  assert.strictEqual(shopPersistence.staleClaimed, false, 'already-owned shop stock was purchased twice');
  assert.strictEqual(shopPersistence.staleAfter.snapshot.coins, shopPersistence.staleBeforeCoins,
    'already-owned shop stock deducted DATA before validation');

  const exhaustedPools = await page.evaluate(modelData => {
    const d = window.__GENESIS_DEBUG__;
    d.start();
    d.loadFloor(6);
    for (const item of modelData.items) d.giveItem(item.id);
    for (const tuning of modelData.tunings) {
      for (let level = 0; level < tuning.max; level++) d.giveItem(tuning.id);
    }
    d.tryEnterType('treasure');
    const treasure = d.progressionState();
    const chargeBefore = d.snapshot().activeCharge;
    d.reroll();
    const rerolled = { snapshot: d.snapshot(), progression: d.progressionState() };
    d.tryEnterType('start');
    d.setResources({ keys: 2 });
    d.tryEnterType('sanctum');
    const sanctum = d.progressionState();
    return { treasure, chargeBefore, rerolled, sanctum };
  }, model);
  assert.strictEqual(exhaustedPools.treasure.pedestals.length, 2,
    'exhausted standard pool produced an empty treasure room');
  assert.ok(exhaustedPools.treasure.pedestals.every(item => item.category === 'ascension') &&
    unique(exhaustedPools.treasure.pedestals.map(item => item.id)),
  'treasure pool did not fall back to unique repeatable ascensions');
  assert.strictEqual(exhaustedPools.rerolled.progression.pedestals.length, 2,
    'entropy reroll emptied an exhausted reward pool');
  assert.strictEqual(exhaustedPools.rerolled.snapshot.activeCharge, exhaustedPools.chargeBefore - 3,
    'successful exhausted-pool reroll did not consume one full charge');
  assert.strictEqual(exhaustedPools.sanctum.pedestals.length, 3,
    'exhausted rare pool produced an empty sanctum');
  assert.ok(exhaustedPools.sanctum.pedestals.every(item => item.category === 'ascension') &&
    unique(exhaustedPools.sanctum.pedestals.map(item => item.id)),
  'sanctum pool did not fall back to three unique ascensions');

  const keyGuarantees = [];
  for (let floor = 1; floor <= 3; floor++) {
    const result = await page.evaluate(floorNumber => {
      const d = window.__GENESIS_DEBUG__;
      d.start();
      d.setResources({ keys: 0 });
      d.enterCombat(floorNumber, 2);
      d.forceSupply('coin');
      d.forceReward('none');
      d.clearRoom();
      d.tick(1);
      const beforeCollect = d.progressionState();
      const afterCollect = d.collectAllPickups();
      return { beforeCollect, afterCollect };
    }, floor);
    assert.ok(result.beforeCollect.pickupKinds.includes('key'),
      `floor ${floor} final combat did not guarantee an early key`);
    assert.strictEqual(result.beforeCollect.floorKeysSpawned, 1,
      `floor ${floor} key guarantee did not update its per-floor counter`);
    assert.strictEqual(result.afterCollect.keys, 1, `floor ${floor} guaranteed key could not be collected`);
    keyGuarantees.push({ floor, pickups: result.beforeCollect.pickupKinds, keys: result.afterCollect.keys });
  }

  const lateSupplyChecks = [];
  for (let floor = 4; floor <= 6; floor++) {
    const result = await page.evaluate(floorNumber => {
      const d = window.__GENESIS_DEBUG__;
      d.start();
      d.setResources({ keys: 0 });
      d.enterCombat(floorNumber, 2);
      d.forceSupply('key');
      d.forceReward('none');
      d.clearRoom();
      d.tick(1);
      return d.progressionState();
    }, floor);
    assert.ok(!result.pickupKinds.includes('key'), `floor ${floor} generated a forbidden late key`);
    assert.ok(result.pickupKinds.includes('coin'), `floor ${floor} did not convert a late key roll to DATA`);
    assert.strictEqual(result.floorKeysSpawned, 0, `floor ${floor} incorrectly counted a late key`);
    lateSupplyChecks.push({ floor, pickups: result.pickupKinds });
  }

  const secretKeyChecks = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.loadFloor(3);
    d.tryEnterType('secret');
    const early = d.progressionState().pickupKinds;
    d.loadFloor(4);
    d.tryEnterType('secret');
    const late = d.progressionState().pickupKinds;
    d.start();
    d.setResources({ keys: 3 });
    d.spawnPickup('key', 1);
    const capped = d.collectAllPickups().keys;
    return { early, late, capped };
  });
  assert.ok(secretKeyChecks.early.includes('key'), 'floor 3 secret cache no longer supports early key preparation');
  assert.ok(!secretKeyChecks.late.includes('key'), 'floor 4 secret cache bypasses the early-only key economy');
  assert.strictEqual(secretKeyChecks.capped, model.keyCap, 'key pickup exceeded the declared inventory cap');

  const persistentPickups = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.start();
    d.enterCombat(1, 0);
    d.forceSupply('key');
    d.forceReward('none');
    d.clearRoom();
    d.tick(1);
    const combatFirst = d.progressionState().pickupKinds;
    d.tryEnterType('start');
    d.tryEnterType('combat');
    const combatSecond = d.progressionState().pickupKinds;
    d.collectAllPickups();
    d.tryEnterType('start');
    d.tryEnterType('combat');
    const combatAfterCollect = d.progressionState().pickupKinds;
    d.loadFloor(1);
    d.tryEnterType('secret');
    const secretFirst = d.progressionState().pickupKinds;
    d.tryEnterType('start');
    d.tryEnterType('secret');
    const secretSecond = d.progressionState().pickupKinds;
    d.collectAllPickups();
    d.tryEnterType('start');
    d.tryEnterType('secret');
    const secretAfterCollect = d.progressionState().pickupKinds;
    return { combatFirst, combatSecond, combatAfterCollect, secretFirst, secretSecond, secretAfterCollect };
  });
  assert.strictEqual(persistentPickups.combatFirst.filter(kind => kind === 'key').length, 1,
    'forced combat key supply was not created exactly once');
  assert.strictEqual(persistentPickups.combatSecond.filter(kind => kind === 'key').length, 1,
    'uncollected combat key disappeared after leaving its cleared room');
  assert.strictEqual(persistentPickups.combatAfterCollect.filter(kind => kind === 'key').length, 0,
    'collected combat key respawned on a later visit');
  assert.deepStrictEqual(persistentPickups.secretSecond, persistentPickups.secretFirst,
    'uncollected secret cache changed after leaving the room');
  assert.deepStrictEqual(persistentPickups.secretAfterCollect, [],
    'collected secret cache could be farmed again by re-entering');

  await page.evaluate(() => window.__GENESIS_DEBUG__.start());
  const pityRun = [];
  for (let rank = 0; rank < 3; rank++) {
    const result = await page.evaluate(rankNumber => {
      const d = window.__GENESIS_DEBUG__;
      d.enterCombat(1, rankNumber);
      d.forceSupply('coin');
      d.forceReward('none');
      d.clearRoom();
      d.tick(1);
      return { snapshot: d.snapshot(), progression: d.progressionState() };
    }, rank);
    pityRun.push(result);
  }
  assert.strictEqual(pityRun[0].progression.growthMisses, 1, 'first growth miss was not recorded');
  assert.strictEqual(pityRun[0].progression.room.rewardTier, 'none');
  assert.strictEqual(pityRun[0].progression.pedestals.length, 0);
  assert.strictEqual(pityRun[1].progression.growthMisses, 2, 'second growth miss did not arm pity');
  assert.strictEqual(pityRun[1].progression.room.rewardTier, 'none');
  assert.strictEqual(pityRun[2].progression.growthMisses, 0, 'pity did not reset after granting growth');
  assert.notStrictEqual(pityRun[2].progression.room.rewardTier, 'none', 'pity did not override the forced miss');
  assert.strictEqual(pityRun[2].progression.pedestals.length, 2, 'early pity reward is not a two-choice terminal');
  assert.ok(unique(pityRun[2].progression.pedestals.map(item => item.id)), 'early pity choices are duplicated');

  const persistentGrowth = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.start();
    d.enterCombat(4, 0);
    d.forceSupply('coin');
    d.forceReward('skill');
    d.clearRoom();
    d.tick(8);
    const cleared = d.progressionState();
    const clearedSnapshot = d.snapshot();
    const originalIds = cleared.pedestals.map(item => item.id);
    d.tryEnterType('start');
    d.tryEnterType('combat');
    const revisited = d.progressionState();
    const selectedId = revisited.pedestals[1]?.id;
    const claimed = d.takePedestal(1);
    const afterClaim = { snapshot: d.snapshot(), progression: d.progressionState() };
    d.tryEnterType('start');
    d.tryEnterType('combat');
    const afterSecondVisit = { snapshot: d.snapshot(), progression: d.progressionState() };
    return { cleared, clearedSnapshot, originalIds, revisited, selectedId, claimed, afterClaim, afterSecondVisit };
  });
  assert.strictEqual(persistentGrowth.cleared.room.rewardTier, 'skill');
  assert.strictEqual(persistentGrowth.cleared.pedestals.length, 3,
    'floor 4 ordinary growth did not expose three choices');
  assert.ok(persistentGrowth.cleared.pedestals.some(item => item.requiresExit),
    'ordinary growth terminal did not protect an option spawned under the player');
  assert.ok(unique(persistentGrowth.originalIds), 'ordinary growth options contain duplicates');
  assert.ok(persistentGrowth.originalIds.every(id => !itemMeta[id] || itemMeta[id].rarity !== 'rare'),
    'skill-tier ordinary growth leaked a rare core');
  assert.ok(persistentGrowth.cleared.pedestals.every(item => item.cost === 0 && item.group),
    'ordinary growth choices are not one free exclusive group');
  assert.deepStrictEqual(persistentGrowth.revisited.pedestals.map(item => item.id), persistentGrowth.originalIds,
    'ordinary growth choices rerolled after leaving the room');
  assert.strictEqual(persistentGrowth.claimed, true, 'a valid ordinary growth choice could not be claimed');
  assert.ok(persistentGrowth.afterClaim.snapshot.items.includes(persistentGrowth.selectedId) ||
    persistentGrowth.afterClaim.snapshot.upgrades[persistentGrowth.selectedId] === 1,
  'the selected growth option did not change the player build');
  assert.strictEqual(persistentGrowth.afterClaim.progression.pedestals.length, 0,
    'unselected ordinary growth options remained after choosing one');
  assert.strictEqual(persistentGrowth.afterClaim.progression.room.rewardTaken, true,
    'ordinary growth room did not remember its claimed state');
  assert.strictEqual(persistentGrowth.afterSecondVisit.progression.pedestals.length, 0,
    'claimed ordinary growth respawned on a later visit');
  assert.strictEqual(persistentGrowth.afterSecondVisit.snapshot.roomsCleared,
    persistentGrowth.clearedSnapshot.roomsCleared, 'revisiting a cleared room incremented clear count');
  await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.start();
    d.enterCombat(4, 0);
    d.forceSupply('coin');
    d.forceReward('skill');
    d.clearRoom();
    d.tick(1);
    d.renderNow();
  });
  await page.waitForTimeout(300);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#item-banner')).opacity === '0');
  await page.screenshot({ path: path.join(root, 'neon-genesis-growth-terminal.png') });

  const specialRooms = [];
  for (let floor = 4; floor <= 6; floor++) {
    const result = await page.evaluate(floorNumber => {
      const d = window.__GENESIS_DEBUG__;
      d.loadFloor(floorNumber);
      d.setResources({ keys: 0 });
      const blocked = d.tryEnterType('vault');
      d.setResources({ keys: 1 });
      const opened = d.tryEnterType('vault');
      const first = d.progressionState();
      const ids = first.pedestals.map(item => item.id);
      d.tryEnterType('start');
      d.setResources({ keys: 0 });
      const reopened = d.tryEnterType('vault');
      const second = d.progressionState();
      return { blocked, opened, first, ids, reopened, second };
    }, floor);
    assert.strictEqual(result.blocked.entered, false, `floor ${floor} vault opened without a key`);
    assert.strictEqual(result.blocked.current, 'start', `floor ${floor} failed vault entry moved the player`);
    assert.strictEqual(result.blocked.visited, false, `floor ${floor} failed vault entry marked it visited`);
    assert.ok(result.opened.entered, `floor ${floor} vault rejected one key`);
    assert.strictEqual(result.opened.beforeKeys, 1);
    assert.strictEqual(result.opened.afterKeys, 0);
    assert.strictEqual(result.first.pedestals.length, 3, `floor ${floor} vault is not a three-choice reward`);
    assert.ok(unique(result.ids), `floor ${floor} vault choices are duplicated`);
    assert.ok(result.ids.every(id => tuningIds.has(id) || ascensionIds.has(id) || itemMeta[id]?.rarity !== 'common'),
      `floor ${floor} vault leaked a common relic into its high-value pool`);
    assert.ok(result.reopened.entered, `floor ${floor} visited vault could not be reopened`);
    assert.strictEqual(result.reopened.beforeKeys, 0);
    assert.strictEqual(result.reopened.afterKeys, 0, `floor ${floor} visited vault charged a second key`);
    assert.deepStrictEqual(result.second.pedestals.map(item => item.id), result.ids,
      `floor ${floor} vault choices rerolled on reentry`);
    specialRooms.push({ floor, ids: result.ids });
  }

  const sanctum = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.loadFloor(6);
    d.setResources({ keys: 1 });
    const blocked = d.tryEnterType('sanctum');
    d.setResources({ keys: 2 });
    const opened = d.tryEnterType('sanctum');
    const first = d.progressionState();
    const ids = first.pedestals.map(item => item.id);
    d.tryEnterType('start');
    d.setResources({ keys: 0 });
    const reopened = d.tryEnterType('sanctum');
    const second = d.progressionState();
    return { blocked, opened, first, ids, reopened, second };
  });
  assert.strictEqual(sanctum.blocked.entered, false, 'sanctum opened with only one key');
  assert.strictEqual(sanctum.opened.beforeKeys, 2);
  assert.strictEqual(sanctum.opened.afterKeys, 0);
  assert.strictEqual(sanctum.first.pedestals.length, 3, 'sanctum is not a three-choice reward');
  assert.ok(unique(sanctum.ids), 'sanctum choices are duplicated');
  assert.ok(sanctum.ids.every(id => ascensionIds.has(id) || itemMeta[id]?.rarity === 'rare'),
    'sanctum leaked a non-rare standard item');
  assert.ok(sanctum.reopened.entered && sanctum.reopened.afterKeys === 0,
    'visited sanctum charged keys again');
  assert.deepStrictEqual(sanctum.second.pedestals.map(item => item.id), sanctum.ids,
    'sanctum choices rerolled on reentry');

  const powerCurve = await page.evaluate(() => {
    const d = window.__GENESIS_DEBUG__;
    d.start();
    const base = d.progressionState();
    const script = [
      'tune-caliber',
      'tune-trigger',
      'redchip',
      'overclock',
      'prism',
      'phase'
    ];
    const stages = script.map((id, index) => {
      d.loadFloor(index + 1);
      d.giveItem(id);
      const snapshot = d.snapshot();
      const progression = d.progressionState();
      return { floor: index + 1, id, snapshot, progression };
    });
    return { base, stages };
  });
  const baseStats = powerCurve.base.stats;
  const stageStats = powerCurve.stages.map(stage => stage.progression.stats);
  assert.ok(stageStats.every((stats, index) => !index || stats.dps >= stageStats[index - 1].dps * 2),
    'scripted build did not at least double offensive power between floors');
  assert.ok(stageStats[0].dps >= baseStats.dps * 1.2,
    'the first tuning choice is still too weak to feel meaningful');
  const lateStats = stageStats.at(-1);
  assert.ok(lateStats.damage > baseStats.damage && lateStats.delay < baseStats.delay,
    'late build did not improve both damage and firing cadence');
  assert.ok(lateStats.shots >= baseStats.shots + 2 && lateStats.pierce >= baseStats.pierce + 2,
    'late build lacks multishot or penetration growth');
  assert.ok(lateStats.dps >= baseStats.dps * 32,
    `late build power spike is too small: ${baseStats.dps} -> ${lateStats.dps}`);

  await page.evaluate(() => window.__GENESIS_DEBUG__.start());
  const bossIds = ['cherub', 'matriarch', 'hexa', 'cherub', 'matriarch', 'hexa'];
  const bosses = [];
  for (let floor = 1; floor <= model.totalFloors; floor++) {
    const result = await page.evaluate(() => {
      const d = window.__GENESIS_DEBUG__;
      const before = d.snapshot();
      const entry = d.tryEnterType('boss');
      const spawned = d.spawnBossNow();
      d.setBossPhase(1);
      const phaseTwo = d.snapshot();
      d.setBossPhase(2);
      const phaseThree = d.snapshot();
      d.killBoss();
      const defeated = d.snapshot();
      const reward = d.progressionState();
      const rewardIds = reward.pedestals.map(item => item.id);
      const claimed = d.takePedestal(0);
      const afterClaim = d.progressionState();
      d.takePortal();
      const afterPortal = d.snapshot();
      return { before, entry, spawned, phaseTwo, phaseThree, defeated, reward, rewardIds, claimed, afterClaim, afterPortal };
    });
    assert.strictEqual(result.before.floor, floor, `boss flow reached floor ${floor} out of sequence`);
    assert.ok(result.entry.entered, `floor ${floor} boss room could not be entered`);
    assert.strictEqual(result.spawned.boss, bossIds[floor - 1], `floor ${floor} spawned the wrong boss`);
    assert.strictEqual(result.spawned.bossPhase, 0, `floor ${floor} boss did not begin in phase one`);
    assert.strictEqual(result.phaseTwo.bossPhase, 1, `floor ${floor} boss phase two failed`);
    assert.strictEqual(result.phaseThree.bossPhase, 2, `floor ${floor} boss phase three failed`);
    assert.strictEqual(result.defeated.boss, null, `floor ${floor} boss survived killBoss`);
    assert.strictEqual(result.defeated.enemyBullets, 0, `floor ${floor} boss bullets survived death`);
    assert.strictEqual(result.defeated.hazards, 0, `floor ${floor} boss hazards survived death`);
    assert.strictEqual(result.reward.pedestals.length, 3, `floor ${floor} boss did not grant three choices`);
    assert.ok(unique(result.rewardIds), `floor ${floor} boss reward choices are duplicated`);
    assert.strictEqual(result.claimed, true, `floor ${floor} boss reward could not be claimed`);
    assert.strictEqual(result.afterClaim.pedestals.length, 0,
      `floor ${floor} unselected boss rewards remained after claiming one`);
    if (floor < model.totalFloors) {
      assert.strictEqual(result.afterPortal.floor, floor + 1, `floor ${floor} portal did not advance`);
      assert.strictEqual(result.afterPortal.room, 'start', `floor ${floor} portal did not land in a safe node`);
      assert.strictEqual(result.afterPortal.mode, 'playing', `floor ${floor} portal left gameplay mode`);
    } else {
      assert.strictEqual(result.afterPortal.mode, 'gameover', 'final portal did not finish the run');
      assert.strictEqual(result.afterPortal.victory, true, 'sixth boss did not produce victory');
    }
    bosses.push({
      floor,
      boss: result.spawned.boss,
      rewards: result.rewardIds,
      next: result.afterPortal.floor,
      victory: result.afterPortal.victory
    });
  }

  assert.deepStrictEqual(errors, [], `browser errors occurred: ${errors.join(' | ')}`);
  console.log(JSON.stringify({
    ok: true,
    model: {
      floors: model.totalFloors,
      startKeys: model.startKeys,
      keyCap: model.keyCap,
      pityMax: model.pityMax,
      choices: model.floors.map(floor => floor.choiceCount),
      firstGrowthChances
    },
    freeRooms,
    shopPersistence: {
      purchased: shopPersistence.firstId,
      remaining: shopPersistence.reentered.pedestals.map(item => item.id),
      stale: shopPersistence.staleId
    },
    exhaustedPools: {
      treasure: exhaustedPools.treasure.pedestals.map(item => item.id),
      rerolled: exhaustedPools.rerolled.progression.pedestals.map(item => item.id),
      sanctum: exhaustedPools.sanctum.pedestals.map(item => item.id)
    },
    keyGuarantees,
    lateSupplyChecks,
    secretKeyChecks,
    persistentPickups,
    pity: pityRun.map(result => ({
      misses: result.progression.growthMisses,
      tier: result.progression.room.rewardTier,
      choices: result.progression.pedestals.map(item => item.id)
    })),
    persistentGrowth: {
      tier: persistentGrowth.cleared.room.rewardTier,
      choices: persistentGrowth.originalIds,
      selected: persistentGrowth.selectedId
    },
    specialRooms,
    sanctum: sanctum.ids,
    power: {
      baseDps: baseStats.dps,
      stages: powerCurve.stages.map(stage => ({
        floor: stage.floor,
        item: stage.id,
        dps: stage.progression.stats.dps,
        shots: stage.progression.stats.shots,
        pierce: stage.progression.stats.pierce
      })),
      lateDps: lateStats.dps
    },
    bosses
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
