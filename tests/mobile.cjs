const http=require('http'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');

const root=path.resolve(__dirname,'..'),port=8879,types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json'};
let browser;
const server=http.createServer((req,res)=>{const clean=decodeURIComponent(req.url.split('?')[0]),file=path.join(root,clean==='/'?'index.html':clean);if(!file.startsWith(root)){res.writeHead(403).end();return}fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data)})}).listen(port,'127.0.0.1');

(async()=>{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await page.goto(`http://127.0.0.1:${port}/index.html?test=1`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__GENESIS_DEBUG__);await page.waitForTimeout(150);
  const layouts={portrait:await page.evaluate(()=>window.__GENESIS_DEBUG__.mobileLayout())};
  if(!layouts.portrait.rotate.visible||layouts.portrait.shell.width<389||layouts.portrait.shell.height<843)throw new Error(`portrait gate failed: ${JSON.stringify(layouts.portrait)}`);
  await page.screenshot({path:path.join(root,'neon-genesis-portrait-rotate.png')});
  await page.setViewportSize({width:480,height:270});await page.waitForTimeout(180);layouts.compact=await page.evaluate(()=>window.__GENESIS_DEBUG__.mobileLayout());
  if(layouts.compact.rotate.visible||layouts.compact.orientation!=='landscape'||layouts.compact.fullscreenButton.width<44)throw new Error(`compact landscape failed: ${JSON.stringify(layouts.compact)}`);
  await page.click('#start-btn');await page.waitForTimeout(380);for(let slide=0;slide<9;slide++){const box=await page.locator('#story-next').boundingBox();if(!box||box.height<43.5||box.y<0||box.y+box.height>271)throw new Error(`story CTA clipped on slide ${slide}: ${JSON.stringify(box)}`);if(slide===1)await page.screenshot({path:path.join(root,'neon-genesis-story-compact-mobile.png')});if(slide===6){const guide=await page.locator('#room-guide.active').boundingBox();if(!guide||guide.x<0||guide.y<0||guide.x+guide.width>481||guide.y+guide.height>271)throw new Error(`room guide clipped: ${JSON.stringify(guide)}`)}if(slide<8){await page.click('#story-next');await page.waitForTimeout(380)}}
  await page.close();
  const landscape=await browser.newPage({viewport:{width:844,height:390},hasTouch:true,isMobile:true});await landscape.goto(`http://127.0.0.1:${port}/index.html?test=1`,{waitUntil:'domcontentloaded'});await landscape.waitForFunction(()=>window.__GENESIS_DEBUG__);layouts.landscape=await landscape.evaluate(()=>window.__GENESIS_DEBUG__.mobileLayout());
  if(!layouts.landscape.fullscreenSupported)throw new Error('Fullscreen API missing in landscape browser');await landscape.click('#fullscreen-btn');await landscape.waitForTimeout(180);layouts.fullscreen=await landscape.evaluate(()=>window.__GENESIS_DEBUG__.mobileLayout());if(!layouts.fullscreen.fullscreen)throw new Error(`fullscreen did not activate: ${JSON.stringify(layouts.fullscreen)}`);await landscape.click('#fullscreen-btn');await landscape.waitForTimeout(120);
  await landscape.click('#start-btn');await landscape.click('#story-skip');layouts.playing=await landscape.evaluate(()=>window.__GENESIS_DEBUG__.mobileLayout());if(!layouts.playing.moveStick.visible||!layouts.playing.shootStick.visible||layouts.playing.moveStick.width<70||layouts.playing.shootStick.width<70)throw new Error(`touch controls failed: ${JSON.stringify(layouts.playing)}`);await landscape.screenshot({path:path.join(root,'neon-genesis-mobile.png')});
  console.log(JSON.stringify({ok:true,layouts},null,2));await landscape.close();await browser.close();server.close();
})().catch(async error=>{console.error(error.stack||error);await browser?.close().catch(()=>{});server.close();process.exitCode=1;setTimeout(()=>process.exit(1),50)});
