/* The scoreboard: rendering and input for the game in progress, plus the
   new-game sheet. Game rules and state live in game.js. */
import {IMPOSSIBLE, checkout} from './scoring.js';
import {Game} from './game.js';
import {esc, dialogOpen} from './ui.js';
import {api, session, onSession, queueGame, syncStatus, onSync, flush} from './api.js';
import {openSignIn} from './views/account.js';

const LS='darts-scorer-v1';
const QUICK=[0,26,41,45,60,81,85,100,140,180];
let game=null, active=false, setupOpen=false, draft=null, buffer='', mult=1, pending=null, msg=null, msgTimer=null;
let roster=null, rosterLoading=false, lastSent='';
const $=id=>document.getElementById(id);
const emit=(type,...a)=>{if(type==='say') say(...a); else if(type==='confetti') confetti();};

/* ---------- State ---------- */
function save(){try{localStorage.setItem(LS,JSON.stringify(game));}catch(e){}}
function load(){try{const r=JSON.parse(localStorage.getItem(LS)||'null'); if(r&&r.state) game=new Game(r,emit);}catch(e){}}
const S=()=>game.state;

function newGame(cfg,starter=0,ranked=null){
  game=Game.create(cfg,{starter,mode:game?S().mode:'total',ranked},emit);
  buffer='';mult=1;pending=null;lastSent='';save();sync();
}
function changed(){save();sync();render();}

