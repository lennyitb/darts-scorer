/* Boot, hash routing and the nav bar. #/ is the scorer and #/keypad the phone keypad; the rest render into #view. */
import * as scorer from './scorer.js';
import * as keypad from './keypad.js';
import * as history from './views/history.js';
import * as players from './views/players.js';
import * as admin from './views/admin.js';
import {openSignIn, openAccount, openChangePassword} from './views/account.js';
import {session, loadSession, onSession, flush} from './api.js';
import {esc, dialogOpen, openDialog, closeDialog} from './ui.js';

const view=document.getElementById('view'), acctBtn=document.getElementById('acctBtn'), screenBtn=document.getElementById('screenBtn');
// The big screen's QR code opens #/keypad/CODE/KEY; a typed link may carry just the code.
const KEYPAD=/^keypad(?:\/([A-Za-z0-9]{4})(?:\/([\w-]{16}))?)?$/;
const ROUTES=[
  [/^$/,null,null],
  [/^history$/,history,(m,q)=>history.renderList(q)],
  [/^history\/([0-9a-f]{32})$/,history,m=>history.renderGame(m[1])],
  [/^players$/,players,(m,q)=>players.renderBoard(q)],
  [/^players\/(\d+)$/,players,m=>players.renderPlayer(+m[1])],
  [/^admin$/,admin,()=>admin.render()],
];
let current=null, token=0;

async function route({keep=false}={}){
  const [path,qs]=location.hash.replace(/^#\/?/,'').split('?');
  const km=KEYPAD.exec(path);
  document.body.classList.toggle('keypad-mode',!!km);
  if(km){
    scorer.setActive(false); view.hidden=true; current=null; token++;
    document.querySelectorAll('[data-nav]').forEach(a=>a.removeAttribute('aria-current'));
    document.title='Keypad · Darts'; keypad.setActive(true,km); return;
  }
  keypad.setActive(false);
  const r=ROUTES.find(([re])=>re.test(path));
  if(!r){location.replace('#/'); return;}
  const [re,mod,render]=r, section=path.split('/')[0]||'play';
  document.querySelectorAll('[data-nav]').forEach(a=>{if(a.dataset.nav===section) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');});
  scorer.setActive(!mod);
  view.hidden=!mod; current=mod;
  if(!mod){document.title='Darts scorer'; return;}
  const t=++token;
  if(!keep) view.innerHTML='<p class="empty">Loading…</p>';
  let html;
  try{ html=await render(path.match(re),new URLSearchParams(qs||'')); }
  catch(e){ html=`<div class="page"><p class="empty err">${esc(e.status===404?'Not found.':e.message)}</p></div>`; }
  if(t!==token) return;
  view.innerHTML=html;
  const h1=view.querySelector('h1'); document.title=h1?`${h1.textContent} · Darts`:'Darts scorer';
  if(!keep) window.scrollTo(0,0);
}
const ctx={refresh:()=>route({keep:true})};

view.addEventListener('click',e=>{
  if(!current||!current.onClick) return;
  const b=e.target.closest('button'); if(b&&b.disabled) return;
  Promise.resolve(current.onClick(e,b,ctx)).catch(x=>openDialog(`<h2>That didn't work</h2><p>${esc(x.message)}</p><div class="row"><button class="btn" data-close>OK</button></div>`));
});
view.addEventListener('change',e=>{if(current&&current.onChange) current.onChange(e,ctx);});
acctBtn.addEventListener('click',()=>session.account?openAccount():openSignIn());
screenBtn.addEventListener('click',()=>openDialog(`<h2>Big screen</h2>
  <p>Show the scoreboard large on a computer or TV, and enter scores from phones.</p>
  <div class="choice"><button class="btn primary" data-act="big">Use this screen as the scoreboard</button>
    <p class="sub">Runs the game here and shows a code for phones to join.</p></div>
  <div class="choice"><button class="btn" data-act="keypad">Use this device as a keypad</button>
    <p class="sub">Enter scores for a big screen that's already showing a code.</p></div>
  <div class="row"><button class="btn" data-close>Cancel</button></div>`,{onClick:(e,b)=>{
    if(!b) return;
    if(b.dataset.act==='big'){closeDialog(); location.hash='#/'; scorer.enterBig();}
    else if(b.dataset.act==='keypad'){closeDialog(); location.hash='#/keypad';}
  }}));
window.addEventListener('hashchange',()=>route());

onSession(s=>{
  acctBtn.hidden=!s.available;
  screenBtn.hidden=!s.available;
  acctBtn.textContent=s.account?s.account.username:'Sign in';
  if(s.account&&s.account.mustChangePw&&!dialogOpen()) openChangePassword(true);
  if(current) route({keep:true});
});

scorer.init();
route();
loadSession().then(()=>flush());
