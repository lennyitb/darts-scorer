/* The scoreboard: rendering and input for the game in progress, the new-game
   sheet, and big-screen mode with phones as the keypad. Game rules and state live in game.js. */
import {Game} from './game.js';
import {esc, dialogOpen} from './ui.js';
import {playersHtml, padHtml, sheetHtml, entryHtml} from './board.js';
import {openRoom, sendRoom, closeRoom, eventsUrl, Channel, Publisher, Awake} from './remote.js';
import {qrSvg} from './qr.js';
import {api, session, onSession, queueGame, syncStatus, onSync, flush} from './api.js';
import {openSignIn} from './views/account.js';

const LS='darts-scorer-v1';
const GRIP='<svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">'+[3,9,15].map(y=>`<circle cx="3" cy="${y}" r="1.7"/><circle cx="9" cy="${y}" r="1.7"/>`).join('')+'</svg>';
let game=null, active=false, setupOpen=false, draft=null, buffer='', mult=1, pending=null, msg=null, msgTimer=null;
let roster=null, rosterLoading=false, lastSent='';
const $=id=>document.getElementById(id);
const emit=(type,...a)=>{if(type==='say') say(...a); else if(type==='confetti') confetti(...a);};

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
function endTurn(){game.endTurnEarly(); mult=1; changed();}
function nextLeg(){stopConfetti(); game.nextLeg(); changed();}
function cancelPending(){pending=null; render();}
function setMode(m){S().mode=m; buffer=''; mult=1; save(); render();}

/* ---------- Confetti ---------- */
let confettiRun=0;
// A match win gets the full show; a leg win a smaller, shorter one.
function confetti(size='match'){
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv=$('confetti'), ctx=cv.getContext('2d');
  const dpr=window.devicePixelRatio||1, W=innerWidth, H=innerHeight;
  cv.width=W*dpr; cv.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
  const cs=getComputedStyle(document.documentElement);
  const colors=[cs.getPropertyValue('--red'),cs.getPropertyValue('--green'),'#f3e6c4','#1b221e','#e8b93a'].map(c=>c.trim());
  const leg=size==='leg', nBurst=leg?45:110, nRain=leg?0:90, dur=leg?3200:5500;
  const parts=[];
  const burst=(x,dir)=>{for(let i=0;i<nBurst;i++){const a=(-90+dir*(20+Math.random()*40))*Math.PI/180, v=(leg?8:9)+Math.random()*(leg?6:9);
    parts.push({x,y:H+10,vx:Math.cos(a)*v,vy:Math.sin(a)*v*1.35,w:6+Math.random()*6,h:8+Math.random()*8,r:Math.random()*6,vr:(Math.random()-.5)*.35,c:colors[i%colors.length],o:1});}};
  burst(W*0.05,1); burst(W*0.95,-1);
  if(nRain) setTimeout(()=>{for(let i=0;i<nRain;i++) parts.push({x:Math.random()*W,y:-20-Math.random()*H*.3,vx:(Math.random()-.5)*3,vy:2+Math.random()*3,w:6+Math.random()*6,h:8+Math.random()*8,r:Math.random()*6,vr:(Math.random()-.5)*.3,c:colors[i%colors.length],o:1});},350);
  const id=++confettiRun, t0=performance.now();
  (function frame(t){
    if(id!==confettiRun) return;
    ctx.clearRect(0,0,W,H);
    const age=t-t0;
    for(const p of parts){
      p.vy+=0.28; p.vx*=0.985; p.vy=Math.min(p.vy,6+Math.abs(p.vx)); p.x+=p.vx+Math.sin((age+p.r*100)/260)*0.8; p.y+=p.vy; p.r+=p.vr;
      if(age>dur-1700) p.o=Math.max(0,p.o-0.02);
      ctx.save(); ctx.globalAlpha=p.o; ctx.translate(p.x,p.y); ctx.rotate(p.r); ctx.scale(1,Math.cos(p.r*2));
      ctx.fillStyle=p.c; ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h); ctx.restore();
    }
    if(age<dur) requestAnimationFrame(frame); else ctx.clearRect(0,0,W,H);
  })(t0);
}
function stopConfetti(){confettiRun++; const cv=$('confetti'); cv.getContext('2d').clearRect(0,0,cv.width,cv.height);}

function say(t,kind){msg={t,kind}; clearTimeout(msgTimer); msgTimer=setTimeout(()=>{msg=null;renderMsg();},2600); renderMsg();}

