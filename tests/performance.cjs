const http=require('http'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');

const root=path.resolve(__dirname,'..'),port=8878;
let browser;
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=http.createServer((req,res)=>{
  const clean=decodeURIComponent(req.url.split('?')[0]);
  const file=path.join(root,clean==='/'?'index.html':clean);
  if(!file.startsWith(root)){res.writeHead(403).end();return}
  fs.readFile(file,(error,data)=>{
    if(error){res.writeHead(404).end();return}
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  });
}).listen(port,'127.0.0.1');

function summarize(samples){
  const sorted=[...samples].sort((a,b)=>a-b),at=q=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))];
  return{median:+at(.5).toFixed(2),p95:+at(.95).toFixed(2),max:+at(1).toFixed(2),over25:samples.filter(v=>v>25).length,over34:samples.filter(v=>v>34).length};
}

async function sampleFrames(page,count=120){
  return page.evaluate(frames=>new Promise(resolve=>{
    const samples=[];let previous=performance.now();
    const step=now=>{samples.push(now-previous);previous=now;if(samples.length>=frames)resolve(samples);else requestAnimationFrame(step)};
    requestAnimationFrame(step);
  }),count);
}

(async()=>{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:810}});
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__GENESIS_DEBUG__);
  await page.evaluate(()=>window.__GENESIS_DEBUG__.start());
  await page.waitForTimeout(250);
  const diagnostics=await page.evaluate(async()=>({profiles:window.__GENESIS_DEBUG__.probeShotProfiles(),suspended:await window.__GENESIS_DEBUG__.probeSuspendedShotAudio(),pickup:window.__GENESIS_DEBUG__.probePickupPursuit()}));
  await page.waitForTimeout(180);
  await sampleFrames(page,30);
  console.log('stage: baseline');
  const baseline=summarize(await sampleFrames(page,60));
  console.log('stage: vanguard');
  await page.keyboard.down('ArrowRight');
  const vanguard=summarize(await sampleFrames(page,120));
  await page.keyboard.up('ArrowRight');
  console.log('stage: synergy setup');
  await page.evaluate(()=>{
    const d=window.__GENESIS_DEBUG__;
    for(const item of ['overclock','prism','ghost','echo'])d.giveItem(item);
    d.simulate(30);d.switchForm('wraith');d.setPlayer(640,365);
  });
  await page.waitForTimeout(300);
  const firstShotMs=await page.evaluate(()=>{const t=performance.now();window.__GENESIS_DEBUG__.fire(1,0);return performance.now()-t});
  console.log('stage: wraith synergy');
  await page.keyboard.down('ArrowRight');
  const shooting=summarize(await sampleFrames(page,180));
  await page.keyboard.up('ArrowRight');
  console.log('stage: combat walls');
  await page.evaluate(()=>{const d=window.__GENESIS_DEBUG__;d.enterType('combat');d.setInvuln(999);d.setPlayer(640,365);d.clearWeaponFx()});
  await page.waitForTimeout(180);
  await page.keyboard.down('ArrowRight');
  const combat=summarize(await sampleFrames(page,120));
  await page.keyboard.up('ArrowRight');
  console.log('stage: synchronous stress');
  const stress=await page.evaluate(()=>{
    const d=window.__GENESIS_DEBUG__,before=d.snapshot(),t0=performance.now();
    for(let i=0;i<180;i++){d.setInvuln(999);d.tick(1);d.renderNow()}
    return{elapsed:performance.now()-t0,before,after:d.snapshot()};
  });
  const result={diagnostics,baseline,vanguard,firstShotMs:+firstShotMs.toFixed(3),shooting,combat,stressMs:+stress.elapsed.toFixed(2),stressLoad:{mode:stress.before.mode,tears:stress.before.tears,obstacles:stress.before.obstacles,enemies:stress.before.enemies},snapshot:stress.after};
  const profiles=Object.values(diagnostics.profiles),soundSafe=diagnostics.suspended.createdWhileSuspended===0&&diagnostics.suspended.voiceGrowth===0&&diagnostics.suspended.resumeRequests===1&&diagnostics.suspended.resumed;
  if(profiles.length!==4||new Set(profiles.map(v=>v.signature)).size!==4||!soundSafe||!diagnostics.pickup.allCaught||!diagnostics.pickup.fast||!diagnostics.pickup.frameStable)throw new Error(`diagnostic pressure probe failed: ${JSON.stringify(diagnostics)}`);
  if(firstShotMs>6||baseline.p95>25||vanguard.p95>34||shooting.p95>25||combat.median>25||combat.p95>40||stress.elapsed/180>5||stress.before.mode!=='playing'||stress.before.tears<20||stress.before.obstacles<8||stress.after.hp<=0)throw new Error(`shooting performance budget failed: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result,null,2));
  await browser.close();server.close();
})().catch(async error=>{console.error(error.stack||error);await browser?.close().catch(()=>{});server.close();process.exitCode=1;setTimeout(()=>process.exit(1),50)});
