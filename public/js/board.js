/* Scoreboard markup shared by the scorer, the big screen and the phone keypad.
   Pure functions of a Game plus a few UI values, with no DOM, so they also load in Node.
   The keypad renders state that came over the network, so every value goes through esc(). */
import {IMPOSSIBLE, checkout, scoreVisit, applyVisit, newStats} from './scoring.js';

export const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const QUICK=[0,26,41,45,60,81,85,100,140,180];
export const avg=st=>st.darts?(st.pts/st.darts*3).toFixed(1):'0.0';
export const chipClass=l=>l[0]==='T'?'t':(l[0]==='D'||l==='Bull')?'d':'';

// Each seat's visits so far this leg, oldest first: points, or 'Bust'.
export function legVisits(state){
  const cfg=state.config, n=state.players.length, out=state.players.map(()=>[]);
  const ps=state.players.map(()=>({remaining:cfg.start,opened:!cfg.doubleIn,legs:0,last:null,st:newStats()}));
  try{
    state.visits.forEach((e,i)=>{const seat=(state.legStarter+i)%n, c=scoreVisit(cfg,ps[seat],e); applyVisit(ps[seat],c); out[seat].push(c.bust?'Bust':c.pts);});
  }catch(e){}
  return out;
}

const slots=turn=>[0,1,2].map(i=>{const d=turn[i]; return `<div class="slot ${d?'full '+chipClass(d.l):''}">${d?esc(d.l):''}</div>`;}).join('');

// big: the big screen's cards, which add the turn's darts and this leg's visits.
export function playersHtml(game,{big=false}={}){
  const s=game.state, cfg=s.config, visits=big?legVisits(s):null;
  return s.players.map((p,i)=>{
    const active=i===s.current&&!game.over;
    let rem=p.remaining,left=3;
    if(active&&s.mode==='darts'&&s.turn.length){const r=game.turnEval(); if(!r.bust) rem=r.rem; left=3-s.turn.length;}
    const co=cfg.doubleOut&&p.opened?checkout(rem,active?left:3):null;
    const legs=cfg.legsToWin>1?`<span class="legs" aria-label="${esc(p.legs)} legs won">${Array.from({length:cfg.legsToWin},(_,k)=>`<i class="${k<p.legs?'won':''}"></i>`).join('')}</span>`:'';
    let extra='';
    if(big){
      if(active&&s.mode==='darts') extra+=`<div class="p-turn darts">${slots(s.turn)}</div>`;
      const v=visits[i].slice(-6);
      extra+=`<div class="p-visits" aria-label="This leg">${v.length?v.map(x=>`<b class="${x==='Bust'?'bust':''}">${esc(x)}</b>`).join(''):'<span>No visits yet</span>'}</div>`;
    }
    return `<section class="player${active?' is-active':''}" ${active?'aria-current="true"':''}>
      <div class="p-name">${esc(p.name)}${legs}${active?'<span class="throwing">to throw</span>':''}</div>
      <div class="p-rem" aria-label="${esc(rem)} remaining">${esc(rem)}</div>
      <div class="p-meta"><span>Avg ${esc(avg(p.st))}</span><span>Last ${p.last==null?'–':esc(p.last)}</span>${active||big?`<span>Darts ${esc(p.st.darts)}</span>`:''}</div>
      ${co?`<div class="co"><span>${active&&left<3?`With ${left} left`:'Checkout'}</span>${co.map(x=>`<b class="${chipClass(x)}">${x}</b>`).join('')}</div>`:''}
      ${!p.opened?'<div class="note">Needs a double to start scoring</div>':''}${extra}
    </section>`;
  }).join('');
}

// The typed turn total and what it leaves.
export function entryHtml(game,buffer){
  const p=game.cur, s=game.state;
  let leaves='',bad=false;
  if(buffer){const v=+buffer,nr=p.remaining-v;
    if(v>180||IMPOSSIBLE.has(v)){leaves='Not possible';bad=true;}
    else if(nr<0||(s.config.doubleOut&&nr===1)){leaves='Bust';bad=true;}
    else if(nr===0) leaves='Checkout';
    else leaves=`Leaves ${nr}`;}
  else leaves=`${esc(p.name)} on ${esc(p.remaining)}`;
  return `<div class="entry"><div class="buf ${buffer?'':'empty'}" aria-live="polite">${buffer?esc(buffer):'Enter turn score'}</div><div class="leaves ${bad?'bad':''}">${leaves}</div></div>`;
}

