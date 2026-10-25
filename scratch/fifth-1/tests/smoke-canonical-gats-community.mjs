import { webcrypto as crypto } from 'node:crypto';
const BASE='http://localhost:8788', WS='ws://localhost:8788', enc=new TextEncoder();
let ipn=0; const ip=()=>'10.1.'+Math.floor(ipn/250)+'.'+(ipn++%250);
async function key(login,pw){const b=await crypto.subtle.importKey('raw',enc.encode(pw.normalize('NFKC')),'PBKDF2',false,['deriveBits']);return Buffer.from(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode('gats-community-v1:'+login.toLowerCase()),iterations:600000},b,256)).toString('base64url')}
const post=async(p,b,h={})=>{const r=await fetch(BASE+p,{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':ip(),...h},body:JSON.stringify(b)});let d;try{d=await r.json()}catch{d={}};return{status:r.status,data:d}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let fails=0; const ok=(c,m,x)=>{console.log((c?'PASS ':'FAIL ')+m+(c?'':' '+JSON.stringify(x)));if(!c)fails++};
const reg=async(n,pw='password-123')=>post('/register',{username:n,key:await key(n,pw)});
const log=async(n,pw='password-123')=>post('/login',{login:n,key:await key(n,pw)});
let r=await reg('Alice'); ok(r.status===200&&r.data.token,'register',r); const alice=r.data;
r=await reg('alice'); ok(r.status===409,'dup register 409',r);
r=await reg('admin'); ok(r.status===409,'reserved name',r);
r=await log('ALICE'); ok(r.status===200,'login',r);
r=await log('Alice','wrong-wrong'); ok(r.status===401,'wrong pw',r);
r=await post('/refresh',{},{authorization:'Bearer '+alice.token}); ok(r.status===200,'refresh',r);
const bob=(await reg('Bob')).data, carol=(await reg('Carol')).data;
r=await post('/rename',{username:'Bobby',room:'eu1.gats.io'},{authorization:'Bearer '+bob.token}); ok(r.status===200&&r.data.user.username==='Bobby','rename',r);
r=await post('/rename',{username:'Bobby2'},{authorization:'Bearer '+bob.token}); ok(r.status===429,'rename cooldown (token still same tv)',r);
function conn(room,token,origin){return new Promise(res=>{const ws=new WebSocket(`${WS}/presence?room=${room}`,['gcl.v1',token]);const o={ws,inbox:[],closes:[],failed:false};ws.onmessage=e=>o.inbox.push(e.data==='pong'?'pong':JSON.parse(e.data));ws.onclose=e=>o.closes.push(e.code);ws.onerror=()=>{o.failed=true};ws.onopen=()=>res(o);setTimeout(()=>res(o),3000)})}
const room='eu1.gats.io:8443';
const A=await conn(room,alice.token); await sleep(300); ok(!A.failed&&!A.closes.length,'alice ws opens',A);
const C=await conn(room,carol.token); await sleep(300);
A.ws.send(JSON.stringify({t:'hello',pid:'17',gname:'guest1'})); await sleep(300);
ok(A.inbox.some(m=>m.t==='roster'),'alice roster',A.inbox);
ok(C.inbox.some(m=>m.t==='join'&&m.pid==='17'&&m.name==='Alice'),'carol sees join',C.inbox);
C.ws.send(JSON.stringify({t:'hello',pid:'17',gname:'x'})); await sleep(300); ok(C.inbox.some(m=>m.t==='err'&&m.code==='pid_taken'),'pid steal blocked',C.inbox);
C.ws.send(JSON.stringify({t:'hello',pid:'22',gname:'guest2'})); await sleep(200);
C.ws.send(JSON.stringify({t:'lookup',ids:['17','22','99']})); await sleep(300);
const nm=C.inbox.filter(m=>m.t==='names').pop(); ok(nm&&nm.names['17']&&nm.names['17'].name==='Alice'&&!nm.names['99'],'lookup',nm);
// rename push to live room (carol never renamed)
r=await post('/rename',{username:'CarolNew',room},{authorization:'Bearer '+carol.token}); await sleep(400);
ok(A.inbox.some(m=>m.t==='rename'&&m.pid==='22'&&m.name==='CarolNew'),'live rename pushed',A.inbox.filter(m=>m.t==='rename'));
// bad token
const X=await conn(room,'v1.bad.sig'); await sleep(300); ok(X.failed||X.closes.length,'bad token rejected (ws fails)',X);
// bad room
const Y=await conn('evil.example.com',alice.token); await sleep(300); ok(Y.failed||Y.closes.length,'bad room rejected',Y);
// replaced
const A2=await conn(room,alice.token); await sleep(500); ok(A.closes.includes(4000)||A.ws.readyState>=2,'older alice socket closed/closing',[A.closes,A.ws.readyState]);
// admin ban + kick
r=await post('/admin/ban',{login:'alice',reason:'t',rooms:[room]},{'x-admin-key':'canon-admin-key-1234567890'}); ok(r.status===200,'admin ban',r);
await sleep(500); ok(A2.closes.includes(4002)||A2.ws.readyState>=2,'banned socket kicked',[A2.closes,A2.ws.readyState]);
r=await log('Alice'); ok(r.status===403,'banned login 403',r);
r=await post('/admin/ban',{login:'alice'},{'x-admin-key':'wrong'}); ok(r.status===401,'admin wrong key',r);
// gate: same IP hammering
let last; for(let i=0;i<12;i++){last=await fetch(BASE+'/login',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'9.9.9.9'},body:JSON.stringify({login:'zzz',key:'A'.repeat(43)})});}
ok(last.status===429,'gate rate limits after 10 hits',last.status);
// gate counts successful logins too?
const D=(await reg('Dora')).data; let st=[]; for(let i=0;i<11;i++){const rr=await fetch(BASE+'/login',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'8.8.8.8'},body:JSON.stringify({login:'dora',key:await key('dora','password-123')})});st.push(rr.status)}
console.log('11 SUCCESSFUL logins from one IP ->',st.join(','));
console.log(fails?`\n${fails} FAILED`:'\nALL PASSED'); process.exit(fails?1:0);
