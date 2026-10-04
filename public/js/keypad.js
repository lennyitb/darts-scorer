/* The phone keypad for a big screen (#/keypad). The big screen runs the game: this view renders
   the state it publishes and sends it commands. Typing a total or choosing a multiplier stays
   on the phone until it becomes a whole entry. Kept apart from scorer.js, whose listeners
   would act on this view's buttons. */
import {Game} from './game.js';
import {validConfig} from './scoring.js';
import {esc, playersHtml, padHtml, sheetHtml} from './board.js';
import {joinRoom, sendRoom, eventsUrl, Channel, Awake, randomId} from './remote.js';

const LS='darts-keypad-v1';
const root=document.getElementById('keypad');
const awake=new Awake();
// creds: {code, key}. view: the big screen's last published view. host: the big screen is connected.
// link: 'off', 'connecting', 'live' or 'waiting' (the room isn't open). busy: the command awaiting an answer.
let active=false, creds=null, chan=null, view=null, host=false, link='off', buffer='', mult=1, busy=null, lastRev=null;
let note=null, noteTimer=null, form={code:'',err:'',joining:false};

function loadCreds(){try{const c=JSON.parse(localStorage.getItem(LS)||'null'); return c&&typeof c.code==='string'&&typeof c.key==='string'?c:null;}catch(e){return null;}}
function useCreds(c){
  disconnect(); creds=c;
  try{localStorage.setItem(LS,JSON.stringify(c));}catch(e){}
  connect();
}
function forget(reason=''){
  disconnect(); creds=null; form.err=reason;
  try{localStorage.removeItem(LS);}catch(e){}
  render();
}
function connect(){
  if(!active||!creds||chan) return;
  link='connecting';
  chan=new Channel(eventsUrl(creds.code,creds.key),{onEvent,onStatus:st=>{if(st==='down'&&link==='live'){link='connecting'; host=false; render();}}});
}
function disconnect(){
  if(chan){chan.close(); chan=null;}
  view=null; host=false; link='off'; lastRev=null; buffer=''; mult=1; clearBusy();
}

async function join(code){
  form.joining=true; form.err=''; form.code=code; render();
  try{ const r=await joinRoom(code); form.code=''; useCreds({code:r.code,key:r.key}); }
  catch(e){ form.err=e.status===404?'No big screen has that code. Check the code on the screen.':e.message; }
  finally{ form.joining=false; render(); }
}

function onEvent(m){
  switch(m.type){
    case 'presence': link='live'; host=!!m.host; if(!host) clearBusy(); break;
    case 'state': link='live'; setView(m.view); break;
    // The room isn't open: the big screen may be reloading, asleep, or back after a server restart.
    case 'gone': link='waiting'; host=false; clearBusy(); chan.retry(); break;
    case 'full': return forget('That big screen already has as many phones as it allows.');
    case 'closed': return forget('The big screen disconnected its phones. Scan the code on the screen to carry on.');
  }
  render();
}

function setView(v){
  if(!v||typeof v!=='object'||!Number.isSafeInteger(v.rev)) return;
  // Anything half-typed here was for the board as it was.
  if(v.rev!==lastRev){lastRev=v.rev; buffer=''; mult=1;}
  view=v;
  if(busy){
    const a=(Array.isArray(v.acks)?v.acks:[]).find(x=>x&&x.id===busy.id);
    if(a){ if(!a.ok) flash(a.why||'The big screen refused that.'); clearBusy(); }
  }
}

function clearBusy(){if(busy){clearTimeout(busy.timer); busy=null;}}
function flash(t){note=t; clearTimeout(noteTimer); noteTimer=setTimeout(()=>{note=null; render();},4000);}

async function send(c){
  if(busy||!host||!view||!view.state) return;
  const id=randomId();
  // It may still have gone through, so don't suggest entering it again blindly.
  busy={id,timer:setTimeout(()=>{busy=null; flash('No answer from the big screen. Check it before entering again.'); render();},5000)};
  render();
  try{ await sendRoom(creds.code,creds.key,{cmd:{...c,id,rev:view.rev}}); }
  catch(e){
    if(!busy||busy.id!==id) return;
    clearBusy();
    flash(e.status===409?"The big screen isn't connected.":e.status===404?"That big screen isn't open.":e.message);
    render();
  }
}

/* ---------- Render ---------- */
function statusText(){
  if(link==='waiting') return 'Waiting for the big screen…';
  if(link!=='live') return 'Connecting…';
  return host?'Connected':'Big screen offline';
}

function formHtml(){
  return `<form class="card kp-join">
    <h1>Phone keypad</h1>
    <p class="sub">Enter scores here and they show on a big screen. Scan the code on the big screen with your camera, or type the code it shows.</p>
    <label for="kpCode" class="lbl">Code on the big screen</label>
    <div class="kp-row"><input class="input code-input" id="kpCode" name="code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(form.code)}" placeholder="K7QM" required>
    <button class="btn primary" type="submit" ${form.joining?'disabled':''}>${form.joining?'Joining…':'Join'}</button></div>
    ${form.err?`<p class="err" role="alert">${esc(form.err)}</p>`:''}
    <p class="sub">To show the scoreboard on a computer or TV, open this app there and choose <b>Big screen</b>, then <b>Use this screen as the scoreboard</b>.</p>
    <div class="row"><a class="btn" href="#/">Back to the scorer</a></div>
  </form>`;
}

