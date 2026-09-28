/* Talks to the server. Every URL is relative so the app works under a subpath. */

export class HttpError extends Error {
  constructor(status,message,body){super(message);this.status=status;this.body=body;}
}

export async function request(method,path,body,{keepalive=false}={}){
  const opt={method,headers:{Accept:'application/json'},credentials:'same-origin',keepalive};
  if(method!=='GET'){opt.headers['Content-Type']='application/json'; opt.body=JSON.stringify(body??{});}
  let res;
  try{ res=await fetch(path,opt); }
  catch(e){ throw new HttpError(0,"Can't reach the server"); }
  let data=null; try{ data=await res.json(); }catch(e){}
  if(!res.ok) throw new HttpError(res.status,(data&&data.error)||res.statusText||'Request failed',data);
  return data;
}
export const api={
  get:p=>request('GET',p),
  post:(p,b)=>request('POST',p,b),
  put:(p,b)=>request('PUT',p,b),
  patch:(p,b)=>request('PATCH',p,b),
  del:p=>request('DELETE',p),
};

/* ---------- Session ---------- */
// account: {id, username, isAdmin, mustChangePw, playerId, playerName} or null.
// available: false when there is no server (e.g. a static host), which hides sign-in.
export const session={account:null,available:false,loaded:false};
const sessionListeners=new Set();
export const onSession=fn=>sessionListeners.add(fn);
function setAccount(a){session.account=a||null; session.loaded=true; sessionListeners.forEach(fn=>fn(session));}

export async function loadSession(){
  try{ const r=await api.get('api/session'); session.available=true; setAccount(r.account); }
  catch(e){ session.available=!!e.body; setAccount(null); }  // a JSON error means our server is there, just unhappy
}
export async function signIn(username,password){
  const r=await api.post('api/session',{username,password}); setAccount(r.account); flush(); return r.account;
}
export async function signOut(){ try{ await api.del('api/session'); }finally{ setAccount(null); } }
export async function changePassword(current,password){
  const r=await api.post('api/account/password',{current,password}); setAccount(r.account); return r.account;
}
export async function refreshSession(){ const r=await api.get('api/session'); setAccount(r.account); }

/* ---------- Ranked game outbox ----------
   Every change to a ranked game queues its full log here. The queue lives in
   localStorage so nothing is lost to a reload, a new game or a dead server.
   rev only ever rises (it is based on the clock), so the server can drop anything stale. */
const OB='darts-outbox-v1';
let ob=readOutbox(), flushing=false, again=false, timer=null, retry=null;
const status={}; // gameId -> {state:'saving'|'saved'|'offline'|'auth'|'rejected', msg}
const syncListeners=new Set();
export const onSync=fn=>syncListeners.add(fn);

function readOutbox(){try{return JSON.parse(localStorage.getItem(OB)||'{}')||{};}catch(e){return {};}}
function writeOutbox(){try{localStorage.setItem(OB,JSON.stringify(ob));}catch(e){}}
function setStatus(id,state,msg=''){status[id]={state,msg}; syncListeners.forEach(fn=>fn(id,status[id]));}

export function syncStatus(id){
  if(status[id]) return status[id];
  return ob[id]?{state:ob[id].rejected?'rejected':'saving',msg:ob[id].rejected||''}:{state:'saved',msg:''};
}

export function queueGame(id,payload,{now=false}={}){
  const prev=ob[id];
  ob[id]={rev:Math.max(Date.now(),prev?prev.rev+1:0),payload};
  writeOutbox(); setStatus(id,'saving');
  clearTimeout(timer); timer=setTimeout(flush,now?0:900);
}

export async function flush(){
  if(flushing){again=true;return;}
  flushing=true; clearTimeout(retry);
  try{
    for(const id of Object.keys(ob)){
      const e=ob[id]; if(!e||e.rejected) continue;
      try{
        await api.put('api/games/'+id,{...e.payload,rev:e.rev});
        if(ob[id]&&ob[id].rev===e.rev) delete ob[id];
        writeOutbox(); setStatus(id,ob[id]?'saving':'saved');
      }catch(err){
        if(err.status===401||err.status===403){ setStatus(id,'auth',err.message); }
        else if(err.status>=400&&err.status<500){ if(ob[id]&&ob[id].rev===e.rev){ob[id].rejected=err.message; writeOutbox();} setStatus(id,'rejected',err.message); }
        else { setStatus(id,'offline',err.message); retry=setTimeout(flush,15000); }
      }
    }
  }finally{
    flushing=false;
    if(again){again=false; flush();}
  }
}

// Last-chance send when the page goes away; the entry stays queued until a later flush confirms it.
window.addEventListener('pagehide',()=>{
  for(const id of Object.keys(ob)){ const e=ob[id]; if(!e.rejected) request('PUT','api/games/'+id,{...e.payload,rev:e.rev},{keepalive:true}).catch(()=>{}); }
});
window.addEventListener('online',()=>flush());
