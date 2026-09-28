/* x01 rules, shared by the browser scorer and the server, which replays a
   ranked game's visit log with the same code to validate it and derive stats.
   Bump RULES_VERSION whenever a change here would score an old log differently. */
export const RULES_VERSION = 1;
export const IMPOSSIBLE = new Set([163,166,169,172,173,175,176,178,179]);

/* ---------- Checkout engine ---------- */
const SETUP=[];
for(let n=20;n>=1;n--) SETUP.push({l:'T'+n,s:3*n,c:n>=19?2:n>=17?3:4});
for(let n=20;n>=1;n--) SETUP.push({l:String(n),s:n,c:1});
SETUP.push({l:'25',s:25,c:3},{l:'Bull',s:50,c:6});
for(let n=20;n>=1;n--) SETUP.push({l:'D'+n,s:2*n,c:5});
const DPREF={20:0,16:0,8:1,10:1,18:1,12:1,4:2,6:2,14:2,2:3,1:5};
const FIN=new Map();
for(let n=1;n<=20;n++) FIN.set(2*n,{l:'D'+n,c:DPREF[n]??3});
FIN.set(50,{l:'Bull',c:5});
const coCache=new Map();
// Suggested double-out route for `rem` with `left` darts in hand, or null.
export function checkout(rem,left){
  if(rem<2||rem>170||left<1) return null;
  const key=rem+'|'+left; if(coCache.has(key)) return coCache.get(key);
  let best=null,bc=Infinity;
  const f1=FIN.get(rem); if(f1){best=[f1.l];bc=f1.c;}
  if(left>=2) for(const a of SETUP){const f=FIN.get(rem-a.s); if(f){const c=a.c+f.c+3; if(c<bc){bc=c;best=[a.l,f.l];}}}
  if(left>=3) for(const a of SETUP) for(const b of SETUP){ if(b.s>a.s) continue; const f=FIN.get(rem-a.s-b.s); if(f){const c=a.c+b.c+f.c+6; if(c<bc){bc=c;best=[a.l,b.l,f.l];}}}
  coCache.set(key,best); return best;
}

/* ---------- Fewest darts to finish ---------- */
// Every score one dart can make, and the ones that also count as a double.
const ONE=new Set([25,50]), DBL=new Set([50]);
for(let n=1;n<=20;n++){ONE.add(n).add(2*n).add(3*n); DBL.add(2*n);}
const plus=(a,b)=>{const s=new Set(); for(const x of a) for(const y of b) s.add(x+y); return s;};
const SO=[ONE, plus(ONE,ONE)]; SO.push(plus(SO[1],ONE));
const DO=[DBL, plus(ONE,DBL)]; DO.push(plus(SO[1],DBL));
// Fewest darts that can score exactly v and finish (on a double when doubleOut), or 0 if three can't.
export function minDarts(v,doubleOut){
  const sets=doubleOut?DO:SO;
  for(let i=0;i<3;i++) if(sets[i].has(v)) return i+1;
  return 0;
}

/* ---------- Darts ---------- */
// Dart labels as the pad writes them: '20', 'D16', 'T19', '25', 'Bull', 'Miss'.
export function parseDart(l){
  if(typeof l!=='string') return null;
  if(l==='Miss') return {l,s:0,dbl:false};
  if(l==='25') return {l,s:25,dbl:false};
  if(l==='Bull') return {l,s:50,dbl:true};
  const m=/^([TD]?)([1-9]|1\d|20)$/.exec(l); if(!m) return null;
  const k=m[1]==='T'?3:m[1]==='D'?2:1;
  return {l,s:+m[2]*k,dbl:k===2};
}

// Scores darts thrown from `rem`. Returns {bust,n} or {pts,rem,opened,n,checkout?},
// where n is how many darts counted before the visit ended.
export function evalDarts(cfg,rem,opened,darts){
  let pts=0;
  for(let i=0;i<darts.length;i++){
    const d=darts[i]; let s=d.s;
    if(!opened){ if(d.dbl) opened=true; else s=0; }
    const nr=rem-s;
    if(nr<0||(cfg.doubleOut&&nr===1)||(nr===0&&cfg.doubleOut&&!d.dbl)) return {bust:true,n:i+1};
    rem=nr; pts+=s;
    if(rem===0) return {checkout:true,pts,rem,opened,n:i+1};
  }
  return {pts,rem,opened,n:darts.length};
}

export const newStats=()=>({pts:0,darts:0,hi:0,t100:0,t140:0,t180:0,hiOut:0});

// Folds one committed visit into a player, exactly as the scorer does live.
export function applyVisit(p,{pts,darts,bust,checkout:co,opened}){
  const st=p.st;
  st.darts+=darts;
  if(bust){p.last='Bust'; return;}
  p.remaining-=pts; st.pts+=pts; if(opened) p.opened=true; p.last=pts;
  st.hi=Math.max(st.hi,pts);
  if(pts===180) st.t180++; else if(pts>=140) st.t140++; else if(pts>=100) st.t100++;
  if(co){p.legs++; st.hiOut=Math.max(st.hiOut,pts);}
}