/* ---------- Ranked sync ---------- */
function payload(extra){
  const s=S(), c=s.config;
  return {config:{start:c.start,doubleIn:c.doubleIn,doubleOut:c.doubleOut,legsToWin:c.legsToWin},
    playerIds:s.ranked.playerIds,starter:s.ranked.starter,log:game.log(),...extra};
}
function sync(){
  if(!game||!S().ranked) return;
  const log=JSON.stringify(game.log()); if(log===lastSent) return;
  const first=!lastSent; lastSent=log;
  queueGame(S().ranked.id,payload(),{now:first});
}
// An unfinished ranked game with at least one visit, which starting over would abandon.
function unfinishedRanked(){return !!(game&&S().ranked&&S().matchWinner==null&&game.log().some(l=>l.length));}
function abandonRanked(){if(game&&S().ranked&&S().matchWinner==null) queueGame(S().ranked.id,payload({abandon:true}),{now:true});}
function newGameId(){const b=new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');}

const SYNC_TEXT={saving:'Saving…',saved:'Saved',offline:'Not saved, retry',auth:'Sign in to save',rejected:'Not saved'};
function syncPill(){
  const st=syncStatus(S().ranked.id);
  return `<button class="sync" data-act="sync" data-state="${st.state}" title="${esc(st.msg)}">Ranked · ${SYNC_TEXT[st.state]}</button>`;
}
function winSyncText(){
  const st=syncStatus(S().ranked.id);
  return {saving:'Saving to history…',saved:`Saved to history. <a href="#/history/${S().ranked.id}">View game</a>`,
    offline:'Not saved yet. It will retry when the server is back.',auth:'Sign in to save this result. <button class="link" data-act="signin">Sign in</button>',
    rejected:`The server didn't accept this game: ${esc(st.msg)}`}[st.state];
}
onSync(id=>{
  if(!game||!S().ranked||S().ranked.id!==id||!active) return;
  renderRules(); const w=$('winSync'); if(w) w.innerHTML=winSyncText();
});
onSession(()=>{roster=null; if(active&&(setupOpen||!game)){draft=null; render();}});

/* ---------- Actions ---------- */
function undo(){
  if(pending){pending=null;render();return;}
  if(buffer){buffer='';render();return;}
  if(!game.undo()){say('Nothing to undo','bad');return;}
  mult=1; if(S().matchWinner==null) stopConfetti(); changed();
}
function submitTotal(v){buffer=''; pending=game.submitTotal(v); mult=1; changed();}
function confirmCheckout(n){const p=pending; pending=null; game.confirmCheckout(p,n); changed();}
function pendingBust(){pending=null; game.pendingBust(); changed();}
function addDart(m,n){game.addDart(m,n); mult=1; changed();}

/* ---------- Confetti ---------- */
let confettiRun=0;
function confetti(){
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv=$('confetti'), ctx=cv.getContext('2d');
  const dpr=window.devicePixelRatio||1, W=innerWidth, H=innerHeight;
  cv.width=W*dpr; cv.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
  const cs=getComputedStyle(document.documentElement);
  const colors=[cs.getPropertyValue('--red'),cs.getPropertyValue('--green'),'#f3e6c4','#1b221e','#e8b93a'].map(c=>c.trim());
  const parts=[];
  const burst=(x,dir)=>{for(let i=0;i<110;i++){const a=(-90+dir*(20+Math.random()*40))*Math.PI/180, v=9+Math.random()*9;
    parts.push({x,y:H+10,vx:Math.cos(a)*v,vy:Math.sin(a)*v*1.35,w:6+Math.random()*6,h:8+Math.random()*8,r:Math.random()*6,vr:(Math.random()-.5)*.35,c:colors[i%colors.length],o:1});}};
  burst(W*0.05,1); burst(W*0.95,-1);
  setTimeout(()=>{for(let i=0;i<90;i++) parts.push({x:Math.random()*W,y:-20-Math.random()*H*.3,vx:(Math.random()-.5)*3,vy:2+Math.random()*3,w:6+Math.random()*6,h:8+Math.random()*8,r:Math.random()*6,vr:(Math.random()-.5)*.3,c:colors[i%colors.length],o:1});},350);
  const id=++confettiRun, t0=performance.now();
  (function frame(t){
    if(id!==confettiRun) return;
    ctx.clearRect(0,0,W,H);
    const age=t-t0;
    for(const p of parts){
      p.vy+=0.28; p.vx*=0.985; p.vy=Math.min(p.vy,6+Math.abs(p.vx)); p.x+=p.vx+Math.sin((age+p.r*100)/260)*0.8; p.y+=p.vy; p.r+=p.vr;
      if(age>3800) p.o=Math.max(0,p.o-0.02);
      ctx.save(); ctx.globalAlpha=p.o; ctx.translate(p.x,p.y); ctx.rotate(p.r); ctx.scale(1,Math.cos(p.r*2));
      ctx.fillStyle=p.c; ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h); ctx.restore();
    }
    if(age<5500) requestAnimationFrame(frame); else ctx.clearRect(0,0,W,H);
  })(t0);
}
function stopConfetti(){confettiRun++; const cv=$('confetti'); cv.getContext('2d').clearRect(0,0,cv.width,cv.height);}

function say(t,kind){msg={t,kind}; clearTimeout(msgTimer); msgTimer=setTimeout(()=>{msg=null;renderMsg();},2600); renderMsg();}

/* ---------- Render ---------- */
const avg=st=>st.darts?(st.pts/st.darts*3).toFixed(1):'0.0';
const chipClass=l=>l[0]==='T'?'t':(l[0]==='D'||l==='Bull')?'d':'';

function render(){
  const showSetup=active&&(setupOpen||!game);
  $('setup').hidden=!showSetup; $('setup').classList.toggle('inline',!game);
  if(showSetup) renderSetup();
  $('game').hidden=!active||!game;
  if(!active||!game){$('modal').hidden=true; return;}
  $('badge').textContent=S().config.start;
  renderRules(); renderPlayers(); renderPad();
  // The setup sheet replaces any checkout or win sheet instead of opening underneath it.
  if(showSetup) $('modal').hidden=true; else renderModal();
}

