/* Small helpers shared by the scorer and the other views. */
import {esc} from './board.js';
export {esc};
export const avg=(pts,darts)=>darts?(pts/darts*3).toFixed(1):'–';
export const pct=(a,b)=>b?Math.round(a/b*100)+'%':'–';
export const num=v=>v==null||v===0?'–':v;
export const fmtWhen=ms=>new Date(ms).toLocaleString(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
export const fmtDay=ms=>new Date(ms).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
export const outLabel=doubleOut=>doubleOut?'Double out':'Straight out';
// "DO", "SO", "DI·DO" for the format badge.
export const rulesShort=g=>(g.doubleIn?'DI·':'')+(g.doubleOut?'DO':'SO');
export const fmtBadge=g=>`<span class="fmt">${g.start}<small>${rulesShort(g)}</small></span>`;

/* ---------- Dialog sheet (sign in, account, admin forms) ---------- */
const dlg=document.getElementById('dialog');
let handlers=null;
export function openDialog(html,{onClick,onSubmit,onChange,dismissable=true}={}){
  dlg.innerHTML=`<div class="sheet" role="dialog" aria-modal="true">${html}</div>`; dlg.hidden=false;
  handlers={onClick,onSubmit,onChange,dismissable};
  const f=dlg.querySelector('[autofocus]')||dlg.querySelector('input,select,button'); if(f) f.focus();
}
export function closeDialog(){dlg.hidden=true; dlg.innerHTML=''; handlers=null;}
export const dialogOpen=()=>!dlg.hidden;
dlg.addEventListener('click',e=>{
  if(!handlers) return;
  if(e.target===dlg&&handlers.dismissable){closeDialog();return;}
  const b=e.target.closest('button');
  if(b&&b.dataset.close!=null){closeDialog();return;}
  if(handlers.onClick) handlers.onClick(e,b);
});
dlg.addEventListener('submit',async e=>{
  e.preventDefault(); if(!handlers||!handlers.onSubmit) return;
  const form=e.target, btn=form.querySelector('button[type=submit],button:not([type])');
  const err=form.querySelector('.err'); if(err) err.textContent='';
  if(btn) btn.disabled=true;
  try{ await handlers.onSubmit(Object.fromEntries(new FormData(form)),form); }
  catch(x){ if(err) err.textContent=x.message||String(x); else throw x; }
  finally{ if(btn&&btn.isConnected) btn.disabled=false; }
});
dlg.addEventListener('change',e=>{if(handlers&&handlers.onChange) handlers.onChange(e);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&handlers&&handlers.dismissable) closeDialog();});

// Resolves true if the person confirms.
export function confirmDialog(title,text,ok='Confirm',danger=true){
  return new Promise(resolve=>{
    openDialog(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row"><button class="btn ${danger?'danger':'primary'}" data-ok>${esc(ok)}</button><button class="btn" data-close>Cancel</button></div>`,
      {onClick:(e,b)=>{if(b&&b.dataset.ok!=null){closeDialog();resolve(true);}}});
    const obs=new MutationObserver(()=>{if(dlg.hidden){obs.disconnect();resolve(false);}});
    obs.observe(dlg,{attributes:true,attributeFilter:['hidden']});
  });
}
