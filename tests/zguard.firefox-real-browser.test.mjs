// Native Firefox MV2 acceptance with real geckodriver + a temporary, shipped extension.
// The fixture is loopback-only. It cancels missed gestures at the DOM target,
// so a failed blocker never navigates to the synthetic hostile URL.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import http from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';

const args=process.argv.slice(2);
assert.ok(args.length===0 || (args.length===1 && args[0]==='--require-pageworld'),
  'Unsupported or duplicate Firefox acceptance flag');
const xpi=process.env.ZGUARD_FIREFOX_XPI;
assert.ok(xpi && xpi.endsWith('.xpi'),'Set ZGUARD_FIREFOX_XPI to the packaged add-on');
for(const bin of ['firefox','geckodriver']){
  assert.equal(spawnSync(bin,['--version'],{encoding:'utf8',timeout:5000}).status,0,
    bin+' is required; real Firefox proof cannot be skipped');
}
const fixture='<!doctype html><html><head><meta charset="utf-8"></head><body>'
  +'<a id="hostile" href="https://ads.al5sm.com/private" target="_blank">Hostile</a>'
  +'<a id="ordinary" href="/safe" target="_blank">Ordinary</a>'
  +'<form id="hostileForm" action="https://ads.al5sm.com/form" target="_blank">'
  +'<button type="submit" id="submitHostile">Submit</button></form>'
  +'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100">'
  +'<a id="svgHostile" href="https://ads.al5sm.com/svg" target="_blank">'
  +'<rect width="110" height="80" fill="red"/></a>'
  +'<a id="svgOrdinary" href="/safe" target="_blank">'
  +'<rect x="125" width="110" height="80" fill="green"/></a></svg>'
  +'<img id="imageMap" width="200" height="100" alt="Hotspot fixture" '
  +'src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22100%22%3E%3Crect width=%22200%22 height=%22100%22 fill=%22%23aaa%22/%3E%3C/svg%3E" '
  +'usemap="#qaHotspots"/>'
  +'<map name="qaHotspots">'
  +'<area id="imageMapHostile" shape="rect" coords="0,0,90,100" '
  +'href="https://ads.al5sm.com/map" target="_blank" alt="Hostile hotspot"/>'
  +'<area id="imageMapOrdinary" shape="rect" coords="110,0,200,100" '
  +'href="/safe" target="_blank" alt="Ordinary hotspot"/></map>'
  +'<div id="shadowHost"></div>'
  +'<script>window.qa={hostileClicks:0,ordinaryClicks:0,hostileSubmits:0,'
  +'svgHostileClicks:0,svgOrdinaryClicks:0,shadowHostileClicks:0,shadowOrdinaryClicks:0,'
  +'hostileMiddleClicks:0,ordinaryMiddleClicks:0,imageMapHostileClicks:0,imageMapOrdinaryClicks:0};'
  +'for(const id of ["hostile","ordinary","svgHostile","svgOrdinary","imageMapHostile","imageMapOrdinary"]){'
  +'document.getElementById(id).addEventListener("click",e=>{'
  +'window.qa[id+"Clicks"]++;e.preventDefault();});}'
  +'for(const id of ["hostile","ordinary"]){'
  +'document.getElementById(id).addEventListener("auxclick",e=>{'
  +'if(e.button===1){window.qa[id+"MiddleClicks"]++;e.preventDefault();}});}'
  +'const root=document.getElementById("shadowHost").attachShadow({mode:"open"});'
  +'for(const kind of ["Hostile","Ordinary"]){'
  +'const a=document.createElement("a");a.id="shadow"+kind;'
  +'a.href=kind==="Hostile"?"https://ads.al5sm.com/shadow":"/safe";'
  +'a.target="_blank";a.textContent="Shadow "+kind;'
  +'a.style.cssText="display:inline-block;padding:20px";'
  +'a.addEventListener("click",e=>{window.qa["shadow"+kind+"Clicks"]++;e.preventDefault();});'
  +'root.appendChild(a);}'
  +'document.getElementById("hostileForm").addEventListener("submit",e=>{'
  +'window.qa.hostileSubmits++;e.preventDefault();});</script></body></html>';
