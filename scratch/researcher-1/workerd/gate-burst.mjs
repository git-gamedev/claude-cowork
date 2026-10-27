const BASE="http://localhost:8788", K="A".repeat(43);
const login=(l,ip)=>fetch(BASE+"/login",{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":ip},body:JSON.stringify({login:l,key:K})}).then(r=>r.status);
const tally=a=>a.reduce((m,s)=>(m[s]=(m[s]||0)+1,m),{});
// A: sequential, nonexistent account, one IP
let A=[]; for(let i=0;i<24;i++) A.push(await login("zzz-nobody","7.7.7.7"));
console.log("A seq IP-only: first 429 at attempt", A.indexOf(429)+1, JSON.stringify(tally(A)));
// B: parallel burst, nonexistent account, one IP
const B=await Promise.all(Array.from({length:60},()=>login("zzz-nobody","6.6.6.6")));
console.log("B parallel x60 IP-only:", JSON.stringify(tally(B)), "(limit 20 -> excess over 20 =", (tally(B)[401]||0)-20, ")");
// C: existing account, rotating IPs, sequential
const reg=await fetch(BASE+"/register",{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"5.5.5.5"},body:JSON.stringify({username:"Victim",key:K})}); console.log("register Victim", reg.status);
let C=[]; for(let i=0;i<13;i++) C.push(await login("victim","4.4.4."+i));
console.log("C seq per-account (rotating IPs): first 429 at attempt", C.indexOf(429)+1, JSON.stringify(tally(C)));
// D: parallel burst on existing account, rotating IPs
await fetch(BASE+"/register",{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"5.5.5.6"},body:JSON.stringify({username:"Victim2",key:K})});
const D=await Promise.all(Array.from({length:40},(_,i)=>login("victim2","3.3.3."+i)));
console.log("D parallel x40 per-account:", JSON.stringify(tally(D)), "(limit 10 -> excess over 10 =", (tally(D)[401]||0)-10, ")");
// E: right password still works for the locked account?
const good=await fetch(BASE+"/login",{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"2.2.2.2"},body:JSON.stringify({login:"victim2",key:K})}); console.log("E locked victim2 w/ key (all attempts used wrong? key is the registered key so this is correct pw):", good.status);
