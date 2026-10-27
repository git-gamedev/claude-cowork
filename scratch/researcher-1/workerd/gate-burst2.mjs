const BASE="http://localhost:8788", K="A".repeat(43), BAD="B".repeat(43);
const post=(p,b,ip)=>fetch(BASE+p,{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":ip},body:JSON.stringify(b)}).then(r=>r.status);
const login=(l,ip,k=BAD)=>post("/login",{login:l,key:k},ip);
const tally=a=>a.reduce((m,s)=>(m[s]=(m[s]||0)+1,m),{});
console.log("register v1", await post("/register",{username:"VictimOne",key:K},"5.5.5.1"), "register v2", await post("/register",{username:"VictimTwo",key:K},"5.5.5.2"));
// C: sequential wrong-password on existing account, rotating IPs
let C=[]; for(let i=0;i<13;i++) C.push(await login("victimone","4.4.4."+i));
console.log("C seq per-account wrong pw, rotating IPs: first 429 at attempt", C.indexOf(429)+1, JSON.stringify(tally(C)));
console.log("C2 correct pw while locked:", await login("victimone","4.4.9.9",K));
// D: parallel burst per-account, rotating IPs
const D=await Promise.all(Array.from({length:40},(_,i)=>login("victimtwo","3.3.3."+i)));
console.log("D parallel x40 per-account wrong pw:", JSON.stringify(tally(D)), "-> counted failures beyond limit 10 =", (tally(D)[401]||0)-10);
console.log("D2 sequential after burst (new IP):", await login("victimtwo","3.3.9.9"), " correct pw:", await login("victimtwo","3.3.9.8",K));
// B follow-up: after the 60-parallel IP burst earlier, is 6.6.6.6 locked now? (needs same DB state; new burst to a fresh IP)
const B=await Promise.all(Array.from({length:60},()=>login("nobody-xyz","6.6.7.7")));
console.log("B2 parallel x60 one IP:", JSON.stringify(tally(B)));
console.log("B3 next sequential from same IP:", await login("nobody-xyz","6.6.7.7"));
