const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const port = 8897;
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png'};
const server = http.createServer((req,res)=>{
  const clean=decodeURIComponent(req.url.split('?')[0]);
  const file=path.join(root,clean==='/'?'index.html':clean);
  if(!file.startsWith(root))return res.writeHead(403).end();
  fs.readFile(file,(error,data)=>{
    if(error)return res.writeHead(404).end();
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  });
});

let browser;
(async()=>{
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:810}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__GENESIS_DEBUG__);

  const expected=[
    {floor:1,id:'cherub',columns:6,frames:18},
    {floor:2,id:'matriarch',columns:6,frames:18},
    {floor:3,id:'hexa',columns:5,frames:15}
  ];
  const results=[];
  for(const spec of expected){
    const intro=await page.evaluate(floor=>{
      const d=window.__GENESIS_DEBUG__;
      d.start();d.loadFloor(floor);d.forceEnterType('boss');
      return d.bossAnimationState();
    },spec.floor);
    await page.waitForFunction(id=>{
      const state=window.__GENESIS_DEBUG__.bossAnimationState();
      return state.id===id&&state.ready;
    },spec.id);
    const painted=await page.evaluate(()=>{
      const d=window.__GENESIS_DEBUG__,canvas=document.querySelector('#intro-portrait'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let opaque=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>16)opaque++;
      return{state:d.bossAnimationState(),opaque};
    });
    assert.strictEqual(painted.state.id,spec.id);
    assert.strictEqual(painted.state.introBoss,spec.id,'intro portrait must use the current combat boss atlas');
    assert.strictEqual(painted.state.columns,spec.columns);
    assert.strictEqual(painted.state.frames,spec.frames);
    assert.strictEqual(painted.state.totalFrames,51);
    assert.ok(painted.state.ready,`${spec.id} atlas not ready`);
    assert.ok(painted.opaque>2500,`${spec.id} intro portrait is empty`);

    const combat=await page.evaluate(()=>{
      const d=window.__GENESIS_DEBUG__;
      d.spawnBossNow();
      const before=d.bossAnimationState();
      d.tick(30);
      const moving=d.bossAnimationState();
      d.setBossPhase(1);
      const phase2=d.bossAnimationState();
      d.tick(75);
      const settled=d.bossAnimationState();
      d.renderNow();
      return{before,moving,phase2,settled};
    });
    assert.strictEqual(combat.phase2.row,1,'phase change must select the matching atlas row');
    assert.strictEqual(combat.phase2.action,'transform','phase change must show the transform frame');
    assert.ok(combat.moving.bladeAngle>combat.before.bladeAngle,'boss motion clock must advance');
    if(spec.id==='cherub')assert.strictEqual(combat.moving.bladeCount,6,'Cyber Cherub must always have exactly six blade effects');
    const renderCost=await page.evaluate(()=>{
      const d=window.__GENESIS_DEBUG__,start=performance.now();
      for(let i=0;i<180;i++)d.renderNow();
      return (performance.now()-start)/180;
    });
    assert.ok(renderCost<8,`${spec.id} boss render is too expensive: ${renderCost.toFixed(2)}ms`);
    results.push({spec,intro:painted.state,opaque:painted.opaque,combat,renderCost});
  }

  await page.evaluate(()=>{
    const d=window.__GENESIS_DEBUG__;
    d.start();d.loadFloor(1);d.forceEnterType('boss');
  });
  await page.screenshot({path:path.join(root,'neon-genesis-boss-intro-v3.png')});
  await page.evaluate(()=>{
    const d=window.__GENESIS_DEBUG__;
    d.spawnBossNow();d.tick(75);d.renderNow();
  });
  await page.screenshot({path:path.join(root,'neon-genesis-cherub-six-blades.png')});

  assert.deepStrictEqual(errors,[],`browser errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ok:true,totalFrames:51,bosses:results.map(item=>({id:item.spec.id,columns:item.intro.columns,frames:item.intro.frames,opaquePixels:item.opaque,phaseAction:item.combat.phase2.action,bladeCount:item.combat.moving.bladeCount,renderMs:+item.renderCost.toFixed(3)}))},null,2));
})().catch(error=>{
  console.error(error);
  process.exitCode=1;
}).finally(async()=>{
  if(browser)await browser.close();
  server.close();
});
