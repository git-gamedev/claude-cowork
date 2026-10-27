const BASE="http://localhost:8788", WS="ws://localhost:8788", K="A".repeat(43), room="eu1.gats.io:8443", t0=Date.now();
const log=m=>console.log(((Date.now()-t0)/1000).toFixed(0).padStart(4)+"s "+m);
const post=(p,b,h={})=>fetch(BASE+p,{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"1.1.1."+Math.floor(Math.random()*250),...h},body:JSON.stringify(b)}).then(async r=>({s:r.status,d:await r.json().catch(()=>({}))}));
const a=(await post("/register",{username:"Banme",key:K})).d, b=(await post("/register",{username:"Stayer",key:K})).d;
const conn=t=>new Promise(res=>{const ws=new WebSocket(`${WS}/presence?room=${room}`,["gcl.v1",t]);const o={ws,closes:[]};ws.onclose=e=>{o.closes.push(e.code);log("close "+e.code+" on "+o.n)};ws.onopen=()=>res(o);setTimeout(()=>res(o),3000)});
const A=await conn(a.token); A.n="Banme"; const B=await conn(b.token); B.n="Stayer";
A.ws.send(JSON.stringify({t:"hello",pid:"1",gname:"g1"})); B.ws.send(JSON.stringify({t:"hello",pid:"2",gname:"g2"}));
await new Promise(r=>setTimeout(r,500));
const ban=await post("/admin/ban",{login:"banme",reason:"t"},{"x-admin-key":"canon-admin-key-1234567890"}); log("ban (no rooms listed, no /kick): "+ban.s+" Banme still open="+(A.ws.readyState===1));
for(let i=0;i<460&&!A.closes.length;i++){ if(i%20==0){ B.ws.send("ping"); A.ws.send("ping"); } await new Promise(r=>setTimeout(r,1000)); }
log(A.closes.length?"Banme closed code "+A.closes[0]:"Banme NOT closed within 460s");
log("Stayer open="+(B.ws.readyState===1)+" closes="+JSON.stringify(B.closes));
process.exit(0);
