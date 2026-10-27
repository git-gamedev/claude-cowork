// claude-3 (#28): can ONE IP exhaust the global daily signup cap (MAX_REG_PER_DAY, default 300) with requests that
// the per-IP gate already rejects (and with garbage bodies)? Then does a legit user on another IP get 429?
const BASE='http://localhost:8788', key='C'.repeat(43);
const post=(body,ip)=>fetch(BASE+'/register',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':ip},body:JSON.stringify(body)}).then(r=>r.status);
const tally=a=>a.reduce((m,s)=>(m[s]=(m[s]||0)+1,m),{});
const before=await post({username:'legit'+Date.now().toString(36).slice(-5),key},'60.0.0.1');
console.log('legit register BEFORE attack (fresh IP):',before);
const res=[]; for(let i=0;i<310;i++) res.push(await post({garbage:true},'66.6.6.6'));
console.log('attacker, ONE IP, 310 invalid register requests:',JSON.stringify(tally(res)));
const after=[]; for(let i=0;i<3;i++) after.push(await post({username:'victim'+i+Date.now().toString(36).slice(-4),key},'60.0.1.'+i));
console.log('legit users on 3 DIFFERENT fresh IPs AFTER attack:',after.join(','),'(200 = fine, 429 = signup DoS)');
process.exit(0);