function renderRules(){
  const s=S(), cfg=s.config;
  const parts=[cfg.doubleIn?'Double in':null,cfg.doubleOut?'double out':'straight out'].filter(Boolean).join(', ');
  $('rules').innerHTML=`<b>${parts.charAt(0).toUpperCase()+parts.slice(1)}</b>${s.ranked?syncPill():''}<br>${cfg.legsToWin>1?`First to ${cfg.legsToWin} legs, leg ${s.leg}`:'Single leg'}`;
}

function renderPlayers(){
  const s=S(), cfg=s.config;
  $('players').innerHTML=s.players.map((p,i)=>{
    const active=i===s.current&&!game.over;
    let rem=p.remaining,left=3;
    if(active&&s.mode==='darts'&&s.turn.length){const r=game.turnEval(); if(!r.bust) rem=r.rem; left=3-s.turn.length;}
    const co=cfg.doubleOut&&p.opened?checkout(rem,active?left:3):null;
    const legs=cfg.legsToWin>1?`<span class="legs" aria-label="${p.legs} legs won">${Array.from({length:cfg.legsToWin},(_,k)=>`<i class="${k<p.legs?'won':''}"></i>`).join('')}</span>`:'';
    return `<section class="player${active?' is-active':''}" ${active?'aria-current="true"':''}>
      <div class="p-name">${esc(p.name)}${legs}${active?'<span class="throwing">to throw</span>':''}</div>
      <div class="p-rem" aria-label="${rem} remaining">${rem}</div>
      <div class="p-meta"><span>Avg ${avg(p.st)}</span><span>Last ${p.last==null?'–':p.last}</span>${active?`<span>Darts ${p.st.darts}</span>`:''}</div>
      ${co?`<div class="co"><span>${active&&left<3?`With ${left} left`:'Checkout'}</span>${co.map(x=>`<b class="${chipClass(x)}">${x}</b>`).join('')}</div>`:''}
      ${!p.opened?'<div class="note">Needs a double to start scoring</div>':''}
    </section>`;
  }).join('');
}

function renderPad(){
  const s=S(), pad=$('pad'), mode=s.mode, p=game.cur;
  let h=`<div class="seg" role="group" aria-label="Entry mode">
    <button data-mode="total" aria-pressed="${mode==='total'}" ${s.turn.length?'disabled':''}>Turn total</button>
    <button data-mode="darts" aria-pressed="${mode==='darts'}">Dart by dart</button></div>`;
  if(mode==='total'){
    let leaves='',bad=false;
    if(buffer){const v=+buffer,nr=p.remaining-v;
      if(v>180||IMPOSSIBLE.has(v)){leaves='Not possible';bad=true;}
      else if(nr<0||(s.config.doubleOut&&nr===1)){leaves='Bust';bad=true;}
      else if(nr===0) leaves='Checkout';
      else leaves=`Leaves ${nr}`;}
    else leaves=`${esc(p.name)} on ${p.remaining}`;
    h+=`<div class="entry"><div class="buf ${buffer?'':'empty'}" aria-live="polite">${buffer||'Enter turn score'}</div><div class="leaves ${bad?'bad':''}">${leaves}</div></div>
    <div class="grid g5">${QUICK.map(q=>`<button class="k q" data-quick="${q}">${q===0?'None':q}</button>`).join('')}</div>
    <div class="grid g3">${[1,2,3,4,5,6,7,8,9].map(n=>`<button class="k" data-num="${n}">${n}</button>`).join('')}
      <button class="k undo" data-act="back" aria-label="Delete digit">⌫</button>
      <button class="k" data-num="0">0</button>
      <button class="k go" data-act="enter" ${buffer?'':'disabled'}>Score</button></div>
    <div class="grid g3"><button class="k undo span3" data-act="undo">Undo last turn</button></div>
    ${!p.opened?'<p class="hint">Enter only the points scored from the opening double onward.</p>':''}`;
  }else{
    const r=game.turnEval();
    h+=`<div class="darts">${[0,1,2].map(i=>{const d=s.turn[i];return `<div class="slot ${d?'full '+chipClass(d.l):''}">${d?d.l:''}</div>`;}).join('')}
      <div class="turn-total" aria-label="Turn total">${r&&!r.bust?r.pts:0}</div></div>
    <div class="mods" role="group" aria-label="Multiplier">${[[1,'Single'],[2,'Double'],[3,'Treble']].map(([m,l])=>`<button data-m="${m}" aria-pressed="${mult===m}">${l}</button>`).join('')}</div>
    <div class="grid g5">${Array.from({length:20},(_,i)=>`<button class="k" data-seg="${i+1}">${i+1}</button>`).join('')}
      <button class="k" data-seg="25" ${mult===3?'disabled':''}>25</button>
      <button class="k" data-seg="50" ${mult===3?'disabled':''}>Bull</button>
      <button class="k small" data-seg="0">Miss</button>
      <button class="k undo" data-act="undo">Undo</button>
      <button class="k small" data-act="endturn" ${s.turn.length?'':'disabled'}>End turn</button></div>
    ${!p.opened?'<p class="hint">Darts count once a double lands.</p>':''}`;
  }
  h+=`<div class="msg" id="msg" role="status" aria-live="polite"></div>`;
  pad.innerHTML=h; renderMsg();
}
function renderMsg(){const el=$('msg'); if(!el) return; el.className='msg'+(msg?' '+msg.kind:''); el.textContent=msg?msg.t:'';}

