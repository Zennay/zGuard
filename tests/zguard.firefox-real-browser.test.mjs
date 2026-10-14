// Native Firefox MV2 acceptance with real geckodriver + a temporary, shipped extension.
// The fixture is loopback-only. It cancels missed gestures at the DOM target,
// so a failed blocker never navigates to the synthetic hostile URL.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
  +'<a id="ordinary" href="__QA_ORDINARY_EXTERNAL__" target="_blank">Ordinary external</a>'
  +'<form id="hostileForm" action="https://ads.al5sm.com/form" target="_blank">'
  +'<button type="submit" id="submitHostile">Submit</button></form>'
  +'<form id="overrideHostileForm" action="/safe" target="_self">'
  +'<button type="submit" id="submitOverrideHostile" '
  +'formaction="https://ads.al5sm.com/overridden" formtarget="_blank">'
  +'Hostile submitter override</button></form>'
  +'<form id="overrideOrdinaryForm" action="https://ads.al5sm.com/default" target="_blank">'
  +'<button type="submit" id="submitOverrideOrdinary" formaction="/safe" '
  +'formtarget="_self">Allowed submitter override</button></form>'
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
  +'href="/safe" target="_blank" alt="Ordinary hotspot"/>'
  +'<area id="nativeTabMapArea" shape="rect" coords="91,0,109,100" '
  +'href="__QA_FRAME_URL__" target="_blank" alt="Native new-tab hotspot"/></map>'
  +'<form id="programmaticForm" target="_blank" method="get"></form>'
  +'<button id="programmaticSameForm" type="button">Allowed programmatic form</button>'
  +'<button id="programmaticCrossForm" type="button">Cross-origin programmatic form</button>'
  +'<a id="nativeMiddleForeign" href="__QA_FRAME_URL__" target="_blank">'
  +'Ordinary separate-origin middle-click link</a>'
  +'<button id="openSameOriginPopup" type="button">Allowed page popup</button>'
  +'<button id="openCrossOriginPopup" type="button">Cross-origin page popup</button>'
  +'<iframe id="qaCrossOriginFrame" title="Cross-origin Firefox popup boundary" '
  +'src="__QA_FRAME_URL__"></iframe>'
  +'<div id="shadowHost"></div>'
  +'<script>window.qa={hostileClicks:0,ordinaryClicks:0,hostileSubmits:0,'
  +'svgHostileClicks:0,svgOrdinaryClicks:0,shadowHostileClicks:0,shadowOrdinaryClicks:0,'
  +'hostileMiddleClicks:0,ordinaryMiddleClicks:0,imageMapHostileClicks:0,imageMapOrdinaryClicks:0,'
  +'pagePopupSame:0,pagePopupCross:0,pagePopupSameNative:false,pagePopupCrossNative:false,'
  +'overrideHostileSubmits:0,overrideOrdinarySubmits:0,'
  +'programmaticSame:0,programmaticCross:0,programmaticSubmitEvents:0,'
  +'middleForeignDown:0,middleForeignUp:0,middleForeignAux:0,middleForeignTrusted:false,'
  +'nativeMapClicks:0,nativeMapTrusted:false};'
  +'document.getElementById("nativeTabMapArea").addEventListener("click",e=>{'
  +'window.qa.nativeMapClicks++;window.qa.nativeMapTrusted=e.isTrusted;});'
  +'for(const kind of ["mousedown","mouseup","auxclick"]){'
  +'document.getElementById("nativeMiddleForeign").addEventListener(kind,e=>{'
  +'if(e.button!==1)return;const key=kind==="mousedown"?"middleForeignDown":'
  +'kind==="mouseup"?"middleForeignUp":"middleForeignAux";'
  +'window.qa[key]++;if(kind==="auxclick")window.qa.middleForeignTrusted=e.isTrusted;});}'
  +'document.getElementById("programmaticForm").addEventListener("submit",()=>{'
  +'window.qa.programmaticSubmitEvents++;});'
  +'document.getElementById("programmaticSameForm").addEventListener("click",()=>{'
  +'window.qa.programmaticSame++;const form=document.getElementById("programmaticForm");'
  +'form.action=location.origin+"/qa-programmatic-form-allowed";form.submit();});'
  +'document.getElementById("programmaticCrossForm").addEventListener("click",()=>{'
  +'window.qa.programmaticCross++;const form=document.getElementById("programmaticForm");'
  +'form.action="__QA_FRAME_URL__";form.submit();});'
  +'document.getElementById("openSameOriginPopup").addEventListener("click",()=>{'
  +'window.qa.pagePopupSame++;window.qa.pagePopupSameNative='
  +'!!window.open(location.origin+"/qa-same-origin-popup","_blank");});'
  +'document.getElementById("openCrossOriginPopup").addEventListener("click",()=>{'
  +'window.qa.pagePopupCross++;window.qa.pagePopupCrossNative='
  +'!!window.open("__QA_FRAME_URL__","_blank");});'
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
  +'window.qa.hostileSubmits++;e.preventDefault();});'
  +'for(const id of ["overrideHostile","overrideOrdinary"]){'
  +'document.getElementById(id+"Form").addEventListener("submit",e=>{'
  +'window.qa[id+"Submits"]++;e.preventDefault();});}'
  +'</script></body></html>';
