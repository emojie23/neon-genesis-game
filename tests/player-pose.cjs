const http=require('http');
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),port=8898;
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=http.createServer((req,res)=>{
  const clean=decodeURIComponent(req.url.split('?')[0]),file=path.join(root,clean==='/'?'index.html':clean);
  if(!file.startsWith(root))return res.writeHead(403).end();
  fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data)});
});
let browser;
(async()=>{
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:810}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__GENESIS_DEBUG__&&window.__GENESIS_DEBUG__.spriteState().player.ready);
  await page.evaluate(()=>{const d=window.__GENESIS_DEBUG__;d.start();d.setPlayer(640,365);d.tick(2)});
  const box=await page.locator('#game').boundingBox(),point=(x,y)=>({x:box.x+x/1280*box.width,y:box.y+y/720*box.height});
  const poses={};
  for(const [name,x,y] of [['right',1080,365],['up',640,120],['down',640,620],['left',180,365]]){
    const p=point(x,y);await page.mouse.move(p.x,p.y);await page.evaluate(()=>window.__GENESIS_DEBUG__.tick(2));
    poses[name]=await page.evaluate(()=>window.__GENESIS_DEBUG__.playerPoseState());
  }
  for(const pose of Object.values(poses)){assert.strictEqual(pose.upright,true);assert.strictEqual(pose.rotation,0);assert.strictEqual(pose.anchorX,640);assert.strictEqual(pose.anchorY,365)}
  assert.strictEqual(poses.right.facing,1);
  assert.strictEqual(poses.up.facing,1,'vertical aiming should preserve the previous horizontal facing');
  assert.strictEqual(poses.down.facing,1,'vertical aiming should preserve the previous horizontal facing');
  assert.strictEqual(poses.left.facing,-1);
  assert.ok(poses.up.aimY<-.85&&poses.down.aimY>.85&&poses.left.aimX<-.85);
  await page.evaluate(()=>window.__GENESIS_DEBUG__.renderNow());
  await page.screenshot({path:path.join(root,'neon-genesis-upright-player.png')});
  assert.deepStrictEqual(errors,[]);
  console.log(JSON.stringify({ok:true,poses},null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();server.close()});
