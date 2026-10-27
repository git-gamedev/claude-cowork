// Repeatability check: parallel failed logins from ONE IP for unknown users (IP limit 20/900s). Fresh IP per trial.
const BASE='http://localhost:8788';
const post=(b,ip)=>fetch(BASE+'/login',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':ip},body:JSON.stringify(b)}).then(r=>r.status);
const tally=a=>a.reduce((m,s)=>(m[s]=(m[s]||0)+1,m),{});
const key='B'.repeat(43), run=Date.now().toString(36);
for (const [n,ip] of [[50,'42.0.0.1'],[100,'42.0.0.2'],[200,'42.0.0.3'],[200,'42.0.0.4'],[30,'42.0.0.5'],[200,'42.0.0.6']]) {
  const res=await Promise.all(Array.from({length:n},(_,i)=>post({login:`u${i}${run.slice(-5)}`,key},ip)));
  const after=await post({login:"zz"+run.slice(-5),key},ip);
  console.log(`N=${n} one IP parallel:`,JSON.stringify(tally(res)),'| next sequential try:',after);
}
