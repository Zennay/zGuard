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
  +'<script>window.qa={hostileClicks:0,ordinaryClicks:0,hostileSubmits:0};'
  +'for(const id of ["hostile","ordinary"]){'
  +'document.getElementById(id).addEventListener("click",e=>{'
  +'window.qa[id==="hostile"?"hostileClicks":"ordinaryClicks"]++;e.preventDefault();});}'
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
async function click(selector){
  const e=await wd('POST','/session/'+session+'/element',{using:'css selector',value:selector});
  const id=e['element-6066-11e4-a52e-4f735466cecf'];
  assert.ok(id, 'Native element missing: '+selector);
  await wd('POST','/session/'+session+'/element/'+id+'/click',{});
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
  const after=JSON.parse(await evaluate('return JSON.stringify(window.qa)'));
  assert.equal(after.hostileClicks,before.hostileClicks,
    'Native hostile Firefox link must be stopped before target');
  assert.equal(after.ordinaryClicks,before.ordinaryClicks+1,
    'Ordinary Firefox link must still receive native click');
  assert.equal(after.hostileSubmits,before.hostileSubmits,
    'Native hostile target=_blank Firefox form must be stopped');
  const handles=await wd('GET','/session/'+session+'/window/handles');
  assert.equal(handles.length,1,'No unauthorized popup may remain');
  const mainWorld=await evaluate('return window.open.name==="zGuardWindowOpen"');
  console.log('Native Firefox MV2 PASS: hostile link blocked, ordinary link allowed, hostile form blocked, one tab.');
  console.log('Firefox MAIN-world window.open guarded='+mainWorld+'; issue #3 independently gated.');
  if(args.includes('--require-pageworld'))assert.equal(mainWorld,true,
    'Issue #3: Firefox isolated-world wrapper is not MAIN-world protection');
}finally{
  if(session)try{await wd('DELETE','/session/'+session,undefined,8000);}catch(_){}
  if(driver){driver.kill('SIGTERM');await sleep(250);if(driver.exitCode===null)driver.kill('SIGKILL');}
  await new Promise(resolve=>server.close(resolve));
}
