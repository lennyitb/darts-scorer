/* Accounts (admins only), plus a way to reach hidden players. */
import {api, session} from '../api.js';
import {esc, fmtDay, openDialog, closeDialog, confirmDialog} from '../ui.js';

let accounts=[], players=[];

export async function render(){
  if(!session.account||!session.account.isAdmin) return `<div class="page"><h1>Admin</h1><p class="empty">Only admins can see this page.</p></div>`;
  [{accounts},{players}]=await Promise.all([api.get('api/accounts'),api.get('api/players')]);
  const me=session.account.id;
  const rows=accounts.map(a=>`<tr>
    <td class="name">${esc(a.username)}${a.id===me?' <span class="pill">you</span>':''}</td>
    <td>${a.isAdmin?'Admin':'Account holder'}</td>
    <td>${a.playerId?`<a href="#/players/${a.playerId}">${esc(a.playerName)}</a>`:'–'}</td>
    <td>${a.disabled?'<span class="pill void">Disabled</span>':a.mustChangePw?'<span class="pill">Temporary password</span>':'Active'}</td>
    <td>${fmtDay(a.createdAt)}</td>
    <td><div class="actions">
      <button class="btn small" data-act="admin" data-id="${a.id}">${a.isAdmin?'Remove admin':'Make admin'}</button>
      <button class="btn small" data-act="reset" data-id="${a.id}">Reset password</button>
      <button class="btn small" data-act="disable" data-id="${a.id}">${a.disabled?'Enable':'Disable'}</button>
    </div></td></tr>`).join('');
  const hidden=players.filter(p=>p.hidden);
  return `<div class="page">
    <div class="head"><h1>Admin</h1><button class="btn primary more" data-act="create">Create account</button></div>
    <div class="card"><h2>Accounts</h2><div class="tablewrap"><table class="data"><thead><tr><th>Username</th><th>Role</th><th>Player</th><th>Status</th><th>Created</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="sub">Account holders can start ranked games and add players. Admins can also manage accounts, void games, and rename or hide players from their pages.</p></div>
    <div class="card"><h2>Hidden players</h2>${hidden.length?`<ul>${hidden.map(p=>`<li><a href="#/players/${p.id}">${esc(p.name)}</a></li>`).join('')}</ul>`:'<p class="sub">None. Hide a player from their page to keep them off the roster and leaderboard.</p>'}</div>
  </div>`;
}

function showPassword(username,password,intro){
  openDialog(`<h2>Password for ${esc(username)}</h2><p>${intro}</p><p class="secret">${esc(password)}</p>
    <p class="sub">This is the only time it's shown. They'll pick their own password when they first sign in.</p>
    <div class="row"><button class="btn primary" data-close>Done</button></div>`);
}

function openCreate(ctx){
  const opts=players.filter(p=>!p.hidden).sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  openDialog(`<h2>Create account</h2><form class="form">
    <label>Username<input class="input" name="username" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32" required autofocus></label>
    <label>Their player<select class="input" name="player"><option value="new">New player named after the username</option><option value="">None</option>${opts}</select></label>
    <label class="check"><input type="checkbox" name="isAdmin"> Admin</label>
    <p class="err" role="alert"></p>
    <div class="row"><button class="btn primary" type="submit">Create</button><button class="btn" type="button" data-close>Cancel</button></div></form>`,{
    onSubmit:async f=>{
      const body={username:f.username.trim(),isAdmin:!!f.isAdmin};
      if(f.player==='new') body.newPlayer=true; else if(f.player) body.playerId=+f.player;
      const r=await api.post('api/accounts',body);
      showPassword(r.account.username,r.password,'Account created. Give them this temporary password:');
      ctx.refresh();
    }});
}

export async function onClick(e,b,ctx){
  if(!b) return;
  const act=b.dataset.act, a=accounts.find(x=>x.id===+b.dataset.id);
  try{
    if(act==='create') return openCreate(ctx);
    if(!a) return;
    if(act==='admin'){
      if(a.isAdmin&&!await confirmDialog(`Remove admin from ${a.username}?`,'They keep their account and can still start ranked games.','Remove admin')) return;
      await api.patch('api/accounts/'+a.id,{isAdmin:!a.isAdmin});
    }
    if(act==='reset'){
      if(!await confirmDialog(`Reset ${a.username}'s password?`,"They'll be signed out everywhere and need the new temporary password to get back in.",'Reset password')) return;
      const r=await api.patch('api/accounts/'+a.id,{resetPassword:true});
      showPassword(a.username,r.password,'Give them this temporary password:');
    }
    if(act==='disable'){
      if(!a.disabled&&!await confirmDialog(`Disable ${a.username}?`,"They'll be signed out and can't sign in until an admin enables them again. Their games stay.",'Disable')) return;
      await api.patch('api/accounts/'+a.id,{disabled:!a.disabled});
    }
    ctx.refresh();
  }catch(x){
    openDialog(`<h2>That didn't work</h2><p>${esc(x.message)}</p><div class="row"><button class="btn" data-close>OK</button></div>`);
  }
}