/* ---------- Render ---------- */
function render(){draw(); renderBig(); queuePublish();}
function draw(){
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

function renderPlayers(){const el=$('players'); el.dataset.n=S().players.length; el.innerHTML=playersHtml(game,{big:bigOn()});}

function renderPad(){
  $('pad').innerHTML=padHtml(game,{buffer,mult})+'<div class="msg" id="msg" role="status" aria-live="polite"></div>';
  renderMsg();
}
// Messages show under the pad, or in a banner on the big screen, where the pad is hidden.
function renderMsg(){
  for(const [id,cls] of [['msg','msg'],['banner','banner']]){
    const el=$(id); if(!el) continue;
    el.className=cls+(msg?' '+msg.kind:''); el.textContent=msg?msg.t:'';
  }
  queuePublish();
}

function renderModal(){
  const m=$('modal'), h=sheetHtml(game,{pending,winSync:S().ranked?winSyncText():null});
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

const grip=(i,n)=>n>1?`<button class="grip" data-grip="${i}" aria-label="Move player ${i+1}" aria-keyshortcuts="ArrowUp ArrowDown" title="Drag to reorder">${GRIP}</button>`:'';

function playersField(d){
  if(!d.ranked) return `<div class="field"><span class="lbl">Players, in throwing order</span><div class="names">
      ${d.names.map((n,i)=>`<div>${grip(i,d.names.length)}<input value="${esc(n)}" data-name="${i}" aria-label="Player ${i+1} name" maxlength="20">${d.names.length>1?`<button data-rm="${i}" aria-label="Remove player ${i+1}">×</button>`:''}</div>`).join('')}
    </div>${d.names.length<6?'<button class="add" data-act="addp">Add player</button>':''}</div>`;
  loadRoster();
  const list=(roster||[]).filter(p=>!p.hidden||d.seats.includes(p.id)).sort((a,b)=>a.name.localeCompare(b.name));
  const opts=(id,i)=>list.map(p=>`<option value="${p.id}" ${p.id===id?'selected':''} ${p.id!==id&&d.seats.includes(p.id)?'disabled':''}>${esc(p.name)}</option>`).join('');
  return `<div class="field"><span class="lbl">Players, in throwing order</span><div class="seats">
      ${d.seats.map((id,i)=>`<div>${grip(i,d.seats.length)}<select class="input" data-seat="${i}" aria-label="Player ${i+1}"><option value="">${roster?`Choose player ${i+1}`:'Loading players…'}</option>${opts(id,i)}</select>${d.seats.length>2?`<button data-rmseat="${i}" aria-label="Remove player ${i+1}">×</button>`:''}</div>`).join('')}
    </div>${d.seats.length<6?'<button class="add" data-act="addseat">Add player</button>':''}
    <div class="newp"><input class="input" id="newPlayer" maxlength="20" placeholder="New player's name" aria-label="New player's name" value="${esc(d.newName)}"><button class="btn" data-act="createp">Add to roster</button></div>
    </div>`;
}

function renderSetup(){
  drag=null;
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

/* ---------- Drag to reorder players ---------- */
// Rows slide with transforms while dragging; the draft is reordered and re-rendered on drop.
let drag=null;
function moveSeat(from,to){
  const a=draft.ranked?draft.seats:draft.names;
  a.splice(to,0,a.splice(from,1)[0]); draft.err=''; renderSetup();
}
function startDrag(e,g){
  const row=g.parentElement, list=row.parentElement, rows=[...list.children];
  const from=rows.indexOf(row), step=rows[1].getBoundingClientRect().top-rows[0].getBoundingClientRect().top;
  drag={rows,row,from,to:from,step,y0:e.clientY,id:e.pointerId};
  row.classList.add('dragging'); list.classList.add('sorting'); e.preventDefault();
}
function moveDrag(e){
  if(!drag||e.pointerId!==drag.id) return;
  const {rows,row,from,step}=drag, dy=Math.max(-from*step,Math.min((rows.length-1-from)*step,e.clientY-drag.y0));
  const to=drag.to=Math.round(from+dy/step);
  row.style.transform=`translateY(${dy}px)`;
  rows.forEach((r,i)=>{if(r!==row) r.style.transform=i>from&&i<=to?`translateY(${-step}px)`:i<from&&i>=to?`translateY(${step}px)`:'';});
}
function endDrag(e){
  if(!drag||e.pointerId!==drag.id) return;
  const {from,to}=drag; drag=null;
  if(e.type==='pointerup'&&to!==from) moveSeat(from,to); else renderSetup();
}

/* ---------- Big screen ----------
   This browser runs the game and shows it large, and phones act as its keypad (keypad.js): they
   send commands here and render the view published back. The room is kept in sessionStorage, so
   a reload resumes it but another tab doesn't take it over. */
const BIG='darts-bigscreen-v1';
const LOOPBACK=/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/;
const awake=new Awake();
// big: in big-screen mode. room: {code, hostKey, key} once open. link: 'connecting', 'live', 'down' or 'moved'.
// pairOpen: the pairing card is showing; paired: a phone has connected since this page loaded.
let big=false, room=null, chan=null, publisher=null, phones=0, link='off', pairOpen=false, paired=false, bigKey='', retryTimer=null;
// rev changes with anything a command could depend on, so a command sent against an older board
// is refused instead of landing twice. Seeded from the clock so a reload never repeats one.
let rev=Date.now(), revKey='', acks=[], pubQueued=false;
const bigOn=()=>big&&active;

function storeRoom(){try{if(big&&room) sessionStorage.setItem(BIG,JSON.stringify(room)); else sessionStorage.removeItem(BIG);}catch(e){}}

// Opens a room, or reopens creds' room with the same code (after a reload or a server restart).
async function connectRoom(creds){
  clearTimeout(retryTimer);
  if(chan){chan.close(); chan=null;}
  link='connecting'; renderBig();
  let r;
  try{ r=await openRoom(creds); }
  catch(e){
    if(!big) return;
    link='down'; renderBig();
    retryTimer=setTimeout(()=>connectRoom(creds),5000);
    return;
  }
  if(!big){closeRoom(r.code,r.hostKey).catch(()=>{}); return;}
  if(room&&r.code!==room.code){phones=0; paired=false; pairOpen=true;}
  room=r; storeRoom();
  chan=new Channel(eventsUrl(r.code,r.hostKey),{onEvent:onHostEvent,
    onStatus:st=>{if(link!=='moved'){link=st==='live'?'live':'down'; renderBig();}}});
  renderBig();
}

function onHostEvent(m){
  switch(m.type){
    // The server may have restarted and lost the last view, so send it again.
    case 'hello': phones=m.phones; if(phones){paired=true; pairOpen=false;} else if(!paired) pairOpen=true; publisher.reset(); queuePublish(); break;
    case 'presence': if(typeof m.phones==='number'){if(m.phones&&!paired){paired=true; pairOpen=false;} phones=m.phones;} break;
    case 'command': applyRemote(m.cmd); return;
    case 'gone': connectRoom(room); return;
    case 'replaced': link='moved'; if(chan){chan.close(); chan=null;} break;
    case 'closed': exitBig(); return;
  }
  renderBig();
}

export function enterBig(){
  if(big) return;
  big=true; room=null; phones=0; paired=false; pairOpen=true;
  publisher=new Publisher(v=>room?sendRoom(room.code,room.hostKey,{state:v}):Promise.reject(new Error('No room')));
  connectRoom(null); render();
}
export function exitBig(){
  if(!big) return;
  big=false; clearTimeout(retryTimer);
  if(chan){chan.close(); chan=null;}
  if(publisher){publisher.stop(); publisher=null;}
  if(room) closeRoom(room.code,room.hostKey).catch(()=>{});
  room=null; phones=0; link='off'; storeRoom(); awake.release();
  if(document.fullscreenElement) document.exitFullscreen().catch(()=>{});
  render();
}
// Takes the room back from another tab, picking up the game where that tab saved it.
function takeBack(){
  load(); pending=null; buffer=''; mult=1; stopConfetti();
  if(game&&S().ranked) lastSent=JSON.stringify(game.log());
  connectRoom(room); render();
}
// Disconnect phones: close the room and open another, with a new code and key.
async function rotate(){
  const old=room;
  if(chan){chan.close(); chan=null;}
  room=null; phones=0; paired=false; pairOpen=true; renderBig();
  if(old) await closeRoom(old.code,old.hostKey).catch(()=>{});
  if(big) connectRoom(null);
}

function refreshRev(){
  const k=JSON.stringify([game&&!setupOpen?S():null,pending&&[pending.v,pending.min]]);
  if(k!==revKey){revKey=k; rev++;}
}
// What phones render. acks answers the last few commands, so none is missed when two land between publishes.
function remoteView(){
  refreshRev();
  const live=!!game&&!setupOpen;
  return {rev,state:live?S():null,pending:live&&pending?{v:pending.v,min:pending.min}:null,msg,acks};
}
function queuePublish(){
  if(!publisher||pubQueued) return;
  pubQueued=true;
  queueMicrotask(()=>{pubQueued=false; if(publisher&&room) publisher.push(remoteView());});
}

const okInt=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
// Checks a phone's command against the rules and the board, since Game trusts its input.
// Returns the move to make, or why not.
function checkRemote(c){
  const s=S(), cfg=s.config;
  switch(c.cmd){
    case 'undo': return undo;
    case 'cancel': return pending?cancelPending:'There is no checkout to cancel.';
    case 'checkout': return !pending?'There is no checkout to confirm.':okInt(c.n,pending.min,3)?()=>confirmCheckout(c.n):"That checkout can't take that many darts.";
    case 'bust': return pending&&cfg.doubleOut?pendingBust:'There is no checkout to bust.';
  }
  if(pending) return 'Answer the checkout question first.';
  switch(c.cmd){
    case 'nextleg': return s.legWinner!=null&&s.matchWinner==null?nextLeg:"The leg isn't over.";
    case 'rematch': return s.matchWinner!=null?rematch:"The match isn't over.";
  }
  if(game.over) return 'The leg is over.';
  switch(c.cmd){
    case 'mode': return c.mode!=='total'&&c.mode!=='darts'?'Unknown entry mode.':c.mode==='total'&&s.turn.length?'Finish the turn first.':()=>setMode(c.mode);
    case 'total': return s.mode!=='total'?'Switch to turn totals first.':okInt(c.v,0,180)?()=>submitTotal(c.v):'Scores run from 0 to 180.';
    case 'dart': {
      const {m,n}=c, seg=okInt(n,0,20)||n===25||n===50;
      if(s.mode!=='darts') return 'Switch to dart by dart first.';
      return [1,2,3].includes(m)&&seg&&!(m===3&&n>20)?()=>addDart(m,n):'Unknown dart.';
    }
    case 'endturn': return s.mode==='darts'&&s.turn.length?endTurn:'There are no darts to end the turn on.';
  }
  return 'Unknown command.';
}
function applyRemote(c){
  if(!c||typeof c!=='object') return;
  refreshRev();
  let why=null;
  if(c.rev!==rev) why='The board changed before that arrived. Check it and enter again.';
  else if(!game||setupOpen) why='A new game is being set up on the big screen.';
  else {
    const move=checkRemote(c);
    if(typeof move==='string') why=move;
    // The phone's entry replaces anything half-typed here.
    else {buffer=''; mult=1; move();}
  }
  if(typeof c.id==='string') acks=[...acks.slice(-7),{id:c.id.slice(0,32),ok:!why,...(why?{why}:{})}];
  render();
}

function renderBig(){
  const on=bigOn(), bar=$('bigbar');
  document.body.classList.toggle('big',on);
  bar.hidden=!on;
  if(!on){bigKey=''; if(!big) awake.release(); return;}
  awake.hold();
  const key=JSON.stringify([room&&room.code,phones,link,pairOpen,!!document.fullscreenElement,location.href]);
  if(key!==bigKey){bigKey=key; bar.innerHTML=bigbarHtml();}
  const t=$('typing'), show=!!buffer&&!!game&&!setupOpen;
  t.hidden=!show; t.innerHTML=show?entryHtml(game,buffer):'';
}

function bigbarHtml(){
  const btns=`<button class="ghost" data-act="bigfull">${document.fullscreenElement?'Leave full screen':'Full screen'}</button><button class="ghost" data-act="bigexit">Exit big screen</button>`;
  if(link==='moved') return `<div class="bigchip moved"><span class="dot"></span><span><b>This big screen moved to another tab.</b> Phones are sending scores there now.</span>
    <span class="spacer"></span><button class="ghost" data-act="bigtake">Use this tab</button><button class="ghost" data-act="bigexit">Exit big screen</button></div>`;
  if(!room) return `<div class="bigchip"><span class="dot"></span><span>${link==='down'?"Can't reach the server. Trying again…":'Opening the big screen…'}</span><span class="spacer"></span>${btns}</div>`;
  const down=link==='down'?'<span class="warn-text">Reconnecting…</span>':'';
  if(pairOpen){
    const base=new URL('.',location.href).href, url=`${base}#/keypad/${room.code}/${room.key}`;
    return `<div class="bigcard">
      <div class="qrbox" data-url="${esc(url)}">${qrSvg(url)}</div>
      <div class="pairtext">
        <h2>Enter scores from a phone</h2>
        <p>Scan the code with the phone's camera. Or open <b>${esc(base)}</b> on the phone, tap <b>Big screen</b>, choose <b>Use this device as a keypad</b> and enter</p>
        <div class="code" data-code="${room.code}">${room.code}</div>
        ${LOOPBACK.test(location.hostname)?`<p class="warn">Phones can't open <b>${esc(location.host)}</b>, because to a phone that address means the phone itself. Open this page at the address phones use, such as your public URL, and start the big screen there.</p>`:''}
        <div class="row">${down}${phones?'<button class="btn primary" data-act="pairdone">Done</button>':''}${btns}</div>
      </div></div>`;
  }
  return `<div class="bigchip"><span class="dot ${phones&&link==='live'?'live':''}"></span><span><b>${room.code}</b> · ${phones?`${phones} phone${phones>1?'s':''}`:'No phone connected'}</span>${down}
    <span class="spacer"></span><button class="ghost" data-act="pairmore">Pair a phone</button><button class="ghost" data-act="rotate">Disconnect phones</button>${btns}</div>`;
}
document.addEventListener('fullscreenchange',()=>renderBig());

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
  if(ds.mode){setMode(ds.mode);return;}
  if(ds.quick!=null){submitTotal(+ds.quick);return;}
  if(ds.num!=null){if(buffer.length<3){buffer=(buffer==='0'?'':buffer)+ds.num;} render();return;}
  if(ds.m){mult=mult===+ds.m?1:+ds.m;renderPad();return;}
  if(ds.seg!=null){addDart(mult,+ds.seg);return;}
  if(ds.co){confirmCheckout(+ds.co);return;}
  switch(ds.act){
    case 'back': buffer=buffer.slice(0,-1); render(); break;
    case 'enter': if(buffer) submitTotal(+buffer); break;
    case 'undo': undo(); break;
    case 'endturn': endTurn(); break;
    case 'pbust': pendingBust(); break;
    case 'pcancel': cancelPending(); break;
    case 'nextleg': nextLeg(); break;
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
    case 'bigexit': exitBig(); break;
    case 'bigtake': takeBack(); break;
    case 'bigfull': if(document.fullscreenElement) document.exitFullscreen().catch(()=>{}); else document.documentElement.requestFullscreen().catch(()=>{}); break;
    case 'pairmore': pairOpen=true; renderBig(); break;
    case 'pairdone': pairOpen=false; renderBig(); break;
    case 'rotate': rotate(); break;
  }
}
for(const id of ['game','setup','modal','bigbar']) $(id).addEventListener('click',onClick);
$('setup').addEventListener('input',e=>{
  const t=e.target; if(!draft) return;
  if(t.dataset.name!=null) draft.names[+t.dataset.name]=t.value;
  if(t.id==='newPlayer') draft.newName=t.value;
});
$('setup').addEventListener('change',e=>{
  const t=e.target; if(!draft||t.dataset.seat==null) return;
  draft.seats[+t.dataset.seat]=+t.value||null; draft.err=''; renderSetup();
});
$('setup').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target.id==='newPlayer'){e.preventDefault(); createPlayer();}
  if(draft&&e.target.dataset.grip!=null&&(e.key==='ArrowUp'||e.key==='ArrowDown')){
    e.preventDefault();
    const i=+e.target.dataset.grip, j=i+(e.key==='ArrowUp'?-1:1);
    if(j<0||j>=(draft.ranked?draft.seats:draft.names).length) return;
    moveSeat(i,j); $('setup').querySelector(`[data-grip="${j}"]`).focus();
  }
});
$('setup').addEventListener('pointerdown',e=>{const g=e.target.closest('[data-grip]'); if(g&&draft&&e.button===0&&!drag) startDrag(e,g);});
addEventListener('pointermove',moveDrag);
addEventListener('pointerup',endDrag);
addEventListener('pointercancel',endDrag);
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
export function init(){
  load(); if(game&&S().ranked) lastSent=JSON.stringify(game.log());
  let r=null; try{r=JSON.parse(sessionStorage.getItem(BIG)||'null');}catch(e){}
  if(r&&typeof r.code==='string'){
    big=true; room=r;
    publisher=new Publisher(v=>room?sendRoom(room.code,room.hostKey,{state:v}):Promise.reject(new Error('No room')));
    connectRoom(r);
  }
}
