/* The leaderboard and one player's career. */
import {api, session} from '../api.js';
import {esc, avg, pct, num, fmtDay, outLabel, openDialog, closeDialog, confirmDialog} from '../ui.js';
import {sparkline} from '../chart.js';
import {gameRow} from './history.js';

const OUTS=[['all','All rules'],['straight','Straight out'],['double','Double out']];
// [key, header, value, finishing-only]
const COLS=[
  ['rating','Rating',r=>Math.round(r.rating)],
  ['games','Games',r=>r.games],
  ['wins','Won',r=>r.wins],
  ['winPct','Win %',r=>pct(r.wins,r.games)],
  ['legsWon','Legs',r=>`${r.legsWon}/${r.legsPlayed}`],
  ['avg','Avg',r=>avg(r.pts,r.darts)],
  ['first9','First 9',r=>avg(r.f9pts,r.f9darts)],
  ['best','Best',r=>num(r.best)],
  ['t180','180',r=>r.t180],
  ['t140','140+',r=>r.t140],
  ['t100','100+',r=>r.t100],
  ['hiOut','Top out',r=>num(r.hiOut),true],
  ['outPct','Out %',r=>pct(r.checkouts,r.chances),true],
];
const SORT={
  rating:r=>r.rating, games:r=>r.games, wins:r=>r.wins, winPct:r=>r.games?r.wins/r.games:-1, legsWon:r=>r.legsWon,
  avg:r=>r.darts?r.pts/r.darts:-1, first9:r=>r.f9darts?r.f9pts/r.f9darts:-1, best:r=>r.best||0,
  t180:r=>r.t180, t140:r=>r.t140, t100:r=>r.t100, hiOut:r=>r.hiOut||0, outPct:r=>r.chances?r.checkouts/r.chances:-1,
  name:r=>r.name.toLowerCase(),
};