const server=http.createServer((_req,res)=>{
  res.writeHead(200,{'content-type':'text/html; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(fixture);
});
let driver=null,session=null,port=null,log='';
async function wd(method,route,body,timeout=20000){
  const resp=await fetch('http://127.0.0.1:'+port+route,{
    method,headers:{'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    signal:AbortSignal.timeout(timeout)
  });
  const json=await resp.json();
  if(!resp.ok || json.value?.error){
    throw new Error('WebDriver '+method+' '+route+': '+
      String(json.value?.message || json.value?.error || resp.status).slice(0,300));
  }
  return json.value;
}
const evaluate=(script)=>wd('POST','/session/'+session+'/execute/sync',{script,args:[]});
async function clickElement(e){
  const id=e?.['element-6066-11e4-a52e-4f735466cecf'];
  assert.ok(id,'Native WebDriver element reference required');
  await wd('POST','/session/'+session+'/element/'+id+'/click',{});
}
async function click(selector){
  const e=await wd('POST','/session/'+session+'/element',{using:'css selector',value:selector});
  await clickElement(e);
}
async function nativePointer(selector,{button=0,x=0,y=0}={}){
  const e=await wd('POST','/session/'+session+'/element',{using:'css selector',value:selector});
  assert.ok(e?.['element-6066-11e4-a52e-4f735466cecf'],
    'Native pointer origin must reference a real browser element');
  await wd('POST','/session/'+session+'/actions',{actions:[{
    type:'pointer',id:'qaPointer',parameters:{pointerType:'mouse'},actions:[
      {type:'pointerMove',duration:100,origin:e,x,y},
      {type:'pointerDown',button},{type:'pointerUp',button}
    ]
  }]});
  await wd('DELETE','/session/'+session+'/actions');
}
async function keyboardActivate(selector){
  const element=await wd('POST','/session/'+session+'/element',
    {using:'css selector',value:selector});
  const id=element?.['element-6066-11e4-a52e-4f735466cecf'];
  assert.ok(id,'Native keyboard target must exist: '+selector);
  // W3C WebDriver sends a *trusted* keyboard Enter to the focused element,
  // unlike synthetic dispatchEvent() or JavaScript .click().
  await wd('POST','/session/'+session+'/element/'+id+'/value',
    {text:'\uE007',value:['\uE007']});
}
async function until(fn,description,tries=45){
  for(let i=0;i<tries;i++){if(await fn())return;await sleep(200);}
  throw new Error('Timeout waiting for '+description);
}
try{
  await new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  const origin='http://127.0.0.1:'+server.address().port+'/';
  const reserved=http.createServer();
  await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));
  port=reserved.address().port;
  await new Promise(resolve=>reserved.close(resolve));
  driver=spawn('geckodriver',['--host','127.0.0.1','--port',String(port),'--log','error'],
    {stdio:['ignore','ignore','pipe']});
  driver.stderr.on('data',chunk=>{if(log.length<4000)log+=chunk.toString();});
  await until(async()=>{
    if(driver.exitCode!==null)throw new Error('Geckodriver exited: '+log.slice(-300));
    try{return (await wd('GET','/status',undefined,1200)).ready===true;}
    catch(_){return false;}
  },'real geckodriver',60);
  const started=await wd('POST','/session',{capabilities:{alwaysMatch:{
    browserName:'firefox','moz:firefoxOptions':{
      args:['-headless'],prefs:{
        'browser.shell.checkDefaultBrowser':false,
        'network.prefetch-next':false,
        'network.dns.disablePrefetch':true
      }
    }
  }}},60000);
  session=started.sessionId;
  assert.ok(session,'Must launch a real Firefox WebDriver session');
  const addon=await wd('POST','/session/'+session+'/moz/addon/install',
    {path:xpi,temporary:true});
  assert.equal(typeof addon,'string','Must install the shipped Firefox MV2 extension');
  await wd('POST','/session/'+session+'/url',{url:origin});
  await until(()=>evaluate('return document.readyState==="complete"'),'local fixture');
  // Only the readiness probe is synthetic. Actual acceptance uses WebDriver clicks.
  await until(()=>evaluate(
    'const e=document.getElementById("hostile");'
    +'const n=window.qa.hostileClicks;'
    +'const click=new MouseEvent("click",{bubbles:true,cancelable:true});'
    +'e.dispatchEvent(click);return click.defaultPrevented&&window.qa.hostileClicks===n;'
  ),'content-script storage hydration',40);
  const before=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await click('#hostile');
  await click('#ordinary');
  await click('#submitHostile');
  await click('#svgHostile rect');
  await click('#svgOrdinary rect');
  await nativePointer('#hostile',{button:1});
  await nativePointer('#ordinary',{button:1});
  // Click the actual painted image-map regions with W3C pointer actions.
  // A synthetic .click() on <area> is not evidence of a native hotspot.
  await nativePointer('#imageMap',{x:-55});
  await nativePointer('#imageMap',{x:55});
  await clickElement(await evaluate(
    'return document.getElementById("shadowHost").shadowRoot.querySelector("#shadowHostile")'));
  await clickElement(await evaluate(
    'return document.getElementById("shadowHost").shadowRoot.querySelector("#shadowOrdinary")'));
  const after=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(after.hostileClicks,before.hostileClicks,
    'Native hostile Firefox link must be stopped before target');
  assert.equal(after.ordinaryClicks,before.ordinaryClicks+1,
    'Ordinary Firefox link must still receive native click');
  assert.equal(after.hostileSubmits,before.hostileSubmits,
    'Native hostile target=_blank Firefox form must be stopped');
  for(const [blocked,allowed,label] of [
    ['svgHostileClicks','svgOrdinaryClicks','SVG link'],
    ['shadowHostileClicks','shadowOrdinaryClicks','open Shadow DOM link'],
    ['hostileMiddleClicks','ordinaryMiddleClicks','middle-button auxclick'],
    ['imageMapHostileClicks','imageMapOrdinaryClicks','native image-map hotspot']
  ]){
    assert.equal(after[blocked],before[blocked],
      'Native Firefox hostile '+label+' must be stopped in capture phase');
    assert.equal(after[allowed],before[allowed]+1,
      'Native Firefox ordinary '+label+' must reach target as positive control');
  }
  const beforeKeyboard=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await keyboardActivate('#hostile');
  await keyboardActivate('#ordinary');
  await keyboardActivate('#submitHostile');
  const afterKeyboard=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(afterKeyboard.hostileClicks,beforeKeyboard.hostileClicks,
    'Trusted Firefox Enter on hostile link must be captured before target');
  assert.equal(afterKeyboard.ordinaryClicks,beforeKeyboard.ordinaryClicks+1,
    'Trusted Firefox Enter must still activate an ordinary link');
  assert.equal(afterKeyboard.hostileSubmits,beforeKeyboard.hostileSubmits,
    'Trusted Firefox Enter on submit button must not launch hostile form');
  const handles=await wd('GET','/session/'+session+'/window/handles');
  assert.equal(handles.length,1,'No unauthorized popup may remain');
  const mainWorld=await evaluate('return window.open.name==="zGuardWindowOpen"');
  console.log('Native Firefox MV2 PASS: HTML/SVG/Shadow DOM, middle auxclick, image-map and trusted keyboard Enter form/link blocked; ordinary controls pass; one tab.');
  console.log('Firefox MAIN-world window.open guarded='+mainWorld+'; issue #3 independently gated.');
  if(args.includes('--require-pageworld'))assert.equal(mainWorld,true,
    'Issue #3: Firefox isolated-world wrapper is not MAIN-world protection');
}finally{
  if(session)try{await wd('DELETE','/session/'+session,undefined,8000);}catch(_){}
  if(driver){driver.kill('SIGTERM');await sleep(250);if(driver.exitCode===null)driver.kill('SIGKILL');}
  await new Promise(resolve=>server.close(resolve));
}
