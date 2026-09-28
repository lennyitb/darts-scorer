/* Elo ratings and the stats behind the leaderboard and player pages.
   Only finished games count. Scoring stats pool every rule variant; finishing stats
   (checkouts, top out, best legs) are only ever reported per out-rule. */
import {HttpError} from './http.js';
import {listGames, sweepIdle} from './games.js';

export const ELO={start:1500,k:32};

/* Rebuilds every rating from scratch in finishing order. Each pair of players in a game is a
   match decided by legs won (equal legs is a draw), scaled by 1/(players-1) so bigger games
   don't swing ratings harder, with all changes computed from pre-game ratings.
   Callers run this inside their own transaction. */
export function recomputeRatings(db){
  const games=db.prepare(`SELECT id FROM games WHERE status='finished' ORDER BY finished_at,id`).all();
  const seatsOf=db.prepare('SELECT player_id,legs_won FROM game_players WHERE game_id=? ORDER BY seat');
  const ins=db.prepare('INSERT INTO ratings(game_id,player_id,before,after) VALUES (?,?,?,?)');
  const rating=new Map(), get=id=>rating.get(id)??ELO.start;
  db.exec('DELETE FROM ratings');
  for(const {id} of games){
    const seats=seatsOf.all(id), n=seats.length;
    const before=seats.map(s=>get(s.player_id)), delta=seats.map(()=>0), k=ELO.k/(n-1);
    for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
      const expect=1/(1+10**((before[j]-before[i])/400));
      const score=seats[i].legs_won>seats[j].legs_won?1:seats[i].legs_won<seats[j].legs_won?0:0.5;
      delta[i]+=k*(score-expect); delta[j]-=k*(score-expect);
    }
    seats.forEach((s,i)=>{rating.set(s.player_id,before[i]+delta[i]); ins.run(id,s.player_id,before[i],before[i]+delta[i]);});
  }
  db.prepare('UPDATE players SET rating=?').run(ELO.start);
  const up=db.prepare('UPDATE players SET rating=? WHERE id=?');
  for(const [id,r] of rating) up.run(r,id);
}

// Per-player totals over finished games, optionally only one out-rule (0 straight, 1 double).
function aggregates(db,doubleOut=null,playerId=null){
  const f=(doubleOut==null?'':` AND g.double_out=${doubleOut?1:0}`)+(playerId==null?'':' AND x.player_id=?');
  const args=playerId==null?[]:[playerId];
  const out=new Map();
  for(const r of db.prepare(`SELECT x.player_id AS id,count(*) AS games,sum(x.place=1) AS wins,sum(x.legs_won) AS legsWon,
      sum((SELECT count(*) FROM legs l WHERE l.game_id=g.id AND l.winner_seat IS NOT NULL)) AS legsPlayed
    FROM game_players x JOIN games g ON g.id=x.game_id WHERE g.status='finished'${f} GROUP BY x.player_id`).all(...args))
    out.set(r.id,{...r});
  for(const r of db.prepare(`SELECT x.player_id AS id,sum(x.points) AS pts,sum(x.darts) AS darts,max(x.points) AS best,
      sum(x.points>=100 AND x.points<140) AS t100,sum(x.points>=140 AND x.points<180) AS t140,sum(x.points=180) AS t180,
      sum(x.checkout) AS checkouts,sum(x.finishable) AS chances,max(CASE WHEN x.checkout=1 THEN x.points END) AS hiOut,
      sum(CASE WHEN x.round<3 AND g.double_in=0 THEN x.points ELSE 0 END) AS f9pts,
      sum(CASE WHEN x.round<3 AND g.double_in=0 THEN x.darts ELSE 0 END) AS f9darts
    FROM visits x JOIN games g ON g.id=x.game_id WHERE g.status='finished'${f} GROUP BY x.player_id`).all(...args))
    Object.assign(out.get(r.id)||{},r);
  return out;
}

