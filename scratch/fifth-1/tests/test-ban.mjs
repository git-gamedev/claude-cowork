import { webcrypto as crypto } from 'node:crypto';
import { execSync } from 'node:child_process';
const BASE='http://localhost:8787', WS='ws://localhost:8787', enc=new TextEncoder();
const b64u=u=>Buffer.from(u).toString('base64url'); const unb=s=>new Uint8Array(Buffer.from(s,'base64url'));
async function ph(pw,salt,iter){const k=await crypto.subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveBits']);return b64u(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new Uint8Array([...enc.encode('gcl-v1|'),...unb(salt)]),iterations:iter},k,256)))}
const post=async(p,b,t)=>{const r=await fetch(BASE+p,{method:'POST',headers:{'content-type':'application/json',...(t?{authorization:'Bearer '+t}:{})},body:JSON.stringify(b)});return{status:r.status,data:await r.json()}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let fails=0; const ok=(c,m,x)=>{console.log((c?'PASS ':'FAIL ')+m+(c?'':' '+JSON.stringify(x)));if(!c)fails++};
const salt=b64u(crypto.getRandomValues(new Uint8Array(16)));
const su=await post('/signup',{username:'Eve',salt,ph:await ph('evepassword1',salt,250000),iter:250000});
const eve=su.data; ok(su.status===201,'signup eve',su);
const sql=q=>execSync(`npx wrangler d1 execute gcl-db --local --config wrangler.test.toml --command "${q}"`,{stdio:'pipe'}).toString();
function connect(token){return new Promise(res=>{const ws=new WebSocket(`${WS}/presence?room=r1`,['gcl.v1',token]);const o={ws,inbox:[],closes:[]};ws.onmessage=e=>o.inbox.push(e.data);ws.onclose=e=>o.closes.push(e.code);ws.onerror=()=>{};ws.onopen=()=>res(o);setTimeout(()=>res(o),4000)})}
const E=await connect(eve.token); await sleep(300);
// Eve has a live socket; ban her in D1, then poke the room (another user) so the opportunistic sweep runs after TTL
sql("UPDATE users SET banned=1 WHERE username_lower='eve'");
const salt2=b64u(crypto.getRandomValues(new Uint8Array(16)));
const f=(await post('/signup',{username:'Fay',salt:salt2,ph:await ph('faypassword12',salt2,250000),iter:250000})).data;
await sleep(2500);
const F=await connect(f.token); await sleep(500);        // connect triggers maybeSweep
F.ws.send(JSON.stringify({t:'lookup',gids:['1']})); await sleep(800);
ok(E.inbox.some(m=>m.includes('revoked')),'banned live socket told revoked',E.inbox);
// banned user cannot log in or reconnect
const s=await post('/login/salt',{username:'Eve'}); const l=await post('/login',{username:'Eve',ph:await ph('evepassword1',s.data.salt,s.data.iter)});
ok(l.status===403&&l.data.error==='banned','banned login -> 403',l);
await sleep(2200);
const E2=await connect(eve.token); await sleep(500); ok(E2.closes.includes(4403),'banned reconnect -> 4403',E2.closes);
// token_version bump revokes old tokens
sql("UPDATE users SET banned=0, token_version=token_version+1 WHERE username_lower='eve'");
await sleep(2200);
const r=await post('/rename',{name:'EveNew'},eve.token); ok(r.status===401&&r.data.error==='revoked','old token revoked on HTTP path',r);
const E3=await connect(eve.token); await sleep(500); ok(E3.closes.includes(4401),'old token revoked on ws path -> 4401',E3.closes);
// unregister
const s3=await post('/login/salt',{username:'Fay'}); const bad=await post('/unregister',{ph:b64u(crypto.getRandomValues(new Uint8Array(32)))},f.token);
ok(bad.status===401,'unregister wrong password 401',bad);
const good=await post('/unregister',{ph:await ph('faypassword12',s3.data.salt,s3.data.iter)},f.token);
ok(good.status===200,'unregister ok',good);
const out=sql("SELECT type, count(*) c FROM events GROUP BY type"); console.log(out.match(/"type": "[a-z]+",\s+"c": \d+/g));
const gone=await post('/rename',{name:'Whatever1'},f.token); ok(gone.status===401,'deleted user token dead',gone);
console.log(fails?`\n${fails} FAILED`:'\nALL PASSED'); process.exit(fails?1:0);
