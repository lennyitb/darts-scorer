/* Sign in, password changes, and the signed-in account's own settings. */
import {openDialog, closeDialog, esc} from '../ui.js';
import {api, session, signIn, signOut, changePassword, refreshSession} from '../api.js';

export function openSignIn(){
  openDialog(`<h2>Sign in</h2>
    <form class="form">
      <label>Username<input class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
      <label>Password<input class="input" name="password" type="password" autocomplete="current-password" required></label>
      <p class="err" role="alert"></p>
      <div class="row"><button class="btn primary" type="submit">Sign in</button><button class="btn" type="button" data-close>Cancel</button></div>
    </form>
    <p class="sub">An admin creates accounts. Anyone can browse history and stats without one.</p>`,{
    onSubmit:async({username,password})=>{
      const a=await signIn(username,password);
      if(a.mustChangePw) openChangePassword(true); else closeDialog();
    }});
}

export function openChangePassword(forced=false){
  openDialog(`<h2>${forced?'Choose a new password':'Change password'}</h2>
    ${forced?'<p>You signed in with a temporary password. Pick your own to carry on.</p>':''}
    <form class="form">
      <input name="username" autocomplete="username" value="${esc(session.account.username)}" hidden>
      <label>${forced?'Temporary password':'Current password'}<input class="input" name="current" type="password" autocomplete="current-password" required autofocus></label>
      <label>New password<input class="input" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <label>Repeat new password<input class="input" name="repeat" type="password" autocomplete="new-password" minlength="8" required></label>
      <p class="err" role="alert"></p>
      <div class="row"><button class="btn primary" type="submit">Save password</button>${forced?'<button class="btn" type="button" data-act="signout">Sign out</button>':'<button class="btn" type="button" data-close>Cancel</button>'}</div>
    </form>`,{
    dismissable:!forced,
    onSubmit:async({current,password,repeat})=>{
      if(password!==repeat) throw new Error("The new passwords don't match.");
      await changePassword(current,password); closeDialog();
    },
    onClick:async(e,b)=>{if(b&&b.dataset.act==='signout'){await signOut(); closeDialog();}},
  });
}

export async function openAccount(){
  const a=session.account;
  const body=players=>`<h2>${esc(a.username)}</h2><p>${a.isAdmin?'Admin':'Account holder'}</p>
    <form class="form">
      <label>Your player
        <select class="input" name="playerId">${players?`<option value="">None</option>${players.filter(p=>!p.hidden||p.id===a.playerId)
          .sort((x,y)=>x.name.localeCompare(y.name)).map(p=>`<option value="${p.id}" ${p.id===a.playerId?'selected':''}>${esc(p.name)}</option>`).join('')}`:'<option>Loading…</option>'}</select></label>
      <p class="sub">Puts you in seat 1 when you set up a ranked game.</p>
      <p class="err" role="alert"></p>
    </form>
    <div class="row"><button class="btn" data-act="pw">Change password</button>${a.isAdmin?'<button class="btn" data-act="admin">Admin</button>':''}</div>
    <div class="row"><button class="btn danger" data-act="signout">Sign out</button><button class="btn" data-close>Close</button></div>`;
  const opts={
    onClick:async(e,b)=>{
      if(!b) return;
      if(b.dataset.act==='pw') openChangePassword();
      else if(b.dataset.act==='admin'){closeDialog(); location.hash='#/admin';}
      else if(b.dataset.act==='signout'){await signOut(); closeDialog();}
    },
    onChange:async e=>{
      if(e.target.name!=='playerId') return;
      const err=document.querySelector('#dialog .err');
      try{ await api.patch('api/account',{playerId:+e.target.value||null}); await refreshSession(); err.textContent=''; }
      catch(x){ err.textContent=x.message; }
    },
  };
  openDialog(body(null),opts);
  try{ const {players}=await api.get('api/players'); if(session.account===a) openDialog(body(players),opts); }catch(e){}
}