/* ---------- Replay ----------
   A game log is an array of legs, each an array of visits in throwing order:
     {d:['T20','5','D16']}  dart by dart; fewer than 3 darts means the turn ended early (unless it busted or checked out)
     {p:100}                turn total
     {p:32,n:2}             turn total that checked out, with the darts it took
     {b:1}                  turn total that busted
   Leg k (0-based) is started by seat (starter+k) % players, then seats rotate every visit. */
export class ReplayError extends Error {}
const fail=m=>{throw new ReplayError(m);};
const isInt=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;

// Turns one log entry into a commit for player p. Throws ReplayError if the scorer couldn't have produced it.
export function scoreVisit(cfg,p,e){
  if(!e||typeof e!=='object'||Array.isArray(e)) fail('visit must be an object');
  const keys=Object.keys(e).sort().join();
  if(keys==='d'){
    if(!Array.isArray(e.d)||e.d.length<1||e.d.length>3) fail('a visit has 1 to 3 darts');
    const darts=e.d.map(l=>parseDart(l)||fail(`unknown dart ${JSON.stringify(l)}`));
    const r=evalDarts(cfg,p.remaining,p.opened,darts);
    if((r.bust||r.checkout)&&r.n!==darts.length) fail('darts thrown after the visit ended');
    if(r.bust) return {pts:0,darts:r.n,bust:true};
    return {pts:r.pts,darts:r.checkout?r.n:3,checkout:!!r.checkout,opened:r.opened};
  }
  if(keys==='b'){
    if(e.b!==1) fail('bad bust entry');
    if(p.remaining>181||!p.opened) fail('a bust is not possible from '+p.remaining);
    return {pts:0,darts:3,bust:true};
  }
  if(keys!=='p'&&keys!=='n,p') fail('unknown visit shape');
  const v=e.p;
  if(!isInt(v,0,180)||IMPOSSIBLE.has(v)) fail(`${v} isn't possible with three darts`);
  const opened=p.opened||v>0, nr=p.remaining-v;
  if(keys==='n,p'){
    if(nr!==0) fail(`checkout of ${v} from ${p.remaining}`);
    const md=minDarts(v,cfg.doubleOut);
    if(!md||!isInt(e.n,md,3)) fail(`${v} can't be checked out in ${e.n} darts`);
    return {pts:v,darts:e.n,checkout:true,opened};
  }
  if(nr<=0||(cfg.doubleOut&&nr===1)) fail(`${v} from ${p.remaining} must be recorded as a bust or checkout`);
  return {pts:v,darts:3,opened};
}

export function validConfig(c){
  return !!c&&[301,501,701].includes(c.start)&&isInt(c.legsToWin,1,5)
    &&typeof c.doubleIn==='boolean'&&typeof c.doubleOut==='boolean';
}

// Replays a whole log. Returns per-seat totals, every visit, and the match status.
export function replayGame({config:cfg,players:n,starter,log}){
  if(!validConfig(cfg)) fail('bad game config');
  if(!isInt(n,1,6)||!isInt(starter,0,n-1)) fail('bad players or starter');
  if(!Array.isArray(log)||log.length>2*cfg.legsToWin*n) fail('log must be an array of legs');
  const players=Array.from({length:n},()=>({legs:0,remaining:cfg.start,opened:!cfg.doubleIn,last:null,st:newStats()}));
  const legs=[]; let winner=null;
  log.forEach((visits,li)=>{
    if(winner!=null) fail('leg played after the match was won');
    if(li>0&&legs[li-1].winner==null) fail(`leg ${li} never finished`);
    if(!Array.isArray(visits)||visits.length>2000) fail('a leg must be an array of visits');
    const legStarter=(starter+li)%n, leg={leg:li+1,starter:legStarter,winner:null,visits:[]};
    players.forEach(p=>{p.remaining=cfg.start;p.opened=!cfg.doubleIn;p.last=null;});
    visits.forEach((e,i)=>{
      if(leg.winner!=null) fail(`visit after the checkout in leg ${li+1}`);
      const seat=(legStarter+i)%n, p=players[seat];
      const before=p.remaining, wasOpen=p.opened;
      const c=scoreVisit(cfg,p,e);
      applyVisit(p,c);
      leg.visits.push({seat,round:Math.floor(i/n),before,points:c.pts,darts:c.darts,bust:!!c.bust,checkout:!!c.checkout,
        finishable:wasOpen&&minDarts(before,cfg.doubleOut)>0,d:e.d||null});
      if(c.checkout){leg.winner=seat; if(p.legs>=cfg.legsToWin) winner=seat;}
    });
    legs.push(leg);
  });
  const places=players.map(p=>1+players.filter(q=>q.legs>p.legs).length);
  return {status:winner==null?'in_progress':'finished',winner,legs,players,places};
}
