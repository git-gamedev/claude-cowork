// claude-3: hello/bye storm consistency. One storming socket + observer, N bystanders, long wait.
const BASE='http://localhost:8788', WS='ws://localhost:8788';
const key='C'.repeat(43), sleep=ms=>new Promise(r=>setTimeout(r,ms)); let ipn=0;
const reg=async n=>{const r=await fetch(BASE+'/register',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'12.0.'+(ipn>>8)+'.'+(ipn++&255)},body:JSON.stringify({username:n,key})});return (await r.json()).token};
const conn=(room,token)=>new Promise(res=>{const ws=new WebSocket(`${WS}/presence?room=${room}`,['gcl.v1',token]);const o={ws,inbox:[]};ws.onmessage=e=>{try{o.inbox.push(JSON.parse(e.data))}catch{o.inbox.push(e.data)}};ws.onopen=()=>res(o);});
for (const [label,bystanders] of [['2 sockets (storm+observer)',0],['30 bystanders',30]]) {
  const room=`st${bystanders}.gats.io:8443`, tag=Date.now().toString(36).slice(-4);
  const toks=await Promise.all(Array.from({length:2+bystanders},(_,i)=>reg(`t${i}${tag}${bystanders}`)));
  const [S,O,...B]=await Promise.all(toks.map(t=>conn(room,t)));
  for(const [i,c] of [S,O,...B].entries()){c.ws.send(JSON.stringify({t:'hello',pid:'q'+i,gname:'g'}));await sleep(30);}
  await sleep(500); const m0=O.inbox.length;
  for(let k=0;k<200;k++){S.ws.send(JSON.stringify({t:'bye'}));S.ws.send(JSON.stringify({t:'hello',pid:'q0',gname:'g'}));}
  const t0=Date.now(); let ev=0; while(Date.now()-t0<20000){await sleep(500);ev=O.inbox.slice(m0).filter(m=>m&&(m.t==='join'||m.t==='leave')).length; if(ev>=400)break;}
  const joins=O.inbox.slice(m0).filter(m=>m&&m.t==='join').length, leaves=O.inbox.slice(m0).filter(m=>m&&m.t==='leave').length;
  S.ws.send(JSON.stringify({t:'lookup',ids:['q0']})); await sleep(800);
  const nm=S.inbox.filter(m=>m&&m.t==='names').pop();
  console.log(`${label}: observer got joins=${joins} leaves=${leaves} (expect 200/200) after ${Date.now()-t0} ms; storm socket open=${S.ws.readyState===1}; lookup q0 =>`,JSON.stringify(nm&&nm.names), '| last events:',JSON.stringify(O.inbox.slice(-3)));
  [S,O,...B].forEach(c=>{try{c.ws.close()}catch{}}); await sleep(300);
}
process.exit(0);
