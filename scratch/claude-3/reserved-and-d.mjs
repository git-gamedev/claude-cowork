// claude-3: (1) reserved-name fix on real workerd, probes + false positives; (2) scenario D: 120 sockets, bad frames, hello/bye storm.
const BASE='http://localhost:8788', WS='ws://localhost:8788', room='eu1.gats.io:8443';
let ipn=0; const ip=()=>`11.${(ipn>>16)&255}.${(ipn>>8)&255}.${ipn++&255}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let fails=0;
const ok=(c,m,x)=>{console.log((c?'PASS ':'FAIL ')+m+(c||x===undefined?'':' '+JSON.stringify(x)));if(!c)fails++};
const key='C'.repeat(43);
const reg=async n=>{const r=await fetch(BASE+'/register',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':ip()},body:JSON.stringify({username:n,key})});let d={};try{d=await r.json()}catch{};return{status:r.status,data:d}};

// ---- 1. reserved names
const probes=['admin.','ad-min','a.d.m.i.n','adm1n','Adm1n42','gats_io','gatsio','m0derator','sy5tem','r00t','0wner','support99','roo7','gat5','suppor7','m0d','st4ff','0fficial','s3rver','admln'];
const legit=['adminton','Alice','Bob_builder','Moderate','Sysadmin','Rooted','Gatsby','Lola','Player007','Mod2k','Serverless','Ownership'];
const pr=[]; for(const n of probes){const r=await reg(n); pr.push([n,r.status]); }
console.log('probes (want 409):',pr.map(([n,s])=>n+'='+s).join(' '));
const leaked=pr.filter(([,s])=>s!==409).map(([n])=>n);
ok(leaked.length===0,'reserved-name probes all rejected',leaked);
const lr=[]; for(const n of legit){const r=await reg(n); lr.push([n,r.status]);}
console.log('legit (want 200):',lr.map(([n,s])=>n+'='+s).join(' '));
const fp=lr.filter(([,s])=>s!==200).map(([n])=>n);
ok(fp.length===0,'legit names not falsely rejected',fp);

// ---- 2. scenario D
const N=120, users=[];
for(let b=0;b<N;b+=20){await Promise.all(Array.from({length:Math.min(20,N-b)},async(_,k)=>{const i=b+k;const r=await reg('sk'+i+Date.now().toString(36).slice(-4));if(r.status===200)users.push({i,token:r.data.token,name:r.data.user&&r.data.user.username});}));}
ok(users.length===N,`registered ${N} accounts`,users.length);
const conn=(token)=>new Promise(res=>{const ws=new WebSocket(`${WS}/presence?room=${room}`,['gcl.v1',token]);const o={ws,inbox:[],closes:[],failed:false};ws.onmessage=e=>o.inbox.push(typeof e.data==='string'?(()=>{try{return JSON.parse(e.data)}catch{return e.data}})():'<bin>');ws.onclose=e=>o.closes.push(e.code);ws.onerror=()=>{o.failed=true};ws.onopen=()=>res(o);setTimeout(()=>res(o),8000);});
let t0=Date.now(); const cs=[]; for(let b=0;b<users.length;b+=20){cs.push(...await Promise.all(users.slice(b,b+20).map(u=>conn(u.token))));}
ok(cs.every(c=>c.ws.readyState===1),`${N} sockets open in one room (${Date.now()-t0} ms)`,cs.filter(c=>c.ws.readyState!==1).length);
t0=Date.now(); for(let i=0;i<cs.length;i++){cs[i].ws.send(JSON.stringify({t:'hello',pid:'p'+i,gname:'g'+i}));if(i%20===19)await sleep(150);} await sleep(1500);
console.log(`hello for all ${N}: ${Date.now()-t0} ms`);
const last=cs[N-1].inbox.find(m=>m&&m.t==='roster');
ok(last&&last.players.length>=N-1,'last client roster lists everyone else',last&&last.players.length);
ok(cs[0].inbox.filter(m=>m&&m.t==='join').length===N-1,'first client saw N-1 joins',cs[0].inbox.filter(m=>m&&m.t==='join').length);
const c0=cs[0], mark=c0.inbox.length;
c0.ws.send('ping'); await sleep(300); ok(c0.inbox.slice(mark).includes('pong'),'ping -> pong auto-response');
c0.ws.send(JSON.stringify({t:'hello',pid:'p0',gname:'x'.repeat(40),pad:'y'.repeat(3000)})); // >2KB
c0.ws.send('{not json'); c0.ws.send(new Uint8Array([1,2,3,4,5])); c0.ws.send(JSON.stringify({t:'hello',pid:'bad pid!!'}));
c0.ws.send(JSON.stringify({t:'lookup',ids:Array.from({length:200},(_,i)=>'p'+i)})); await sleep(500);
const nm=c0.inbox.slice(mark).filter(m=>m&&m.t==='names').pop();
ok(c0.ws.readyState===1,'socket survives >2KB, malformed, binary, bad pid frames',c0.closes);
ok(c0.inbox.slice(mark).some(m=>m&&m.t==='err'&&m.code==='bad_pid'),'bad pid -> err bad_pid');
ok(nm&&Object.keys(nm.names).length===50,'lookup of 200 ids capped at 50',nm&&Object.keys(nm.names).length);
// hello/bye storm
const c1=cs[1], base0=cs[2].inbox.length; t0=Date.now();
for(let k=0;k<200;k++){c1.ws.send(JSON.stringify({t:'bye'}));c1.ws.send(JSON.stringify({t:'hello',pid:'p1',gname:'g1'}));} await sleep(2500);
const ev=cs[2].inbox.slice(base0).filter(m=>m&&(m.t==='join'||m.t==='leave')).length;
console.log(`hello/bye storm 200x on one socket: ${Date.now()-t0} ms incl wait, third client saw ${ev} join/leave events`);
ok(c1.ws.readyState===1,'storm socket still open (no per-socket rate limit)',c1.closes);
await sleep(6000); c1.ws.send(JSON.stringify({t:'lookup',ids:['p1']})); await sleep(1500);
const nn=c1.inbox.filter(m=>m&&m.t==='names').pop(); ok(nn&&nn.names.p1,'state consistent after storm',nn);
// health after
const h=await fetch(BASE+'/health'); ok(h.status===200,'worker healthy after load');
cs.forEach(c=>{try{c.ws.close()}catch{}}); await sleep(500);
console.log(fails?`\n${fails} FAILED`:'\nALL PASSED'); process.exit(0);
