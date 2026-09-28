/* Ranked games: saving (replayed and validated with the scorer's own rules), listing and detail.
   games.log is the source of truth; legs, visits and game_players are rebuilt from it on every write. */
import {replayGame, validConfig, ReplayError, RULES_VERSION} from '../public/js/scoring.js';
import {tx} from './db.js';
import {HttpError} from './http.js';
import {recomputeRatings} from './stats.js';

export const GAME_ID=/^[0-9a-f]{32}$/;
const IDLE=24*3600e3;

// In-progress games nobody has touched for a day count as abandoned.
export function sweepIdle(db){
  db.prepare(`UPDATE games SET status='abandoned' WHERE status='in_progress' AND updated_at<?`).run(Date.now()-IDLE);
}

function replay(config,playerIds,starter,log){
  try{ return replayGame({config,players:playerIds.length,starter,log}); }
  catch(e){ if(e instanceof ReplayError) throw new HttpError(422,'Invalid game log: '+e.message); throw e; }
}
const configOf=g=>({start:g.start,doubleIn:!!g.double_in,doubleOut:!!g.double_out,legsToWin:g.legs_to_win});

export function putGame(db,account,id,body){
  if(!GAME_ID.test(id)) throw new HttpError(400,'Bad game id');
  const {rev,config,playerIds,starter,log,abandon}=body||{};
  if(!Number.isSafeInteger(rev)||rev<1) throw new HttpError(400,'rev must be a positive integer');
  if(!validConfig(config)) throw new HttpError(400,'Bad game rules');
  if(!Array.isArray(playerIds)||playerIds.length<2||playerIds.length>6||!playerIds.every(Number.isSafeInteger)||new Set(playerIds).size!==playerIds.length)
    throw new HttpError(400,'A ranked game needs 2 to 6 different players');
  if(!Number.isInteger(starter)||starter<0||starter>=playerIds.length) throw new HttpError(400,'Bad starting player');
  if(!Array.isArray(log)) throw new HttpError(400,'log must be an array of legs');
  if(JSON.stringify(log).length>200000) throw new HttpError(413,'Game log too large');
  const r=replay(config,playerIds,starter,log);

  return tx(db,()=>{
    const g=db.prepare('SELECT * FROM games WHERE id=?').get(id), now=Date.now();
    if(g){
      if(g.created_by!==account.id&&!account.is_admin) throw new HttpError(403,'Only the account that started this game can update it');
      if(g.status==='void') throw new HttpError(409,'This game has been voided');
      const seats=db.prepare('SELECT player_id FROM game_players WHERE game_id=? ORDER BY seat').all(id).map(x=>x.player_id);
      if(JSON.stringify(configOf(g))!==JSON.stringify(configOf({start:config.start,double_in:config.doubleIn,double_out:config.doubleOut,legs_to_win:config.legsToWin}))
        ||g.starter_seat!==starter||seats.join()!==playerIds.join())
        throw new HttpError(409,"A game's players and rules can't change once it has started");
      if(rev<=g.rev) return {id,status:g.status,rev:g.rev,stale:true};
    }else{
      const found=db.prepare(`SELECT count(*) AS n FROM players WHERE id IN (${playerIds.map(()=>'?').join()})`).get(...playerIds).n;
      if(found!==playerIds.length) throw new HttpError(422,'Unknown player');
      db.prepare(`INSERT INTO games(id,created_by,start,double_in,double_out,legs_to_win,starter_seat,status,rev,log,rules_version,started_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'in_progress',0,'[]',?,?,?)`).run(id,account.id,config.start,+config.doubleIn,+config.doubleOut,config.legsToWin,starter,RULES_VERSION,now,now);
      const ins=db.prepare('INSERT INTO game_players(game_id,seat,player_id) VALUES (?,?,?)');
      playerIds.forEach((p,i)=>ins.run(id,i,p));
    }
    const status=abandon===true&&r.status!=='finished'?'abandoned':r.status;
    const wasFinished=!!g&&g.status==='finished';
    db.prepare('UPDATE games SET status=?,rev=?,log=?,rules_version=?,updated_at=?,finished_at=?,winner_player_id=? WHERE id=?')
      .run(status,rev,JSON.stringify(log),RULES_VERSION,now,status==='finished'?(wasFinished?g.finished_at:now):null,r.winner==null?null:playerIds[r.winner],id);
    writeDerived(db,id,playerIds,r);
    if(wasFinished||status==='finished') recomputeRatings(db);
    return {id,status,rev};
  });
}

