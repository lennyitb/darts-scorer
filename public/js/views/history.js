/* Past ranked games: the list, and one game in detail. */
import {api, session} from '../api.js';
import {esc, avg, num, fmtWhen, fmtBadge, outLabel, confirmDialog} from '../ui.js';

const STATUS={in_progress:'<span class="pill live">In progress</span>',abandoned:'<span class="pill">Abandoned</span>',void:'<span class="pill void">Void</span>'};

// One line of a game list. Also used on player pages.
export function gameRow(g){
  const ps=g.players, done=g.status==='finished';
  const nm=p=>done&&p.place===1?`<b>${esc(p.name)}</b>`:esc(p.name);
  const who=ps.length===2?`${nm(ps[0])} ${ps[0].legs}–${ps[1].legs} ${nm(ps[1])}`:ps.map(p=>`${nm(p)} ${p.legs}`).join(' · ');
  return `<li><a href="#/history/${g.id}">${fmtBadge(g)}<span class="who">${who}</span>${STATUS[g.status]||'<span></span>'}
    <span class="when">${fmtWhen(g.finishedAt||g.startedAt)} · ${g.legsToWin>1?`first to ${g.legsToWin}`:'single leg'}</span></a></li>`;
}

let next=null, filter='';
export async function renderList(q){
  filter=q.get('player')||'';
  const [list,{players}]=await Promise.all([api.get('api/games?limit=25'+(filter?'&player='+encodeURIComponent(filter):'')),api.get('api/players')]);
  next=list.next;
  const opts=players.sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`<option value="${p.id}" ${String(p.id)===filter?'selected':''}>${esc(p.name)}</option>`).join('');
  return `<div class="page">
    <div class="head"><h1>History</h1>
      <label class="toolbar"><span class="sub">Player</span><select class="input" data-filter><option value="">Everyone</option>${opts}</select></label></div>
    ${list.games.length?`<ul class="glist" id="games">${list.games.map(gameRow).join('')}</ul>`:`<p class="empty">No ranked games yet. Sign in and switch on Ranked when you set up a game.</p>`}
    ${next?'<button class="btn more" data-act="more">Load more</button>':''}
  </div>`;
}

/* ---------- One game ---------- */
function title(g,players){
  const w=players.find(p=>p.legs>=g.legsToWin), rest=players.filter(p=>p!==w);
  if(!w) return players.map(p=>esc(p.name)).join(' v ');
  if(rest.length===1) return `${esc(w.name)} beat ${esc(rest[0].name)} ${w.legs}–${rest[0].legs}`;
  return `${esc(w.name)} won`;
}

export async function renderGame(id){
  const {game:g,players,legs}=await api.get('api/games/'+id);
  const bySeat=s=>players[s];
  const admin=session.account&&session.account.isAdmin;
  const statsRows=players.map(p=>`<tr><td class="name"><a href="#/players/${p.id}">${esc(p.name)}</a></td><td>${p.legs}</td><td>${avg(p.pts,p.darts)}</td><td>${avg(p.f9pts,p.f9darts)}</td>
    <td>${num(p.best)}</td><td>${p.t100}</td><td>${p.t140}</td><td>${p.t180}</td><td>${num(p.hiOut)}</td><td>${p.darts}</td></tr>`).join('');
  const legRows=legs.map(l=>`<tr><td>${l.leg}</td><td>${esc(bySeat(l.starter).name)}</td><td>${l.winner==null?'–':esc(bySeat(l.winner).name)}</td><td>${num(l.winnerDarts)}</td><td>${num(l.checkout)}</td></tr>`).join('');
  const visitTables=legs.filter(l=>l.visits.length).map(l=>{
    const rounds=Math.max(...l.visits.map(v=>v.round))+1;
    const grid=Array.from({length:rounds},()=>Array(players.length).fill(null));
    l.visits.forEach(v=>{grid[v.round][v.seat]=v;});
    const order=players.map((_,i)=>(l.starter+i)%players.length);
    const cell=v=>{
      if(!v) return '<td></td>';
      const detail=v.d?` title="${esc(v.d.join(' '))}"`:'';
      if(v.bust) return `<td class="bust"${detail}>Bust</td>`;
      if(v.checkout) return `<td class="out"${detail}>${v.points} out</td>`;
      return `<td${detail}>${v.points} <span class="sub">${v.before-v.points}</span></td>`;
    };
    return `<details class="leg"><summary>Leg ${l.leg} visits</summary><div class="tablewrap"><table><thead><tr><th>Darts</th>${order.map(s=>`<th>${esc(bySeat(s).name)}</th>`).join('')}</tr></thead>
      <tbody>${grid.map((row,r)=>`<tr><td>${(r+1)*3}</td>${order.map(s=>cell(row[s])).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  }).join('');
  return `<div class="page">
    <div class="head"><div><h1>${title(g,players)}</h1>
      <p class="sub">${fmtWhen(g.startedAt)} · ${g.start} ${outLabel(g.doubleOut).toLowerCase()}${g.doubleIn?', double in':''} · ${g.legsToWin>1?`first to ${g.legsToWin} legs`:'single leg'} · scored by ${esc(g.createdBy)}</p></div>
      ${STATUS[g.status]||''}</div>
    <div class="card"><h2>Stats</h2><div class="tablewrap"><table class="data"><thead><tr><th>Player</th><th>Legs</th><th>Avg</th><th>First 9</th><th>Best</th><th>100+</th><th>140+</th><th>180</th><th>Top out</th><th>Darts</th></tr></thead>
      <tbody>${statsRows}</tbody></table></div></div>
    ${legs.length?`<div class="card"><h2>Legs</h2><div class="tablewrap"><table><thead><tr><th>Leg</th><th>Threw first</th><th>Won by</th><th>Darts</th><th>Checkout</th></tr></thead><tbody>${legRows}</tbody></table></div>${visitTables}</div>`:''}
    ${admin?`<div class="actions">${g.status==='void'?'<button class="btn small" data-act="unvoid">Restore game</button>':'<button class="btn small danger" data-act="void">Void game</button>'}</div>`:''}
    <p><a href="#/history">All games</a></p>
  </div>`;
}

export async function onClick(e,b,ctx){
  if(!b) return;
  if(b.dataset.act==='more'&&next){
    b.disabled=true;
    const list=await api.get(`api/games?limit=25&before=${encodeURIComponent(next)}`+(filter?'&player='+encodeURIComponent(filter):''));
    next=list.next;
    document.getElementById('games').insertAdjacentHTML('beforeend',list.games.map(gameRow).join(''));
    if(next) b.disabled=false; else b.remove();
  }
  if(b.dataset.act==='void'||b.dataset.act==='unvoid'){
    const id=location.hash.split('/').pop();
    if(b.dataset.act==='void'&&!await confirmDialog('Void this game?','It stays in history marked void, and stops counting toward stats and ratings. You can restore it later.','Void game')) return;
    await api.post(`api/games/${id}/void`,{void:b.dataset.act==='void'});
    ctx.refresh();
  }
}
export function onChange(e){
  if(e.target.dataset.filter==null) return;
  location.hash='#/history'+(e.target.value?'?player='+e.target.value:'');
}