// The game as the big screen last published it. The state came over the network, so a
// malformed one shows an error instead of breaking the page.
function boardHtml(){
  try{
    const st=view.state;
    if(!validConfig(st.config)||!Array.isArray(st.players)||st.players.length<1||st.players.length>6) throw new Error('bad state');
    const game=new Game({state:st});
    const msg=note?{t:note,kind:'bad'}:view.msg&&typeof view.msg.t==='string'?view.msg:null;
    const sheet=sheetHtml(game,{pending:view.pending,canNew:false});
    return `${host?'':'<p class="warn">The big screen isn\'t connected, so scores can\'t be entered until it\'s back.</p>'}
      <div class="players">${playersHtml(game)}</div>
      <div class="pad" ${busy||!host?'aria-busy="true"':''}>${padHtml(game,{buffer,mult})}
      <div class="msg ${msg?esc(msg.kind):''}" role="status" aria-live="polite">${msg?esc(msg.t):''}</div></div>
      ${sheet?`<div class="overlay kp-sheet" ${busy||!host?'aria-busy="true"':''}>${sheet}</div>`:''}`;
  }catch(e){
    return '<p class="empty err">The big screen sent something this page can\'t show.</p>';
  }
}

function render(){
  if(!active) return;
  if(!creds){root.innerHTML=`<div class="kp">${formHtml()}</div>`; return;}
  const top=`<div class="kp-top"><span class="dot ${host&&link==='live'?'live':''}"></span><span>Big screen <b>${esc(creds.code)}</b> · ${statusText()}</span><span class="spacer"></span><button class="ghost" data-act="leave">Leave</button></div>`;
  let body;
  if(link==='waiting') body=`<div class="card kp-wait"><p>Waiting for big screen <b>${esc(creds.code)}</b>. It may be reloading or asleep, and this page carries on when it's back.</p>
    <div class="row"><button class="btn" data-act="other">Use a different code</button></div></div>`;
  else if(!view) body='<p class="empty">Connecting to the big screen…</p>';
  else if(!view.state) body='<p class="empty">A new game is being set up on the big screen.</p>';
  else body=boardHtml();
  root.innerHTML=`<div class="kp">${top}${body}</div>`;
}

/* ---------- Input ---------- */
const SEND={undo:'undo',endturn:'endturn',pbust:'bust',pcancel:'cancel',nextleg:'nextleg',rematch:'rematch'};
root.addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b||b.disabled) return;
  const ds=b.dataset;
  if(ds.act==='leave'){forget(); location.hash='#/'; return;}
  if(ds.act==='other'){forget(); return;}
  if(!view||!view.state) return;
  if(ds.num!=null){if(buffer.length<3) buffer=(buffer==='0'?'':buffer)+ds.num; render(); return;}
  if(ds.act==='back'){buffer=buffer.slice(0,-1); render(); return;}
  if(ds.m){mult=mult===+ds.m?1:+ds.m; render(); return;}
  if(ds.act==='undo'&&buffer){buffer=''; render(); return;}
  if(ds.act==='enter'){if(buffer){const v=+buffer; buffer=''; send({cmd:'total',v});} return;}
  if(ds.quick!=null) return send({cmd:'total',v:+ds.quick});
  if(ds.seg!=null) return send({cmd:'dart',m:mult,n:+ds.seg});
  if(ds.mode) return send({cmd:'mode',mode:ds.mode});
  if(ds.co) return send({cmd:'checkout',n:+ds.co});
  if(SEND[ds.act]) send({cmd:SEND[ds.act]});
});
root.addEventListener('submit',e=>{
  e.preventDefault();
  const code=String(new FormData(e.target).get('code')||'').trim().toUpperCase();
  if(code&&!form.joining) join(code);
});
root.addEventListener('input',e=>{if(e.target.id==='kpCode') form.code=e.target.value;});

/* ---------- Public ---------- */
// m: the route match, with an optional code and key from the big screen's QR code.
export function setActive(on,m){
  if(!on){
    if(active){active=false; root.hidden=true; root.innerHTML=''; disconnect(); awake.release();}
    return;
  }
  active=true; root.hidden=false;
  if(!creds) creds=loadCreds();
  if(m&&m[1]){
    const code=m[1].toUpperCase();
    if(m[2]) useCreds({code,key:m[2]});
    else if(!creds||creds.code!==code){forget(); join(code);}
    // Keep the key out of the address bar and the history.
    history.replaceState(null,'',location.pathname+location.search+'#/keypad');
  }
  connect(); render(); awake.hold();
}
