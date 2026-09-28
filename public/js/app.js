/* Boot, hash routing and the nav bar. #/ is the scorer; the rest render into #view. */
import * as scorer from './scorer.js';
import * as history from './views/history.js';
import * as players from './views/players.js';
import * as admin from './views/admin.js';
import {openSignIn, openAccount, openChangePassword} from './views/account.js';
import {session, loadSession, onSession, flush} from './api.js';
import {esc, dialogOpen, openDialog} from './ui.js';

const view=document.getElementById('view'), acctBtn=document.getElementById('acctBtn');
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
window.addEventListener('hashchange',()=>route());

onSession(s=>{
  acctBtn.hidden=!s.available;
  acctBtn.textContent=s.account?s.account.username:'Sign in';
  if(s.account&&s.account.mustChangePw&&!dialogOpen()) openChangePassword(true);
  if(current) route({keep:true});
});

scorer.init();
route();
loadSession().then(()=>flush());
