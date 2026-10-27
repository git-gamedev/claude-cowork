const BASE="http://localhost:8789", K="A".repeat(43);
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let fails=0;
const ok=(c,m,x)=>{console.log((c?"PASS ":"FAIL ")+m+(c?"":" "+JSON.stringify(x)));if(!c)fails++};
const info=(m,x)=>console.log("INFO "+m+" "+(x===undefined?"":JSON.stringify(x)));
const post=async(p,b,ip,h={})=>{const r=await fetch(BASE+p,{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":ip,...h},body:JSON.stringify(b)});let d={};try{d=await r.json()}catch{};return{s:r.status,d}};
const mails=async()=>(await fetch(BASE+"/__mails")).json();
const lastCode=async to=>{const m=(await mails()).filter(x=>x.to===to);return m.length?m[m.length-1].code:null};
const dev=n=>"dev"+String(n).padStart(2,"0")+"X".repeat(20);
const wrong=c=>c==="000000"?"000001":"000000";
const withRetry=async f=>{let r=await f();if(r.s===429&&r.d.error==="resend_cooldown"){info("cooldown, sleeping",r.d.retryAfter);await sleep((r.d.retryAfter+1)*1000);r=await f()}return r};
const mode=process.argv[2];
if(mode==="legacy"){ const r=await post("/register",{username:"Legacy",key:K},"50.0.0.1"); ok(r.s===200&&r.d.token,"legacy register (EMAIL_VERIFY off)",r); process.exit(0); }

let r=await post("/register",{username:"Mailer1",key:K,dev:dev(1)},"10.0.0.1"); ok(r.s===400&&r.d.error==="invalid_email","register without email -> 400 invalid_email",r);
r=await post("/register",{username:"Mailer1",key:K,email:"m1@example.com",dev:dev(1)},"10.0.0.1"); ok(r.s===202&&r.d.verify==="code"&&r.d.purpose==="verify"&&r.d.hint==="m***@example.com","register -> 202 verify, masked hint",r); const t1=r.d.ticket;
const c1=await lastCode("m1@example.com"); ok(/^\d{6}$/.test(c1),"code mailed (6 digits)",c1);
r=await post("/login",{login:"mailer1",key:K,dev:dev(1)},"10.0.0.2"); info("login before verifying (unverified acct) ->",{s:r.s,p:r.d.purpose,err:r.d.error});
r=await post("/verify",{ticket:t1,code:wrong(c1)},"10.0.0.1"); ok(r.s===401&&r.d.error==="code_invalid"&&r.d.left===4,"wrong code -> 401 left 4",r);
r=await post("/verify",{ticket:t1,code:"12ab"},"10.0.0.1"); ok(r.s===400,"bad code format -> 400",r);
r=await post("/verify",{ticket:t1,code:c1},"10.0.0.1"); ok(r.s===200&&r.d.token,"correct code -> session",r.s);
r=await post("/login",{login:"mailer1",key:K,dev:dev(1)},"10.0.0.2"); ok(r.s===200&&r.d.token,"known device logs in without code",r);
r=await withRetry(()=>post("/login",{login:"mailer1",key:K,dev:dev(2)},"10.0.0.3")); ok(r.s===202&&r.d.purpose==="device","new device -> 202 device challenge",r); const t2=r.d.ticket;
const c2=await lastCode("m1@example.com"); r=await post("/verify",{ticket:t2,code:c2},"10.0.0.3"); ok(r.s===200,"device code -> session",r.s);
r=await post("/login",{login:"mailer1",key:K,dev:dev(2)},"10.0.0.3"); ok(r.s===200,"device 2 now known",r.s);
r=await post("/login",{login:"mailer1",key:K},"10.0.0.3"); info("login with NO dev id ->",{s:r.s,p:r.d.purpose,err:r.d.error});
r=await post("/resend",{ticket:t2},"10.0.0.3"); info("resend right after challenge ->",{s:r.s,err:r.d.error,retryAfter:r.d.retryAfter});
r=await post("/register",{username:"Dupmail",key:K,email:"M1@Example.com",dev:dev(3)},"10.0.0.4"); ok(r.s===409&&r.d.error==="email_taken","duplicate email (case-insens.) -> 409 email_taken",r);
r=await post("/register",{username:"Dupmail",key:K,email:"bad address",dev:dev(3)},"10.0.0.4"); ok(r.s===400,"invalid email -> 400",r);

// IP ban after 10 wrong codes, account not locked
r=await post("/register",{username:"Mailer2",key:K,email:"m2@example.com",dev:dev(4)},"20.0.0.1"); const t3=r.d.ticket; const c3=await lastCode("m2@example.com");
let seq=[]; for(let i=0;i<13;i++){const x=await post("/verify",{ticket:t3,code:wrong(c3)},"60.0.0.1"); seq.push(x.s+(x.d.error?":"+x.d.error:""));}
info("13 wrong codes from one IP",seq.join(" "));
ok(seq.slice(10).every(s=>s.startsWith("429:ip_banned")),"11th+ wrong code -> 429 ip_banned",seq);
r=await post("/login",{login:"mailer1",key:K,dev:dev(1)},"60.0.0.1"); ok(r.s===429&&r.d.error==="ip_banned","banned IP cannot log in (even correct pw, known device)",r);
r=await post("/register",{username:"Mailer9",key:K,email:"m9@example.com",dev:dev(9)},"60.0.0.1"); ok(r.s===429&&r.d.error==="ip_banned","banned IP cannot register",r);
r=await post("/login",{login:"mailer2",key:K,dev:dev(4)},"20.0.0.9"); info("Mailer2 (target of wrong codes) from another IP ->",{s:r.s,err:r.d.error,p:r.d.purpose});
ok(r.s!==429||r.d.error==="resend_cooldown","account NOT locked by code failures (only cooldown at most)",r);

// parallel wrong-code burst on one fresh code, one IP
r=await post("/register",{username:"Mailer3",key:K,email:"m3@example.com",dev:dev(5)},"30.0.0.1"); const t4=r.d.ticket; const c4=await lastCode("m3@example.com");
const par=await Promise.all(Array.from({length:40},()=>post("/verify",{ticket:t4,code:wrong(c4)},"61.0.0.1")));
const tl={}; par.forEach(x=>{const k=x.s+":"+(x.d.error||"");tl[k]=(tl[k]||0)+1}); info("parallel x40 wrong codes, one code, one IP",tl);
const through=par.filter(x=>x.d.error==="code_invalid"||x.d.error==="code_expired").length; ok(through<=10,"parallel burst: <=10 attempts counted before IP ban (Gate /try)",through);
// parallel burst across many IPs against one code: attempts bounded by Verifier (5 tries)
r=await withRetry(()=>post("/resend",{ticket:t4},"30.0.0.2")); const c5=await lastCode("m3@example.com"); info("resend ->",{s:r.s,err:r.d.error});
const par2=await Promise.all(Array.from({length:30},(_,i)=>post("/verify",{ticket:t4,code:wrong(c5)},"62.0.0."+i)));
const t2l={}; par2.forEach(x=>{const k=x.s+":"+(x.d.error||"");t2l[k]=(t2l[k]||0)+1}); info("parallel x30 wrong codes, 30 IPs, one code",t2l);
ok(par2.filter(x=>x.d.error==="code_invalid").length<=4,"wrong guesses on one code capped by Verifier (5 tries)",t2l);

// legacy account (created while EMAIL_VERIFY=off)
r=await post("/login",{login:"legacy",key:K,dev:dev(7)},"50.0.0.2"); ok(r.s===202&&r.d.purpose==="email_needed","legacy account -> 202 email_needed",r); const t5=r.d.ticket;
r=await post("/email",{ticket:t5,email:"legacy@example.com"},"50.0.0.2"); ok(r.s===202&&r.d.purpose==="verify","attach email -> 202 verify",r);
r=await post("/verify",{ticket:r.d.ticket,code:await lastCode("legacy@example.com")},"50.0.0.2"); ok(r.s===200&&r.d.token,"legacy verified -> session",r.s);

// global daily mail cap (MAIL_DAILY_CAP) as an availability lever
let n=0,busy=false; const sent0=(await mails()).length;
for(let i=0;i<40&&!busy;i++){const x=await post("/register",{username:"Burn"+i,key:K,email:`burn${i}@example.com`,dev:dev(10+i)},"70.0."+Math.floor(i/5)+"."+(i%5)); n++; if(x.d.error==="email_busy")busy=true;}
info("registrations needed to hit global mail cap",{registrations:n,mailsSentThisPhase:(await mails()).length-sent0,busy});
r=await post("/login",{login:"mailer1",key:K,dev:dev(1)},"10.0.9.1"); ok(r.s===200,"known device login unaffected by mail cap",r.s);
r=await post("/login",{login:"mailer1",key:K,dev:dev(60)},"10.0.9.2"); info("legit NEW device login while cap reached ->",{s:r.s,err:r.d.error});
r=await post("/register",{username:"Honest1",key:K,email:"honest@example.com",dev:dev(61)},"10.0.9.3"); info("legit new registration while cap reached ->",{s:r.s,err:r.d.error});
console.log(fails?`\n${fails} FAILED`:"\nALL PASSED"); process.exit(0);