export function padHtml(game,{buffer='',mult=1}={}){
  const s=game.state, mode=s.mode, p=game.cur;
  let h=`<div class="seg" role="group" aria-label="Entry mode">
    <button data-mode="total" aria-pressed="${mode==='total'}" ${s.turn.length?'disabled':''}>Turn total</button>
    <button data-mode="darts" aria-pressed="${mode==='darts'}">Dart by dart</button></div>`;
  if(mode==='total'){
    h+=`${entryHtml(game,buffer)}
    <div class="grid g5">${QUICK.map(q=>`<button class="k q" data-quick="${q}">${q===0?'None':q}</button>`).join('')}</div>
    <div class="grid g3">${[1,2,3,4,5,6,7,8,9].map(n=>`<button class="k" data-num="${n}">${n}</button>`).join('')}
      <button class="k undo" data-act="back" aria-label="Delete digit">⌫</button>
      <button class="k" data-num="0">0</button>
      <button class="k go" data-act="enter" ${buffer?'':'disabled'}>Score</button></div>
    <div class="grid g3"><button class="k undo span3" data-act="undo">Undo last turn</button></div>
    ${!p.opened?'<p class="hint">Enter only the points scored from the opening double onward.</p>':''}`;
  }else{
    const r=game.turnEval();
    h+=`<div class="darts">${slots(s.turn)}
      <div class="turn-total" aria-label="Turn total">${r&&!r.bust?esc(r.pts):0}</div></div>
    <div class="mods" role="group" aria-label="Multiplier">${[[1,'Single'],[2,'Double'],[3,'Treble']].map(([m,l])=>`<button data-m="${m}" aria-pressed="${mult===m}">${l}</button>`).join('')}</div>
    <div class="grid g5">${Array.from({length:20},(_,i)=>`<button class="k" data-seg="${i+1}">${i+1}</button>`).join('')}
      <button class="k" data-seg="25" ${mult===3?'disabled':''}>25</button>
      <button class="k" data-seg="50" ${mult===3?'disabled':''}>Bull</button>
      <button class="k small" data-seg="0">Miss</button>
      <button class="k undo" data-act="undo">Undo</button>
      <button class="k small" data-act="endturn" ${s.turn.length?'':'disabled'}>End turn</button></div>
    ${!p.opened?'<p class="hint">Darts count once a double lands.</p>':''}`;
  }
  return h;
}

export function statsTable(game){
  return `<div class="tablewrap"><table><thead><tr><th>Player</th><th>Legs</th><th>Avg</th><th>Best</th><th>100+</th><th>140+</th><th>180</th><th>Top out</th></tr></thead><tbody>
  ${game.state.players.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.legs)}</td><td>${esc(avg(p.st))}</td><td>${esc(p.st.hi)}</td><td>${esc(p.st.t100)}</td><td>${esc(p.st.t140)}</td><td>${esc(p.st.t180)}</td><td>${p.st.hiOut?esc(p.st.hiOut):'–'}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// The checkout question, or the leg or match result, or '' when none is due.
// winSync: HTML for the ranked save line. canNew: false on the keypad, where new games can't be set up.
export function sheetHtml(game,{pending=null,winSync=null,canNew=true}={}){
  const s=game.state;
  if(pending) return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">Checkout on ${esc(pending.v)}?</h2>
      <p>How many darts did it take?</p>
      <div class="row">${[1,2,3].map(n=>`<button class="btn ${n>=pending.min?'primary':''}" data-co="${n}" ${n<pending.min?'disabled':''}>${n} dart${n>1?'s':''}</button>`).join('')}</div>
      <div class="row">${s.config.doubleOut?'<button class="btn danger" data-act="pbust">Missed the double, bust</button>':''}<button class="btn" data-act="pcancel">Cancel</button></div></div>`;
  const lc=s.lastCheckout, done=lc&&`<p>Checked out ${esc(lc.pts)} with ${esc(lc.darts)} dart${lc.darts>1?'s':''}.`;
  if(s.matchWinner!=null){
    const w=s.players[s.matchWinner];
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">${esc(w.name)} wins${s.config.legsToWin>1?' the match':''}</h2>
      ${done}</p>${statsTable(game)}
      ${winSync!=null?`<p class="sub" id="winSync">${winSync}</p>`:''}
      <div class="row"><button class="btn primary" data-act="rematch">Rematch, ${esc(s.players[game.loserIndex()].name)} throws first</button>${canNew?'<button class="btn" data-act="new">New game</button>':''}</div>
      ${canNew?'':'<p class="sub">To change the players or rules, set up a new game on the big screen.</p>'}
      <div class="row"><button class="btn" data-act="undo">Undo checkout</button></div></div>`;
  }
  if(s.legWinner!=null){
    const w=s.players[s.legWinner], nextP=s.players[(s.legStarter+1)%s.players.length];
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">Leg ${esc(s.leg)} to ${esc(w.name)}</h2>
      ${done} ${esc(nextP.name)} throws first next leg.</p>${statsTable(game)}
      <div class="row"><button class="btn primary" data-act="nextleg">Start leg ${esc(s.leg+1)}</button></div>
      <div class="row"><button class="btn" data-act="undo">Undo checkout</button></div></div>`;
  }
  return '';
}