function statsTable(){
  return `<div class="tablewrap"><table><thead><tr><th>Player</th><th>Legs</th><th>Avg</th><th>Best</th><th>100+</th><th>140+</th><th>180</th><th>Top out</th></tr></thead><tbody>
  ${S().players.map(p=>`<tr><td>${esc(p.name)}</td><td>${p.legs}</td><td>${avg(p.st)}</td><td>${p.st.hi}</td><td>${p.st.t100}</td><td>${p.st.t140}</td><td>${p.st.t180}</td><td>${p.st.hiOut||'–'}</td></tr>`).join('')}
  </tbody></table></div>`;
}
function renderModal(){
  const s=S(), m=$('modal'); let h='';
  if(pending){
    h=`<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">Checkout on ${pending.v}?</h2>
      <p>How many darts did it take?</p>
      <div class="row">${[1,2,3].map(n=>`<button class="btn ${n>=pending.min?'primary':''}" data-co="${n}" ${n<pending.min?'disabled':''}>${n} dart${n>1?'s':''}</button>`).join('')}</div>
      <div class="row">${s.config.doubleOut?'<button class="btn danger" data-act="pbust">Missed the double, bust</button>':''}<button class="btn" data-act="pcancel">Cancel</button></div></div>`;
  }else if(s.matchWinner!=null){
    const w=s.players[s.matchWinner], lc=s.lastCheckout;
    h=`<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">${esc(w.name)} wins${s.config.legsToWin>1?' the match':''}</h2>
      <p>Checked out ${lc.pts} with ${lc.darts} dart${lc.darts>1?'s':''}.</p>${statsTable()}
      ${s.ranked?`<p class="sub" id="winSync">${winSyncText()}</p>`:''}
      <div class="row"><button class="btn primary" data-act="rematch">Rematch, ${esc(s.players[game.loserIndex()].name)} throws first</button><button class="btn" data-act="new">New game</button></div>
      <div class="row"><button class="btn" data-act="undo">Undo checkout</button></div></div>`;
  }else if(s.legWinner!=null){
    const w=s.players[s.legWinner], lc=s.lastCheckout;
    const nextP=s.players[(s.legStarter+1)%s.players.length];
    h=`<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">Leg ${s.leg} to ${esc(w.name)}</h2>
      <p>Checked out ${lc.pts} with ${lc.darts} dart${lc.darts>1?'s':''}. ${esc(nextP.name)} throws first next leg.</p>${statsTable()}
      <div class="row"><button class="btn primary" data-act="nextleg">Start leg ${s.leg+1}</button></div>
      <div class="row"><button class="btn" data-act="undo">Undo checkout</button></div></div>`;
  }
  m.hidden=!h; m.innerHTML=h;
  if(h){const b=m.querySelector('.btn.primary:not([disabled])'); if(b) b.focus();}
}

