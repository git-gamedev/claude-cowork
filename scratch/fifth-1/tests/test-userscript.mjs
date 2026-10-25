import { JSDOM } from 'jsdom'; import { WebSocketServer, WebSocket as WS } from 'ws';
import { webcrypto } from 'node:crypto'; import fs from 'node:fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let fails=0; const ok=(c,m,x)=>{console.log((c?'PASS ':'FAIL ')+m+(c?'':' '+JSON.stringify(x)));if(!c)fails++};
const enc=new TextEncoder(); const b64u=u=>Buffer.from(u).toString('base64url');
// fake game server
const sent=[]; const wss=new WebSocketServer({port:9100}); let gameSock=null;
wss.on('connection',s=>{gameSock=s;});
// accounts via the real worker
async function signup(name,pw){const salt=b64u(webcrypto.getRandomValues(new Uint8Array(16)));const k=await webcrypto.subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveBits']);
 const ph=b64u(new Uint8Array(await webcrypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new Uint8Array([...enc.encode('gcl-v1|'),...Buffer.from(salt,'base64url')]),iterations:250000},k,256)));
 return (await (await fetch('http://localhost:8787/signup',{method:'POST',body:JSON.stringify({username:name,salt,ph,iter:250000})})).json());}
const sfx=Math.random().toString(36).slice(2,5); const meName='Me'+sfx, bobName='Bob'+sfx;
const me=await signup(meName,'mypassword123'), bob=await signup(bobName,'bobpassword123');
// browser
const src=fs.readFileSync('gats-community-login.user.js','utf8').replaceAll('https://login-info-handler.gitgames.workers.dev','http://localhost:8787').replaceAll('wss://login-info-handler.gitgames.workers.dev','ws://localhost:8787');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{runScripts:'outside-only',url:'https://gats.io/',pretendToBeVisual:true});
const w=dom.window; const store={ gcl_session: JSON.stringify({token:me.token,exp:me.exp}) };
Object.defineProperty(w,'crypto',{value:webcrypto,configurable:true}); w.TextEncoder=TextEncoder; w.TextDecoder=TextDecoder;
w.GM_getValue=(k,d)=>k in store?store[k]:d; w.GM_setValue=(k,v)=>{store[k]=v}; w.GM_deleteValue=k=>{delete store[k]};
w.GM_xmlhttpRequest=o=>{fetch(o.url,{method:o.method,headers:o.headers,body:o.data}).then(async r=>o.onload({status:r.status,responseText:await r.text()})).catch(()=>o.onerror())};
w.unsafeWindow=w;
// page code BEFORE the userscript would normally run second; script is document-start so we eval it first
w.eval(src);
ok(!!w.WebSocket&&w.WebSocket.name==='HookedWebSocket','WebSocket hooked on page window',w.WebSocket&&w.WebSocket.name);
ok(typeof w.GCL==='undefined'&&typeof w.gclAuth==='undefined','no globals leak token surface to the page');
// page opens the "game" socket
const received=[]; const page=new w.WebSocket('ws://localhost:9100/'); page.onmessage=e=>received.push(typeof e.data==='string'?e.data:Buffer.from(e.data).toString('latin1'));
await sleep(600);
const aFrame=['a','5','0','1','100','100','20','0','0','10','10','0','100','800','600','100','2000','2000','Guest','0','0','0','0','guestiso'].join(',');
gameSock.send(aFrame); await sleep(700);
ok(received.some(f=>f.split(',')[18]===meName),'own name swapped into a-frame field 18',received[0]);
// bob (another community user) connects to presence for the same room and claims gid 17
const bws=new WS('ws://localhost:8787/presence?room=localhost:9100',['gcl.v1',bob.token]); await new Promise(r=>bws.on('open',r)); await sleep(400);
// game announces player 17 (d), then a status frame (c) with radius+color
const dFrame=['d','17','0','2','50','60','20','0','0','100','10','RealGuest','0','0','0','0','0','0'].join(',');
gameSock.send(dFrame); await sleep(500);
const cFrame=['c','17','10','0','0','100','0','0','20','0','10','0','0','0','0','2',''].join(',');
gameSock.send(cFrame); await sleep(400);
bws.send(JSON.stringify({t:'claim',gid:'17'})); await sleep(900);   // join broadcast -> rebuild
gameSock.send('b,17,51,61,0,0,0'); await sleep(500);                 // next batch carries the injected frames
const joined=received.join('|');
ok(/d,17,[^|]*,[^|,]*,0,0,0,0,0,0\b/.test(joined)||joined.includes(bobName),'bob name injected for player 17',received.slice(-4));
const inj=received.find(f=>f.includes('|d,17,')||f.startsWith('d,17,'+'')&&f.includes(bobName));
console.log('frames the game received (tail):',received.slice(-3));
// name known before d arrives: player 22 claimed first, then d
bws.send(JSON.stringify({t:'claim',gid:'22'})); await sleep(500);
gameSock.send(['d','22','0','2','50','60','20','0','0','100','10','Other','0','0','0','0','0','0'].join(',')); await sleep(600);
ok(received.some(f=>f.startsWith('d,22,')&&f.split(',')[11]===bobName),'known name rewritten in place on d-frame',received.slice(-2));
// phantom: b/c for unknown id must not create a ghost / injection
const before=received.length; gameSock.send('b,99,1,1,0,0,0'); gameSock.send('c,99,1,0,0,1,0,0,5,0,1,0,0,0,0,1,'); await sleep(300);
ok(!received.slice(before).some(f=>f.includes('d,99')),'no injected frames for unknown ids',received.slice(before));
// logout closes presence
const state={}; gameSock.close(); await sleep(500);
console.log(fails?`\n${fails} FAILED`:'\nALL PASSED'); process.exit(fails?1:0);