const frameFixture='<!doctype html><html><head><meta charset="utf-8"></head><body>'
  +'<a id="frameHostile" href="https://ads.al5sm.com/iframe" target="_blank">Blocked frame link</a>'
  +'<a id="frameOrdinary" href="/safe" target="_blank">Allowed frame link</a>'
  +'<script>window.frameQA={hostile:0,ordinary:0};'
  +'document.getElementById("frameHostile").addEventListener("click",e=>{'
  +'window.frameQA.hostile++;e.preventDefault();});'
  +'document.getElementById("frameOrdinary").addEventListener("click",e=>{'
  +'window.frameQA.ordinary++;e.preventDefault();});</script></body></html>';
const frameServer=http.createServer((_req,res)=>{
  res.writeHead(200,{'content-type':'text/html; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(frameFixture);
});
const server=http.createServer((_req,res)=>{
  res.writeHead(200,{'content-type':'text/html; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff'});
  const frameUrl='http://127.0.0.1:'+frameServer.address().port+'/child';
  res.end(fixture.replaceAll('__QA_FRAME_URL__',frameUrl)
    .replace('__QA_ORDINARY_EXTERNAL__',
      'http://127.0.0.1:'+frameServer.address().port+'/safe'));
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
async function popupOriginForInstalledAddon(addonId,profileDir){
  assert.ok(profileDir && path.isAbsolute(profileDir),
    'Real Firefox profile path required for installed MV2 popup acceptance');
  let uuid;
  await until(()=>{
    try {
      const prefs=fs.readFileSync(path.join(profileDir,'prefs.js'),'utf8');
      const marker='user_pref("extensions.webextensions.uuids", ';
      const line=prefs.split('\n').find(item=>item.startsWith(marker));
      if(!line)return false;
      const escaped=line.slice(marker.length).replace(/\);\s*$/,'');
      const map=JSON.parse(JSON.parse(escaped));
      uuid=map[addonId];
      return typeof uuid==='string' && /^[a-f0-9-]{36}$/i.test(uuid);
    }catch(_){return false;}
  },'installed Firefox extension UUID in ephemeral profile',60);
  return 'moz-extension://'+uuid+'/popup.html';
}
async function until(fn,description,tries=45){
  for(let i=0;i<tries;i++){if(await fn())return;await sleep(200);}
  throw new Error('Timeout waiting for '+description);
}
try{
  await new Promise((resolve,reject)=>{
    frameServer.once('error',reject);frameServer.listen(0,'127.0.0.1',resolve);
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  assert.notEqual(frameServer.address().port,server.address().port,
    'Framed browser fixture must be cross-origin, not same-port DOM');
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
  const profileDir=started.capabilities?.['moz:profile'];
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
  await click('#submitOverrideHostile');
  await click('#submitOverrideOrdinary');
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
  assert.equal(after.overrideHostileSubmits,before.overrideHostileSubmits,
    'Native Firefox formtarget=_blank/formaction hostile submitter override must be stopped');
  assert.equal(after.overrideOrdinarySubmits,before.overrideOrdinarySubmits+1,
    'Native Firefox harmless submitter override must reach local form submit');
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
  await keyboardActivate('#submitOverrideHostile');
  await keyboardActivate('#submitOverrideOrdinary');
  const afterKeyboard=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(afterKeyboard.hostileClicks,beforeKeyboard.hostileClicks,
    'Trusted Firefox Enter on hostile link must be captured before target');
  assert.equal(afterKeyboard.ordinaryClicks,beforeKeyboard.ordinaryClicks+1,
    'Trusted Firefox Enter must still activate an ordinary link');
  assert.equal(afterKeyboard.hostileSubmits,beforeKeyboard.hostileSubmits,
    'Trusted Firefox Enter on submit button must not launch hostile form');
  assert.equal(afterKeyboard.overrideHostileSubmits,beforeKeyboard.overrideHostileSubmits,
    'Trusted Firefox Enter must block hostile submitter override before form submission');
  assert.equal(afterKeyboard.overrideOrdinarySubmits,beforeKeyboard.overrideOrdinarySubmits+1,
    'Trusted Firefox Enter must preserve harmless submitter override');
  // The iframe is served from a *different loopback port*, so it cannot
  // inherit top-level origin or JS globals. Switch real Firefox frame context.
  const iframe=await wd('POST','/session/'+session+'/element',
    {using:'css selector',value:'#qaCrossOriginFrame'});
  assert.ok(iframe?.['element-6066-11e4-a52e-4f735466cecf'],
    'Cross-origin iframe must be painted in the real browser');
  await wd('POST','/session/'+session+'/frame',{id:iframe});
  await until(()=>evaluate('return !!window.frameQA'),'cross-origin frame document');
  const beforeFrame=JSON.parse(await evaluate('return JSON.stringify(window.frameQA)'));
  await click('#frameHostile');
  await click('#frameOrdinary');
  const afterFrame=JSON.parse(await evaluate('return JSON.stringify(window.frameQA)'));
  assert.equal(afterFrame.hostile,beforeFrame.hostile,
    'Firefox all_frames content script must block cross-origin framed hostile link');
  assert.equal(afterFrame.ordinary,beforeFrame.ordinary+1,
    'Firefox all_frames content script must allow normal cross-origin frame link');
  await wd('POST','/session/'+session+'/frame',{id:null});
  const handles=await wd('GET','/session/'+session+'/window/handles');
  assert.equal(handles.length,1,'No unauthorized popup may remain');
  const mainWorld=await evaluate('return window.open.name==="zGuardWindowOpen"');
  // A second real browser tab displays the actual installed extension popup.
  // Preserve the original fixture tab: this is live storage propagation, not
  // merely a fresh navigation after settings have changed.
  const originalHandle=await wd('GET','/session/'+session+'/window');
  const popupUrl=await popupOriginForInstalledAddon(addon,profileDir);
  const created=await wd('POST','/session/'+session+'/window/new',{type:'tab'});
  assert.ok(created.handle,'Real Firefox must create a separate popup settings tab');
  // WebDriver New Window returns a handle but does not switch the current
  // browsing context. Explicitly preserve the fixture on its original tab.
  await wd('POST','/session/'+session+'/window',{handle:created.handle});
  await wd('POST','/session/'+session+'/url',{url:popupUrl});
  await until(()=>evaluate(
    'return document.querySelector("#status")?.textContent==="Actief" &&'
    +'!document.querySelector("#enabled")?.disabled'),'actual Firefox popup hydration');
  await click('.switch .track');
  await until(()=>evaluate(
    'return document.querySelector("#status")?.textContent==="Uitgeschakeld" &&'
    +'document.querySelector("#enabled")?.checked===false'),'Firefox popup disable storage');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  await until(()=>evaluate(
    'const anchor=document.getElementById("hostile");const n=window.qa.hostileClicks;'
    +'anchor.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));'
    +'return window.qa.hostileClicks===n+1;'),'disabled policy reaching already-open Firefox tab');
  const disabledBefore=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await click('#hostile');
  const disabledAfter=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(disabledAfter.hostileClicks,disabledBefore.hostileClicks+1,
    'Actual Firefox popup disable must permit trusted native hostile click in existing tab');
  await wd('POST','/session/'+session+'/window',{handle:created.handle});
  await click('.switch .track');
  await click('[data-mode="strict"]');
  await until(()=>evaluate(
    'return document.querySelector("#status")?.textContent==="Actief" &&'
    +'document.querySelector("[data-mode=strict]")?.classList.contains("active")'),
    'strict mode applied through native Firefox popup');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  await until(()=>evaluate(
    'const anchor=document.getElementById("ordinary");const n=window.qa.ordinaryClicks;'
    +'anchor.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));'
    +'return window.qa.ordinaryClicks===n;'),'strict policy reaching already-open Firefox tab');
  const strictBefore=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await click('#ordinary');
  const strictAfter=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(strictAfter.ordinaryClicks,strictBefore.ordinaryClicks,
    'Actual Firefox popup strict mode must stop trusted native ordinary external click');
  // No safety event listener cancels the native middle-click on this link.
  // In strict mode the shipped extension itself must cancel before navigation.
  // The separate localhost port is a real foreign origin but no external host.
  const strictMiddleBefore=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await nativePointer('#nativeMiddleForeign',{button:1});
  const strictMiddleAfter=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(strictMiddleAfter.middleForeignDown,strictMiddleBefore.middleForeignDown+1,
    'Native Firefox strict middle-button pointer-down must reach the link');
  assert.equal(strictMiddleAfter.middleForeignUp,strictMiddleBefore.middleForeignUp+1,
    'Native Firefox strict middle-button pointer-up must reach the link');
  assert.equal(strictMiddleAfter.middleForeignAux,strictMiddleBefore.middleForeignAux,
    'Strict middle-button auxclick must be intercepted before target handler');
  assert.equal((await wd('GET','/session/'+session+'/window/handles')).length,2,
    'Strict native cross-origin middle-click must not leave an extra popup tab');
  // Genuine image-map hit testing: the centre 18px hotspot has no fixture
  // preventDefault listener, unlike safety-guarded hostile baseline areas.
  // Strict mode must stop native target=_blank navigation before <area> click.
  const strictMapBefore=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await nativePointer('#imageMap',{x:0,y:0});
  const strictMapAfter=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(strictMapAfter.nativeMapClicks,strictMapBefore.nativeMapClicks,
    'Strict Firefox popup policy must capture the native area before its target click');
  assert.equal((await wd('GET','/session/'+session+'/window/handles')).length,2,
    'Strict real image-map middle-region new-tab hotspot must not leave a tab');
  // Browser-level fallback: invoke a page-authored window.open from an actual
  // trusted WebDriver button click. The different loopback port is a separate
  // origin, and no external website or production browser is contacted.
  // A harmless same-origin popup must really open first, or a disabled Firefox
  // popup blocker could make the hostile test pass vacuously.
  const strictHandles=await wd('GET','/session/'+session+'/window/handles');
  assert.equal(strictHandles.length,2,'Fixture and real extension popup must be the only tabs');
  await click('#openSameOriginPopup');
  await until(async()=>
    (await wd('GET','/session/'+session+'/window/handles')).length===3,
    'trusted same-origin JavaScript popup positive control',60);
  const sameState=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(sameState.pagePopupSame,1,'Actual page-world button must execute once');
  assert.equal(sameState.pagePopupSameNative,true,
    'Browser must permit a real page-created popup; no vacuous popup-blocker PASS');
  const withSame=await wd('GET','/session/'+session+'/window/handles');
  const samePopupHandle=withSame.find(h=>!strictHandles.includes(h));
  assert.ok(samePopupHandle,'Same-origin positive control must create a distinct browser tab');
  await wd('POST','/session/'+session+'/window',{handle:samePopupHandle});
  await until(()=>evaluate('return location.pathname==="/qa-same-origin-popup"'),
    'native same-origin popup navigated',50);
  await wd('DELETE','/session/'+session+'/window');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  await click('#openCrossOriginPopup');
  const crossState=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(crossState.pagePopupCross,1,
    'Real page JavaScript must request cross-origin window.open once');
  if(!mainWorld)assert.equal(crossState.pagePopupCrossNative,true,
    'Without MAIN-world interception, Firefox must actually open the target before background fallback');
  await until(async()=>
    (await wd('GET','/session/'+session+'/window/handles')).length===2,
    'strict Firefox policy must remove page-created cross-origin popup',60);
  const afterPopupFallback=await wd('GET','/session/'+session+'/window/handles');
  assert.deepEqual(new Set(afterPopupFallback),new Set(strictHandles),
    'Only original fixture and extension settings tab may survive browser-level fallback');
  // HTMLFormElement.submit() bypasses normal submit events entirely. A page
  // click can still launch an opaque target=_blank tab, so validate background
  // tab closure independently of the content-script form-event guard.
  // First require the same programmatic form to open an allowed same-origin tab
  // so disabled popup handling cannot accidentally satisfy this acceptance.
  await click('#programmaticSameForm');
  await until(async()=>
    (await wd('GET','/session/'+session+'/window/handles')).length===3,
    'native same-origin form.submit() tab positive control',60);
  const sameFormState=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(sameFormState.programmaticSame,1,
    'Trusted Firefox click must invoke page-authored form.submit()');
  assert.equal(sameFormState.programmaticSubmitEvents,0,
    'Programmatic form.submit() must actually bypass submit event');
  const withFormTab=await wd('GET','/session/'+session+'/window/handles');
  const allowedFormTab=withFormTab.find(h=>!strictHandles.includes(h));
  assert.ok(allowedFormTab,'Programmatic same-origin form must create a real tab');
  await wd('POST','/session/'+session+'/window',{handle:allowedFormTab});
  await until(async()=>
    new URL(await wd('GET','/session/'+session+'/url')).pathname==='/qa-programmatic-form-allowed',
    'real same-origin form.submit() target navigated',50);
  await wd('DELETE','/session/'+session+'/window');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  await click('#programmaticCrossForm');
  const crossFormState=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(crossFormState.programmaticCross,1,
    'Real page must invoke cross-origin form.submit() once');
  assert.equal(crossFormState.programmaticSubmitEvents,0,
    'No submit event may be used as a false positive guard for native form.submit()');
  await until(async()=>
    (await wd('GET','/session/'+session+'/window/handles')).length===2,
    'strict Firefox must remove cross-origin form.submit() popup',60);
  assert.deepEqual(new Set(await wd('GET','/session/'+session+'/window/handles')),
    new Set(strictHandles),'Programmatic form fallback must preserve only original tabs');
  await wd('POST','/session/'+session+'/window',{handle:created.handle});
  await click('[data-mode="balanced"]');
  await until(()=>evaluate(
    'return document.querySelector("[data-mode=balanced]")?.classList.contains("active")'),
    'balanced mode restored through native popup');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  await until(()=>evaluate(
    'const anchor=document.getElementById("ordinary");const n=window.qa.ordinaryClicks;'
    +'anchor.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));'
    +'return window.qa.ordinaryClicks===n+1;'),
    'balanced policy restored inside existing Firefox tab');
  const balancedBefore=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await click('#ordinary');
  const balancedAfter=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(balancedAfter.ordinaryClicks,balancedBefore.ordinaryClicks+1,
    'Balanced mode must restore a native harmless cross-origin Firefox link');
  // A strict-mode deny must not linger after the user changes mode. Use the
  // exact same page-authored window.open button and the same foreign loopback
  // origin that strict mode just rejected. Native popup must now persist.
  const balancedHandles=await wd('GET','/session/'+session+'/window/handles');
  assert.equal(balancedHandles.length,2,
    'Balanced popup control starts with only fixture and extension settings tabs');
  await click('#openCrossOriginPopup');
  await until(async()=>
    (await wd('GET','/session/'+session+'/window/handles')).length===3,
    'balanced mode must retain ordinary cross-origin JavaScript popup',60);
  const balancedPageState=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(balancedPageState.pagePopupCross,2,
    'Strict and balanced modes must each execute one trusted page open gesture');
  assert.equal(balancedPageState.pagePopupCrossNative,true,
    'Balanced page-world window.open must return an actual opened browser handle');
  const balancedOpenHandles=await wd('GET','/session/'+session+'/window/handles');
  const balancedPopupHandle=balancedOpenHandles.find(h=>!balancedHandles.includes(h));
  assert.ok(balancedPopupHandle,
    'Ordinary cross-origin balanced popup must have an independent native tab');
  await wd('POST','/session/'+session+'/window',{handle:balancedPopupHandle});
  await until(async()=>
    new URL(await wd('GET','/session/'+session+'/url')).pathname==='/child',
    'balanced popup actually loaded the distinct-origin local target',50);
  const loadedPage=new URL(await wd('GET','/session/'+session+'/url'));
  assert.equal(loadedPage.origin,'http://127.0.0.1:'+frameServer.address().port,
    'Allowed balanced page-created tab must load the second, distinct loopback origin');
  await wd('DELETE','/session/'+session+'/window');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  assert.deepEqual(new Set(await wd('GET','/session/'+session+'/window/handles')),
    new Set(balancedHandles),'Closing the allowed popup must restore original two tabs');
  // Follow the strict-mode eventless form.submit() rejection with a live
  // strict -> balanced mode transition in this *same already-open Firefox tab*.
  // In balanced mode an ordinary distinct-origin form.submit() must survive.
  // Assert a real new tab and loaded target, not merely a DOM click handler.
  const balancedFormBefore=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await click('#programmaticCrossForm');
  await until(async()=>
    (await wd('GET','/session/'+session+'/window/handles')).length===3,
    'balanced native cross-origin form.submit() must open a real tab',60);
  const balancedFormAfter=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(balancedFormAfter.programmaticCross,balancedFormBefore.programmaticCross+1,
    'Trusted native click must execute balanced page-authored form.submit()');
  assert.equal(balancedFormAfter.programmaticSubmitEvents,0,
    'Balanced programmatic form.submit() must remain an eventless bypass fixture');
  const withBalancedForm=await wd('GET','/session/'+session+'/window/handles');
  const balancedFormTab=withBalancedForm.find(h=>!balancedHandles.includes(h));
  assert.ok(balancedFormTab,
    'Ordinary balanced programmatic form must create its own native Firefox tab');
  await wd('POST','/session/'+session+'/window',{handle:balancedFormTab});
  await until(async()=>
    new URL(await wd('GET','/session/'+session+'/url')).pathname==='/child',
    'balanced cross-origin form.submit() target must load',50);
  assert.equal(new URL(await wd('GET','/session/'+session+'/url')).origin,
    'http://127.0.0.1:'+frameServer.address().port,
    'The allowed balanced form destination must be a distinct loopback origin');
  await wd('DELETE','/session/'+session+'/window');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  assert.deepEqual(new Set(await wd('GET','/session/'+session+'/window/handles')),
    new Set(balancedHandles),
    'Closing balanced programmatic form tab must restore original Firefox handles');
  // An ordinary cross-origin middle click must *actually* open a browser tab
  // after the real popup toggles strict -> balanced. There is no fixture
  // preventDefault on this link; assert a trusted auxclick positive control.
  const balancedMiddleBefore=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await nativePointer('#nativeMiddleForeign',{button:1});
  await until(async()=>
    (await wd('GET','/session/'+session+'/window/handles')).length===3,
    'balanced Firefox native middle-click must open an ordinary external tab',60);
  const balancedMiddleAfter=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(balancedMiddleAfter.middleForeignDown,balancedMiddleBefore.middleForeignDown+1,
    'Balanced Firefox middle-button down must be real');
  assert.equal(balancedMiddleAfter.middleForeignUp,balancedMiddleBefore.middleForeignUp+1,
    'Balanced Firefox middle-button up must be real');
  assert.equal(balancedMiddleAfter.middleForeignAux,balancedMiddleBefore.middleForeignAux+1,
    'Balanced native middle-button auxclick must reach the actual anchor target');
  assert.equal(balancedMiddleAfter.middleForeignTrusted,true,
    'Browser-native auxclick must be trusted, not synthetic DOM dispatch');
  const withMiddleTab=await wd('GET','/session/'+session+'/window/handles');
  const middleTabHandle=withMiddleTab.find(h=>!balancedHandles.includes(h));
  assert.ok(middleTabHandle,'Allowed middle-button open must yield a distinct tab');
  await wd('POST','/session/'+session+'/window',{handle:middleTabHandle});
  await until(async()=>
    new URL(await wd('GET','/session/'+session+'/url')).pathname==='/child',
    'allowed native middle-click must load distinct-origin localhost page',50);
  assert.equal(new URL(await wd('GET','/session/'+session+'/url')).origin,
    'http://127.0.0.1:'+frameServer.address().port,
    'Middle-click positive control must load second localhost origin');
  await wd('DELETE','/session/'+session+'/window');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  assert.deepEqual(new Set(await wd('GET','/session/'+session+'/window/handles')),
    new Set(balancedHandles),'Allowed middle-click tab cleanup must restore original tabs');
  // In balanced mode the exact same harmless image-map hotspot must open an
  // actual tab. Without this positive control, a fixture cancelling all clicks
  // would yield a misleading PASS for the strict branch above.
  const balancedMapBefore=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  await nativePointer('#imageMap',{x:0,y:0});
  await until(async()=> (await wd('GET','/session/'+session+'/window/handles')).length===3,
    'balanced native Firefox image-map hotspot must open a real tab',60);
  const balancedMapAfter=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(balancedMapAfter.nativeMapClicks,balancedMapBefore.nativeMapClicks+1,
    'Balanced ordinary image-map area click must reach real target');
  assert.equal(balancedMapAfter.nativeMapTrusted,true,
    'Ordinary image-map link must receive trusted native pointer click');
  const withMapTab=await wd('GET','/session/'+session+'/window/handles');
  const mapTabHandle=withMapTab.find(h=>!balancedHandles.includes(h));
  assert.ok(mapTabHandle,'Balanced image-map link must create an independent tab');
  await wd('POST','/session/'+session+'/window',{handle:mapTabHandle});
  await until(async()=> new URL(await wd('GET','/session/'+session+'/url')).pathname==='/child',
    'actual image-map-created browser tab must navigate to local second origin',50);
  assert.equal(new URL(await wd('GET','/session/'+session+'/url')).origin,
    'http://127.0.0.1:'+frameServer.address().port,
    'Image-map link positive control must load the separate loopback origin');
  await wd('DELETE','/session/'+session+'/window');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  assert.deepEqual(new Set(await wd('GET','/session/'+session+'/window/handles')),
    new Set(balancedHandles),'Image-map popup cleanup must preserve original tabs');
  await wd('POST','/session/'+session+'/window',{handle:created.handle});
  await wd('DELETE','/session/'+session+'/window');
  await wd('POST','/session/'+session+'/window',{handle:originalHandle});
  const restoredHandles=await wd('GET','/session/'+session+'/window/handles');
  assert.equal(restoredHandles.length,1,
    'Temporary Firefox extension-popup tab must be closed cleanly');
  console.log('Native Firefox MV2 PASS: HTML/SVG/Shadow DOM, middle auxclick, image-map, keyboard and cross-origin iframe protected; ordinary controls pass; one tab.');
  console.log('Firefox MAIN-world window.open guarded='+mainWorld+'; issue #3 independently gated.');
  console.log('Native Firefox MV2 popup PASS: live disabled/strict/balanced settings propagated to existing tab.');
  console.log('Native Firefox form submitter overrides PASS: hostile overrides blocked, harmless overrides allowed, trusted click and Enter.');
  console.log('Firefox programmatic form fallback PASS: permitted local form.submit opens real tab; strict foreign target leaves none; no submit event.');
  console.log('Firefox balanced form.submit PASS: separate-origin eventless form opens and loads native tab, cleans up after strict-mode rejection.');
  console.log('Firefox page-created tab fallback PASS: trusted same-origin window.open survives; strict cross-origin window.open leaves no tab; pageworld='+mainWorld+'.');
  console.log('Firefox balanced page-created popup PASS: harmless second-origin tab survives real window.open and navigates, then closes cleanly.');
  console.log('Firefox native middle-button real-tab PASS: strict cross-origin cancelled; balanced trusted auxclick opens and loads ordinary second-origin tab.');
  console.log('Firefox real image-map tab PASS: strict centre hotspot suppressed; balanced trusted hotspot opens loaded second-origin tab.');
  if(args.includes('--require-pageworld'))assert.equal(mainWorld,true,
    'Issue #3: Firefox isolated-world wrapper is not MAIN-world protection');
}finally{
  if(session)try{await wd('DELETE','/session/'+session,undefined,8000);}catch(_){}
  if(driver){driver.kill('SIGTERM');await sleep(250);if(driver.exitCode===null)driver.kill('SIGKILL');}
  await new Promise(resolve=>server.close(resolve));
  await new Promise(resolve=>frameServer.close(resolve));
}