const OUTS={straight:0,double:1};
export function leaderboard(db,out){
  sweepIdle(db);
  const agg=aggregates(db,out in OUTS?OUTS[out]:null);
  const players=db.prepare('SELECT id,name,rating FROM players WHERE hidden=0').all()
    .filter(p=>agg.has(p.id)).map(p=>({...agg.get(p.id),id:p.id,name:p.name,rating:p.rating}));
  return {players};
}

export function playerStats(db,id){
  sweepIdle(db);
  const p=db.prepare('SELECT id,name,hidden,rating FROM players WHERE id=?').get(id);
  if(!p) throw new HttpError(404,'No such player');
  const ranked=db.prepare(`SELECT p.id FROM players p WHERE p.hidden=0 AND EXISTS (SELECT 1 FROM game_players gp JOIN games g ON g.id=gp.game_id
    WHERE gp.player_id=p.id AND g.status='finished') ORDER BY p.rating DESC,p.id`).all().map(r=>r.id);
  const scoring=aggregates(db,null,id).get(id)||{games:0};
  const form=db.prepare(`SELECT sum(points) AS pts,sum(darts) AS darts FROM visits WHERE player_id=? AND game_id IN
    (SELECT g.id FROM games g JOIN game_players gp ON gp.game_id=g.id WHERE gp.player_id=? AND g.status='finished' ORDER BY g.finished_at DESC LIMIT 10)`).get(id,id);
  const finishing=db.prepare(`SELECT g.double_out AS doubleOut,sum(v.checkout) AS checkouts,sum(v.finishable) AS chances,
      max(CASE WHEN v.checkout=1 THEN v.points END) AS hiOut
    FROM visits v JOIN games g ON g.id=v.game_id WHERE v.player_id=? AND g.status='finished' GROUP BY g.double_out ORDER BY g.double_out`).all(id)
    .map(r=>({...r,doubleOut:!!r.doubleOut}));
  // SQLite takes the bare columns from the row that holds the min().
  const bestLegs=db.prepare(`SELECT g.start,g.double_out AS doubleOut,min(l.winner_darts) AS darts,g.id AS gameId,g.finished_at AS at
    FROM legs l JOIN games g ON g.id=l.game_id JOIN game_players gp ON gp.game_id=l.game_id AND gp.seat=l.winner_seat
    WHERE gp.player_id=? AND g.status='finished' GROUP BY g.start,g.double_out ORDER BY g.start,g.double_out`).all(id)
    .map(r=>({...r,doubleOut:!!r.doubleOut}));
  const ratings=db.prepare(`SELECT r.game_id AS gameId,g.finished_at AS at,r.before,r.after FROM ratings r JOIN games g ON g.id=r.game_id
    WHERE r.player_id=? ORDER BY g.finished_at,g.id`).all(id).map(r=>({...r}));
  const h2h=db.prepare(`SELECT o.player_id AS id,p.name,count(*) AS games,sum(me.legs_won>o.legs_won) AS ahead,
      sum(me.legs_won=o.legs_won) AS level,sum(me.legs_won<o.legs_won) AS behind
    FROM game_players me JOIN game_players o ON o.game_id=me.game_id AND o.player_id<>me.player_id
    JOIN games g ON g.id=me.game_id JOIN players p ON p.id=o.player_id
    WHERE me.player_id=? AND g.status='finished' GROUP BY o.player_id ORDER BY games DESC,p.name`).all(id).map(r=>({...r}));
  const rank=ranked.indexOf(p.id);
  return {
    player:{id:p.id,name:p.name,hidden:!!p.hidden,rating:p.rating,rank:rank<0?null:rank+1,ranked:ranked.length},
    scoring:{...scoring,formPts:form.pts||0,formDarts:form.darts||0},
    finishing,bestLegs,ratings,h2h,
    recent:listGames(db,{player:id,limit:10}).games,
  };
}