/* ---------- New game sheet ---------- */
function freshDraft(){
  const acct=session.account, s=game&&S();
  const d=s?{start:s.config.start,doubleOut:s.config.doubleOut,doubleIn:s.config.doubleIn,legsToWin:s.config.legsToWin,names:s.players.map(p=>p.name)}
    :{start:501,doubleOut:true,doubleIn:false,legsToWin:1,names:['Player 1','Player 2']};
  d.ranked=!!acct&&(s?!!s.ranked:true);
  d.seats=s&&s.ranked?[...s.ranked.playerIds]:[acct&&acct.playerId||null,null];
  d.newName=''; d.err=''; d.confirmAbandon=false;
  return d;
}
function loadRoster(){
  if(roster||rosterLoading||!session.account) return;
  rosterLoading=true;
  api.get('api/players').then(r=>{roster=r.players;},e=>{if(draft) draft.err='Could not load players: '+e.message;})
    .finally(()=>{rosterLoading=false; if(active&&(setupOpen||!game)) renderSetup();});
}
const rosterName=id=>(roster.find(p=>p.id===id)||{}).name;

function playersField(d){
  if(!d.ranked) return `<div class="field"><span class="lbl">Players, in throwing order</span><div class="names">
      ${d.names.map((n,i)=>`<div><input value="${esc(n)}" data-name="${i}" aria-label="Player ${i+1} name" maxlength="20">${d.names.length>1?`<button data-rm="${i}" aria-label="Remove player ${i+1}">×</button>`:''}</div>`).join('')}
    </div>${d.names.length<6?'<button class="add" data-act="addp">Add player</button>':''}</div>`;
  loadRoster();
  const list=(roster||[]).filter(p=>!p.hidden||d.seats.includes(p.id)).sort((a,b)=>a.name.localeCompare(b.name));
  const opts=(id,i)=>list.map(p=>`<option value="${p.id}" ${p.id===id?'selected':''} ${p.id!==id&&d.seats.includes(p.id)?'disabled':''}>${esc(p.name)}</option>`).join('');
  return `<div class="field"><span class="lbl">Players, in throwing order</span><div class="seats">
      ${d.seats.map((id,i)=>`<div><select class="input" data-seat="${i}" aria-label="Player ${i+1}"><option value="">${roster?`Choose player ${i+1}`:'Loading players…'}</option>${opts(id,i)}</select>${d.seats.length>2?`<button data-rmseat="${i}" aria-label="Remove player ${i+1}">×</button>`:''}</div>`).join('')}
    </div>${d.seats.length<6?'<button class="add" data-act="addseat">Add player</button>':''}
    <div class="newp"><input class="input" id="newPlayer" maxlength="20" placeholder="New player's name" aria-label="New player's name" value="${esc(d.newName)}"><button class="btn" data-act="createp">Add to roster</button></div>
    </div>`;
}