export async function renderBoard(q){
  const out=OUTS.some(o=>o[0]===q.get('out'))?q.get('out'):'all';
  const sort=SORT[q.get('sort')]?q.get('sort'):'rating', asc=q.get('dir')==='asc';
  const {players}=await api.get('api/stats/leaderboard'+(out==='all'?'':'?out='+out));
  const cols=COLS.filter(c=>!c[3]||out!=='all');
  const key=SORT[sort];
  const rows=[...players].sort((a,b)=>{const x=key(a),y=key(b); return (x<y?-1:x>y?1:0)*(asc?1:-1)||b.rating-a.rating;});
  const byRating=[...players].sort((a,b)=>b.rating-a.rating).map(p=>p.id);
  const link=(k,dir)=>`#/players?${new URLSearchParams({...(out==='all'?{}:{out}),sort:k,dir})}`;
  const th=(k,label)=>{
    const on=k===sort, dir=on?(asc?'desc':'asc'):(k==='name'?'asc':'desc');
    return `<th class="${k==='name'?'name':''}" ${on?`aria-sort="${asc?'ascending':'descending'}"`:''}><button data-href="${link(k,dir)}">${label}</button></th>`;
  };
  const me=session.account&&session.account.playerId;
  return `<div class="page">
    <div class="head"><h1>Players</h1>
      <div class="chips">${OUTS.map(([k,l])=>`<a href="#/players${k==='all'?'':'?out='+k}" aria-current="${k===out}">${l}</a>`).join('')}</div></div>
    ${rows.length?`<div class="card"><div class="tablewrap"><table class="data"><thead><tr><th class="rank">#</th>${th('name','Player')}${cols.map(c=>th(c[0],c[1])).join('')}</tr></thead>
      <tbody>${rows.map(r=>`<tr class="${r.id===me?'me':''}"><td class="rank">${byRating.indexOf(r.id)+1}</td><td class="name"><a href="#/players/${r.id}">${esc(r.name)}</a></td>${cols.map(c=>`<td>${c[2](r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>
      <p class="sub">Ratings are Elo from every finished ranked game, whatever the rules. ${out==='all'?'Pick straight or double out to see checkout stats, which are never mixed across the two.':`Other columns only count ${outLabel(out==='double').toLowerCase()} games.`} Out % is checkouts per visit that started on a finishable score.</p>`
      :'<p class="empty">No finished ranked games yet.</p>'}
  </div>`;
}

export async function renderPlayer(id){
  const s=await api.get(`api/players/${id}/stats`);
  const p=s.player, c=s.scoring, admin=session.account&&session.account.isAdmin;
  const tile=(v,l)=>`<div><b>${v}</b><span>${l}</span></div>`;
  const ratings=[1500,...s.ratings.map(r=>r.after)];
  return `<div class="page">
    <div class="head"><div><h1>${esc(p.name)}</h1>
      <p class="sub">${c.games?`Rating ${Math.round(p.rating)}${p.rank?` · #${p.rank} of ${p.ranked}`:''}`:'No finished ranked games yet'}${p.hidden?' · hidden from the roster':''}</p></div>
      ${admin?`<div class="actions"><button class="btn small" data-act="rename">Rename</button><button class="btn small" data-act="hide">${p.hidden?'Show on roster':'Hide from roster'}</button></div>`:''}</div>
    ${c.games?`<div class="kv">
      ${tile(c.games,'Games')}${tile(c.wins,'Won')}${tile(pct(c.wins,c.games),'Win rate')}${tile(`${c.legsWon}/${c.legsPlayed}`,'Legs won')}
      ${tile(avg(c.pts,c.darts),'3-dart avg')}${tile(avg(c.f9pts,c.f9darts),'First 9 avg')}${tile(avg(c.formPts,c.formDarts),'Last 10 games avg')}
      ${tile(num(c.best),'Best visit')}${tile(c.t180,'180s')}${tile(c.t140,'140+')}${tile(c.t100,'100+')}
    </div>
    <div class="cols">
      <div class="card"><h2>Rating</h2>${sparkline(ratings)||'<p class="sub">Shows up after a second game.</p>'}
        <p class="sub">Started at 1500. Lowest ${Math.round(Math.min(...ratings))}, highest ${Math.round(Math.max(...ratings))}.</p></div>
      <div class="card"><h2>Finishing</h2><div class="tablewrap"><table><thead><tr><th>Rules</th><th>Checkouts</th><th>Out %</th><th>Top out</th></tr></thead><tbody>
        ${s.finishing.map(f=>`<tr><td>${outLabel(f.doubleOut)}</td><td>${f.checkouts}</td><td>${pct(f.checkouts,f.chances)}</td><td>${num(f.hiOut)}</td></tr>`).join('')}</tbody></table></div>
        ${s.bestLegs.length?`<h2>Best legs</h2><div class="tablewrap"><table><thead><tr><th>Game</th><th>Darts</th><th>When</th></tr></thead><tbody>
          ${s.bestLegs.map(b=>`<tr><td>${b.start} ${outLabel(b.doubleOut).toLowerCase()}</td><td>${b.darts}</td><td><a href="#/history/${b.gameId}">${fmtDay(b.at)}</a></td></tr>`).join('')}</tbody></table></div>`:''}</div>
    </div>
    ${s.h2h.length?`<div class="card"><h2>Head to head</h2><div class="tablewrap"><table class="data"><thead><tr><th>Opponent</th><th>Games</th><th>Ahead</th><th>Level</th><th>Behind</th></tr></thead><tbody>
      ${s.h2h.map(h=>`<tr><td class="name"><a href="#/players/${h.id}">${esc(h.name)}</a></td><td>${h.games}</td><td>${h.ahead}</td><td>${h.level}</td><td>${h.behind}</td></tr>`).join('')}</tbody></table></div>
      <p class="sub">Ahead means finishing with more legs than them in a game you both played.</p></div>`:''}`:''}
    ${s.recent.length?`<div><h2>Recent games</h2><ul class="glist">${s.recent.map(gameRow).join('')}</ul>
      <p><a href="#/history?player=${p.id}">All of ${esc(p.name)}'s games</a></p></div>`:''}
  </div>`;
}

export async function onClick(e,b,ctx){
  if(!b) return;
  if(b.dataset.href){location.hash=b.dataset.href; return;}
  const id=+location.hash.split('/').pop();
  if(b.dataset.act==='rename'){
    const name=document.querySelector('#view h1').textContent;
    openDialog(`<h2>Rename player</h2><form class="form"><label>Name<input class="input" name="name" maxlength="20" required value="${esc(name)}" autofocus></label>
      <p class="err" role="alert"></p><div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>`,
      {onSubmit:async({name})=>{await api.patch(`api/players/${id}`,{name}); closeDialog(); ctx.refresh();}});
  }
  if(b.dataset.act==='hide'){
    const hide=b.textContent.startsWith('Hide');
    if(hide&&!await confirmDialog('Hide from the roster?',"Their games and stats stay, but they won't be offered when setting up a game or shown on the leaderboard.",'Hide',false)) return;
    await api.patch(`api/players/${id}`,{hidden:hide}); ctx.refresh();
  }
}