export function writeDerived(db,id,playerIds,r){
  db.prepare('DELETE FROM visits WHERE game_id=?').run(id);
  db.prepare('DELETE FROM legs WHERE game_id=?').run(id);
  const iv=db.prepare(`INSERT INTO visits(game_id,leg,idx,seat,player_id,round,before,points,darts,bust,checkout,finishable,detail)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const il=db.prepare('INSERT INTO legs(game_id,leg,starter_seat,winner_seat,winner_darts,checkout) VALUES (?,?,?,?,?,?)');
  for(const l of r.legs){
    if(!l.visits.length) continue;
    l.visits.forEach((v,i)=>iv.run(id,l.leg,i,v.seat,playerIds[v.seat],v.round,v.before,v.points,v.darts,+v.bust,+v.checkout,+v.finishable,v.d?JSON.stringify(v.d):null));
    const won=l.winner!=null;
    il.run(id,l.leg,l.starter,l.winner,won?l.visits.filter(v=>v.seat===l.winner).reduce((a,v)=>a+v.darts,0):null,won?l.visits.at(-1).points:null);
  }
  const up=db.prepare('UPDATE game_players SET legs_won=?,place=? WHERE game_id=? AND seat=?');
  r.players.forEach((p,i)=>up.run(p.legs,r.places[i],id,i));
}

// Re-derives every game from its log, e.g. after a scoring fix. Games whose logs no longer replay are reported, not changed.
export function rebuildAll(db){
  const bad=[];
  tx(db,()=>{
    for(const g of db.prepare('SELECT * FROM games').all()){
      const ids=db.prepare('SELECT player_id FROM game_players WHERE game_id=? ORDER BY seat').all(g.id).map(x=>x.player_id);
      try{ writeDerived(db,g.id,ids,replayGame({config:configOf(g),players:ids.length,starter:g.starter_seat,log:JSON.parse(g.log)})); }
      catch(e){ if(e instanceof ReplayError) bad.push({id:g.id,error:e.message}); else throw e; }
    }
    recomputeRatings(db);
  });
  return bad;
}

export function setVoid(db,id,v){
  return tx(db,()=>{
    const g=db.prepare('SELECT * FROM games WHERE id=?').get(id);
    if(!g) throw new HttpError(404,'No such game');
    let status=g.status;
    if(v&&g.status!=='void') status='void';
    if(!v&&g.status==='void'){
      const ids=db.prepare('SELECT player_id FROM game_players WHERE game_id=? ORDER BY seat').all(id).map(x=>x.player_id);
      status=replayGame({config:configOf(g),players:ids.length,starter:g.starter_seat,log:JSON.parse(g.log)}).status;
    }
    if(status===g.status) return {id,status};
    db.prepare('UPDATE games SET status=?,finished_at=? WHERE id=?').run(status,status==='finished'?(g.finished_at??g.updated_at):g.finished_at,id);
    if(g.status==='finished'||status==='finished') recomputeRatings(db);
    return {id,status};
  });
}

/* ---------- Reading ---------- */
const summary=(g,seats)=>({id:g.id,start:g.start,doubleIn:!!g.double_in,doubleOut:!!g.double_out,legsToWin:g.legs_to_win,
  status:g.status,startedAt:g.started_at,updatedAt:g.updated_at,finishedAt:g.finished_at,createdBy:g.username,
  players:seats.map(s=>({id:s.player_id,name:s.name,legs:s.legs_won,place:s.place}))});

function seatsFor(db,ids){
  const out=new Map(ids.map(id=>[id,[]]));
  if(!ids.length) return out;
  const rows=db.prepare(`SELECT gp.game_id,gp.seat,gp.player_id,gp.legs_won,gp.place,p.name FROM game_players gp JOIN players p ON p.id=gp.player_id
    WHERE gp.game_id IN (${ids.map(()=>'?').join()}) ORDER BY gp.game_id,gp.seat`).all(...ids);
  for(const r of rows) out.get(r.game_id).push(r);
  return out;
}

// Newest first. Abandoned games are left out; void ones stay, marked.
export function listGames(db,{player=null,before=null,limit=25}={}){
  sweepIdle(db);
  const where=[`g.status IN ('in_progress','finished','void')`], args=[];
  if(player!=null){ where.push('EXISTS (SELECT 1 FROM game_players gp WHERE gp.game_id=g.id AND gp.player_id=?)'); args.push(player); }
  if(before){
    const m=/^(\d+)_([0-9a-f]{32})$/.exec(before); if(!m) throw new HttpError(400,'Bad cursor');
    where.push('(g.started_at<? OR (g.started_at=? AND g.id<?))'); args.push(+m[1],+m[1],m[2]);
  }
  const rows=db.prepare(`SELECT g.*,a.username FROM games g JOIN accounts a ON a.id=g.created_by WHERE ${where.join(' AND ')}
    ORDER BY g.started_at DESC,g.id DESC LIMIT ?`).all(...args,limit+1);
  const more=rows.length>limit; if(more) rows.pop();
  const seats=seatsFor(db,rows.map(g=>g.id));
  return {games:rows.map(g=>summary(g,seats.get(g.id))),next:more?`${rows.at(-1).started_at}_${rows.at(-1).id}`:null};
}

export function getGame(db,id){
  sweepIdle(db);
  const g=db.prepare('SELECT g.*,a.username FROM games g JOIN accounts a ON a.id=g.created_by WHERE g.id=?').get(id);
  if(!g) throw new HttpError(404,'No such game');
  const seats=seatsFor(db,[id]).get(id);
  const agg=new Map(db.prepare(`SELECT seat,sum(points) AS pts,sum(darts) AS darts,max(points) AS best,
      sum(points>=100 AND points<140) AS t100,sum(points>=140 AND points<180) AS t140,sum(points=180) AS t180,
      max(CASE WHEN checkout=1 THEN points END) AS hiOut,
      sum(CASE WHEN round<3 THEN points ELSE 0 END) AS f9pts,sum(CASE WHEN round<3 THEN darts ELSE 0 END) AS f9darts
    FROM visits WHERE game_id=? GROUP BY seat`).all(id).map(r=>[r.seat,r]));
  const visits=db.prepare('SELECT leg,seat,round,before,points,darts,bust,checkout,detail FROM visits WHERE game_id=? ORDER BY leg,idx').all(id);
  const legs=db.prepare('SELECT * FROM legs WHERE game_id=? ORDER BY leg').all(id).map(l=>({leg:l.leg,starter:l.starter_seat,winner:l.winner_seat,
    winnerDarts:l.winner_darts,checkout:l.checkout,
    visits:visits.filter(v=>v.leg===l.leg).map(v=>({seat:v.seat,round:v.round,before:v.before,points:v.points,darts:v.darts,
      bust:!!v.bust,checkout:!!v.checkout,d:v.detail?JSON.parse(v.detail):null}))}));
  const zero={pts:0,darts:0,best:0,t100:0,t140:0,t180:0,hiOut:null,f9pts:0,f9darts:0};
  const players=seats.map(s=>{const a={...zero,...agg.get(s.seat)}; delete a.seat;
    return {seat:s.seat,id:s.player_id,name:s.name,legs:s.legs_won,place:s.place,...a};});
  return {game:summary(g,seats),players,legs};
}
