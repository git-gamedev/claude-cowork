const BASE="http://localhost:8789", K="A".repeat(43);
let fails=0; const ok=(c,m,x)=>{console.log((c?"PASS ":"FAIL ")+m+(c?"":" "+JSON.stringify(x)));if(!c)fails++};
const post=async(p,b,ip)=>{const r=await fetch(BASE+p,{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":ip},body:JSON.stringify(b)});let d={};try{d=await r.json()}catch{};return{s:r.status,d}};
const lastCode=async to=>{const m=(await (await fetch(BASE+"/__mails")).json()).filter(x=>x.to===to);return m.length?m[m.length-1].code:null};
const dev=n=>"dev"+String(n).padStart(2,"0")+"X".repeat(20), wrong=c=>c==="000000"?"000001":"000000";
const mk=async(n,ip)=>{const r=await post("/register",{username:n,key:K,email:n.toLowerCase()+"@example.com",dev:dev(80)},ip);return{t:r.d.ticket,c:await lastCode(n.toLowerCase()+"@example.com"),s:r.s,e:r.d.error}};
const A=await mk("BanA","80.1.0.1"), B=await mk("BanB","80.1.0.2"); ok(A.t&&B.t,"two fresh tickets",[A,B]);
const atk="80.0.0.1"; let seq=[];
for(const x of [A,B]) for(let i=0;i<5;i++){const r=await post("/verify",{ticket:x.t,code:wrong(x.c)},atk);seq.push(r.s);}
console.log("10 counted wrong guesses (2 codes x 5):",seq.join(","));
let r=await post("/verify",{ticket:A.t,code:wrong(A.c)},atk); console.log("11th request status",r.s,r.d.error);
r=await post("/login",{login:"mailer1",key:K,dev:dev(1)},atk); ok(r.s===429&&r.d.error==="ip_banned","banned IP: login with correct pw + known device -> 429 ip_banned",r);
r=await post("/register",{username:"Newbie",key:K,email:"newbie@example.com",dev:dev(81)},atk); ok(r.s===429&&r.d.error==="ip_banned","banned IP: register -> 429 ip_banned",r);
r=await post("/login",{login:"mailer1",key:K,dev:dev(1)},"80.9.9.9"); ok(r.s===200,"same account from another IP still logs in (no account lockout)",r.s);
console.log(fails?`\n${fails} FAILED`:"\nALL PASSED"); process.exit(0);
