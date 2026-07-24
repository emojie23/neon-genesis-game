const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),port=8894,types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=http.createServer((req,res)=>{const clean=decodeURIComponent(req.url.split('?')[0]),file=path.join(root,clean==='/'?'index.html':clean);if(!file.startsWith(root)){res.writeHead(403).end();return}fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data)})});
let browser;
(async()=>{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:810}}),errors=[];
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1`,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.__GENESIS_DEBUG__);
  await page.evaluate(()=>window.__GENESIS_DEBUG__.start());

  const model=await page.evaluate(()=>window.__GENESIS_DEBUG__.progressionModel()),ids=model.items.map(item=>item.id);
  assert.ok(model.items.length>=20,`relic catalog is too small: ${model.items.length}`);
  assert.strictEqual(new Set(ids).size,ids.length,'relic ids are duplicated');
  for(const item of model.items){assert.ok(item.family&&item.familyLabel,`${item.id} has no relic family`);assert.ok(item.rarity&&item.rarityLabel,`${item.id} has no rarity language`);assert.ok(item.synergy?.length>=12,`${item.id} has no synergy description`)}
  for(const id of ['afterimage','saw-memory','oracle-eye','votive','executioner','blackbox','choir','harvest'])assert.ok(ids.includes(id),`missing authored relic ${id}`);

  const owned=await page.evaluate(()=>{
    const d=window.__GENESIS_DEBUG__;
    for(const id of ['afterimage','saw-memory','oracle-eye','votive','executioner','blackbox','choir','drone','harvest'])d.giveItem(id);
    d.tick(1);
    return{snapshot:d.snapshot(),rarity:document.querySelector('#item-rarity').textContent,synergy:document.querySelector('#item-synergy').textContent,arrayVisible:!document.querySelector('#relic-array').classList.contains('empty'),slotTitles:[...document.querySelectorAll('#relic-slots i')].map(el=>el.title)}
  });
  assert.strictEqual(owned.snapshot.items.length,9,'authored relics were not all acquired');
  assert.strictEqual(owned.snapshot.relicSlots,9,'relic HUD did not render all owned relics');
  assert.strictEqual(owned.snapshot.familiars,2,'choir and drone did not form a two-familiar synergy');
  assert.ok(owned.arrayVisible,'relic array remained empty');
  assert.ok(owned.rarity.includes('//'),'relic pickup banner omitted rarity or family');
  assert.ok(owned.synergy.length>=12,'relic pickup banner omitted synergy guidance');
  assert.ok(owned.slotTitles.every(title=>title.split('\n').length>=4),'relic HUD tooltips are incomplete');

  const afterimage=await page.evaluate(()=>{
    const d=window.__GENESIS_DEBUG__;d.clearWeaponFx();d.setCrit(false);for(let i=0;i<5;i++)d.fire(1,0);return d.snapshot()
  });
  assert.strictEqual(afterimage.shotSequence,5,'fifth-shot counter drifted');
  assert.strictEqual(afterimage.tears,7,`fifth afterimage did not add two side shots: ${afterimage.tears}`);

  const oracle=await page.evaluate(()=>{const d=window.__GENESIS_DEBUG__;d.clearWeaponFx();d.setCrit(true);d.fire(1,0);return d.snapshot()});
  assert.ok(oracle.tearPierces.every(value=>value>=1),'critical oracle shot did not gain penetration');
  const voltage=await page.evaluate(()=>{const d=window.__GENESIS_DEBUG__;d.setCrit(null);d.setResources({hp:6});const full=d.snapshot().stats;d.setResources({hp:3});const low=d.snapshot().stats;return{full,low}});
  assert.ok(voltage.low.damage>=voltage.full.damage*1.29,'low-voltage shrine damage boost is missing');
  assert.ok(voltage.low.critChance>=voltage.full.critChance+.099,'low-voltage shrine crit boost is missing');

  const damage=await page.evaluate(()=>window.__GENESIS_DEBUG__.relicDamageProbe());
  assert.deepStrictEqual(damage,{base:10,ricochet:13,boss:12.5,combined:16.25},`relic damage multipliers are wrong: ${JSON.stringify(damage)}`);

  const flawless=await page.evaluate(()=>{
    const d=window.__GENESIS_DEBUG__;d.setResources({hp:6,shield:0,coins:5});d.enterCombat(1,0);const before=d.snapshot();d.forceReward('rare');d.clearRoom();d.tick(30);const after=d.snapshot(),focus=after.pedestalPositions[0];d.setPlayer(focus.x,focus.y);d.renderNow();return{before,after}
  });
  assert.strictEqual(flawless.after.shield,flawless.before.shield+1,'flawless black box did not grant shield');
  assert.ok(flawless.after.coins>=flawless.before.coins+2,'flawless black box did not grant DATA');
  assert.ok(flawless.after.pedestals>=2,'forced rare room did not expose relic pedestals for visual QA');
  await page.screenshot({path:path.join(root,'neon-genesis-relic-overhaul.png')});

  const bossArt=await page.evaluate(()=>{const d=window.__GENESIS_DEBUG__;d.loadFloor(3);d.forceEnterType('boss');d.spawnBossNow();d.setBossPhase(2);d.setInvuln(999);d.tick(30);d.setPlayer(640,510);d.renderNow();return d.snapshot()});
  assert.strictEqual(bossArt.boss,'hexa','boss art setup failed');
  await page.screenshot({path:path.join(root,'neon-genesis-boss-overhaul.png')});
  const palette=await page.evaluate(()=>{const data=document.querySelector('#game').getContext('2d').getImageData(100,90,1080,540).data,colors=new Set;for(let i=0;i<data.length;i+=160)colors.add(`${data[i]>>3},${data[i+1]>>3},${data[i+2]>>3}`);return colors.size});
  assert.ok(palette>80,`canvas art palette is unexpectedly flat: ${palette}`);
  assert.deepStrictEqual(errors,[],`browser errors occurred: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ok:true,relics:model.items.length,families:[...new Set(model.items.map(item=>item.familyLabel))],owned:owned.snapshot.items,afterimageTears:afterimage.tears,damage,flawless:{shield:flawless.after.shield,coins:flawless.after.coins},boss:bossArt.boss,palette},null,2));
  await browser.close();server.close();
})().catch(async error=>{console.error(error.stack||error);await browser?.close().catch(()=>{});server.close();process.exitCode=1;setTimeout(()=>process.exit(1),50)});