function renderSetup(){
  if(!draft) draft=freshDraft();
  const d=draft, acct=session.account;
  const rankedRow=session.available?`<div class="toggle"><div>Ranked<small>${acct?'Saved to history, counts toward stats and ratings':'<button class="link" data-act="signin">Sign in</button> to play ranked'}</small></div><button class="switch" role="switch" aria-checked="${d.ranked}" data-tog="ranked" aria-label="Ranked" ${acct?'':'disabled'}></button></div>`:'';
  $('setup').innerHTML=`<div class="sheet" role="dialog" aria-modal="${!!game}" aria-labelledby="st">
    <h2 id="st">New game</h2>
    <div class="field"><span class="lbl">Game</span><div class="chips big">${[301,501,701].map(g=>`<button data-start="${g}" aria-pressed="${d.start===g}">${g}</button>`).join('')}</div></div>
    <div class="field"><span class="lbl">Legs to win</span><div class="chips">${[1,2,3,4,5].map(g=>`<button data-legs="${g}" aria-pressed="${d.legsToWin===g}">${g}</button>`).join('')}</div></div>
    <div class="field">
      <div class="toggle"><div>Double out<small>Finish exactly on a double or the bull</small></div><button class="switch" role="switch" aria-checked="${d.doubleOut}" data-tog="doubleOut" aria-label="Double out"></button></div>
      <div class="toggle"><div>Double in<small>Scoring starts with a double, common in 301</small></div><button class="switch" role="switch" aria-checked="${d.doubleIn}" data-tog="doubleIn" aria-label="Double in"></button></div>
      ${rankedRow}
    </div>
    ${playersField(d)}
    ${d.err?`<p class="err">${esc(d.err)}</p>`:''}
    ${d.confirmAbandon?`<p class="warn">The ranked game in progress will be marked abandoned and won't count toward stats.</p>`:''}
    <div class="row"><button class="btn primary" data-act="start">${d.confirmAbandon?'Abandon and start':'Start game'}</button>${game?'<button class="btn" data-act="cancelsetup">Back to game</button>':''}</div>
  </div>`;
}

async function createPlayer(){
  const d=draft, name=d.newName.trim(); if(!name) return;
  let p;
  try{ p=(await api.post('api/players',{name})).player; }
  catch(e){ if(e.status===409&&e.body&&e.body.player) p=e.body.player; else {d.err=e.message; renderSetup(); return;} }
  if(roster&&!roster.some(x=>x.id===p.id)) roster.push(p);
  if(!d.seats.includes(p.id)){
    const i=d.seats.indexOf(null);
    if(i>=0) d.seats[i]=p.id; else if(d.seats.length<6) d.seats.push(p.id);
  }
  d.newName=''; d.err=''; renderSetup();
  const n=$('newPlayer'); if(n) n.focus();
}

function startGame(){
  const d=draft; d.err='';
  let names, ranked=null;
  if(d.ranked){
    if(!session.account){d.err='Sign in to play ranked.'; return renderSetup();}
    if(!roster||d.seats.some(id=>!id)){d.err='Choose a player for every seat.'; return renderSetup();}
    if(new Set(d.seats).size!==d.seats.length){d.err='Each player can only take one seat.'; return renderSetup();}
    names=d.seats.map(rosterName);
    ranked={id:newGameId(),playerIds:[...d.seats],starter:0};
  }else names=d.names.map((n,i)=>n.trim()||('Player '+(i+1)));
  if(unfinishedRanked()&&!d.confirmAbandon){d.confirmAbandon=true; return renderSetup();}
  abandonRanked();
  const cfg={start:d.start,doubleOut:d.doubleOut,doubleIn:d.doubleIn,legsToWin:d.legsToWin,names};
  setupOpen=false; draft=null; newGame(cfg,0,ranked); render();
}

function rematch(){
  const s=S(), starter=game.loserIndex();
  const ranked=s.ranked?{id:newGameId(),playerIds:s.ranked.playerIds,starter}:null;
  stopConfetti(); newGame(s.config,starter,ranked); render();
}

/* ---------- Events ---------- */
function onClick(e){
  const b=e.target.closest('button'); if(!b||b.disabled) return;
  const ds=b.dataset;
  if(b.id==='newBtn'){openSetup();return;}
  if(ds.start){draft.start=+ds.start;renderSetup();return;}
  if(ds.legs){draft.legsToWin=+ds.legs;renderSetup();return;}
  if(ds.tog){draft[ds.tog]=!draft[ds.tog];draft.confirmAbandon=false;renderSetup();return;}
  if(ds.rm!=null){draft.names.splice(+ds.rm,1);renderSetup();return;}
  if(ds.rmseat!=null){draft.seats.splice(+ds.rmseat,1);renderSetup();return;}
  if(ds.mode){S().mode=ds.mode;buffer='';mult=1;save();render();return;}
  if(ds.quick!=null){submitTotal(+ds.quick);return;}
  if(ds.num!=null){if(buffer.length<3){buffer=(buffer==='0'?'':buffer)+ds.num;} render();return;}
  if(ds.m){mult=mult===+ds.m?1:+ds.m;renderPad();return;}
  if(ds.seg!=null){addDart(mult,+ds.seg);return;}
  if(ds.co){confirmCheckout(+ds.co);return;}
  switch(ds.act){
    case 'back': buffer=buffer.slice(0,-1); render(); break;
    case 'enter': if(buffer) submitTotal(+buffer); break;
    case 'undo': undo(); break;
    case 'endturn': game.endTurnEarly(); mult=1; changed(); break;
    case 'pbust': pendingBust(); break;
    case 'pcancel': pending=null; render(); break;
    case 'nextleg': game.nextLeg(); changed(); break;
    case 'rematch': rematch(); break;
    case 'new': openSetup(); break;
    case 'addp': draft.names.push('Player '+(draft.names.length+1)); renderSetup();
      setTimeout(()=>{const ins=document.querySelectorAll('[data-name]'); ins[ins.length-1].select();},0); break;
    case 'addseat': draft.seats.push(null); renderSetup(); break;
    case 'createp': createPlayer(); break;
    case 'start': startGame(); break;
    case 'cancelsetup': setupOpen=false; draft=null; render(); break;
    case 'signin': openSignIn(); break;
    case 'sync': {const st=syncStatus(S().ranked.id).state;
      if(st==='auth') openSignIn(); else if(st==='rejected') say(syncStatus(S().ranked.id).msg,'bad'); else flush(); break;}
  }
}
for(const id of ['game','setup','modal']) $(id).addEventListener('click',onClick);
$('setup').addEventListener('input',e=>{
  const t=e.target; if(!draft) return;
  if(t.dataset.name!=null) draft.names[+t.dataset.name]=t.value;
  if(t.id==='newPlayer') draft.newName=t.value;
});
$('setup').addEventListener('change',e=>{
  const t=e.target; if(!draft||t.dataset.seat==null) return;
  draft.seats[+t.dataset.seat]=+t.value||null; draft.err=''; renderSetup();
});
$('setup').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='newPlayer'){e.preventDefault(); createPlayer();}});
document.addEventListener('keydown',e=>{
  if(!active||!game||setupOpen||dialogOpen()) return;
  if(/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if((e.key==='z'&&(e.ctrlKey||e.metaKey))||e.key==='u'){e.preventDefault();undo();return;}
  if(pending){ if(['1','2','3'].includes(e.key)&&+e.key>=pending.min){confirmCheckout(+e.key);} else if(e.key==='Escape'){pending=null;render();} return;}
  if(game.over) return;
  if(S().mode!=='total') return;
  if(/^[0-9]$/.test(e.key)){if(buffer.length<3){buffer=(buffer==='0'?'':buffer)+e.key;render();}e.preventDefault();}
  else if(e.key==='Backspace'){buffer=buffer.slice(0,-1);render();e.preventDefault();}
  else if(e.key==='Enter'){if(buffer){submitTotal(+buffer);}e.preventDefault();}
  else if(e.key==='Escape'){buffer='';render();}
});

/* ---------- Public ---------- */
// The roster is refetched each time setup shows, so players added elsewhere appear.
function openSetup(){draft=null; roster=null; setupOpen=true; render();}
export function setActive(on){if(on&&!active) roster=null; if(!on) stopConfetti(); active=on; render();}
// Anything unsent from last time is already waiting in the outbox, so only later changes need queueing.
export function init(){load(); if(game&&S().ranked) lastSent=JSON.stringify(game.log());}
