import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../public/js/game.js';
import {replayGame, ReplayError, minDarts} from '../public/js/scoring.js';

// Small seeded PRNG so failures reproduce.
function rng(seed){return ()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const pick=(r,a)=>a[Math.floor(r()*a.length)];

function assertParity(g,n,starter,msg){
  const {config}=g.state;
  const r=replayGame({config,players:n,starter,log:g.log()});
  g.state.players.forEach((p,i)=>{
    const q=r.players[i];
    assert.deepEqual(q.st,p.st,`${msg}: stats seat ${i}`);
    assert.equal(q.legs,p.legs,`${msg}: legs seat ${i}`);
    assert.equal(q.remaining,p.remaining,`${msg}: remaining seat ${i}`);
    assert.equal(q.opened,p.opened,`${msg}: opened seat ${i}`);
  });
  assert.equal(r.winner,g.state.matchWinner,`${msg}: match winner`);
  assert.equal(r.status,g.state.matchWinner==null?'in_progress':'finished');
  if(g.state.legWinner!=null) assert.equal(r.legs.at(-1).winner,g.state.legWinner,`${msg}: leg winner`);
  return r;
}

// Plays a random game through the live scorer, mixing both entry modes, busts,
// early turn ends and undos, checking the replayed log against live state after every move.
function playRandom(seed,cfg,n,starter){
  const r=rng(seed), names=Array.from({length:n},(_,i)=>'P'+i);
  const g=Game.create({...cfg,names},{starter});
  let moves=0;
  for(;moves<3000&&g.state.matchWinner==null;moves++){
    const s=g.state, tag=`seed ${seed} move ${moves}`;
    if(s.legWinner!=null){ if(r()<0.15) g.undo(); else g.nextLeg(); assertParity(g,n,starter,tag); continue; }
    if(r()<0.05&&g.history.length){ g.undo(); assertParity(g,n,starter,tag); continue; }
    if(!s.turn.length&&r()<0.25) s.mode=s.mode==='total'?'darts':'total';
    if(s.mode==='total'){
      const rem=g.cur.remaining, x=r();
      const v=x<0.3&&rem<=180?rem : x<0.4&&rem<=190?rem+pick(r,[1,5,-1]) : Math.floor(r()*186);
      const pend=g.submitTotal(v);
      if(pend){ if(cfg.doubleOut&&r()<0.25) g.pendingBust(); else g.confirmCheckout(pend,pend.min+Math.floor(r()*(4-pend.min))); }
    }else{
      if(s.turn.length&&r()<0.1){ g.endTurnEarly(); assertParity(g,n,starter,tag); continue; }
      const ev=g.turnEval(), rem=ev&&!ev.bust?ev.rem:g.cur.remaining;
      if(r()<0.35&&rem>0&&rem<=40&&rem%2===0) g.addDart(2,rem/2);
      else if(r()<0.35&&rem>0&&rem<=20) g.addDart(1,rem);
      else if(r()<0.05) g.addDart(1,pick(r,[25,50]));
      else g.addDart(pick(r,[1,1,2,3]),Math.floor(r()*21));
    }
    assertParity(g,n,starter,tag);
  }
  return {g,moves};
}

test('replaying the log reproduces live scorer state (all rule combos, both entry modes)', ()=>{
  let finished=0, seed=1;
  for(const doubleIn of [false,true]) for(const doubleOut of [false,true]) for(const n of [1,2,3,4]) for(const legsToWin of [1,2,3]){
    for(let k=0;k<3;k++){
      const start=pick(rng(seed),[301,501,701]);
      const {g}=playRandom(seed++,{start,doubleIn,doubleOut,legsToWin},n,(seed)%n);
      if(g.state.matchWinner!=null) finished++;
    }
  }
  assert.ok(finished>100,`only ${finished} random games finished`);
});

test('undoing a match-winning checkout reopens the match', ()=>{
  const g=Game.create({start:301,doubleIn:false,doubleOut:false,legsToWin:1,names:['A','B']});
  g.submitTotal(180); g.submitTotal(100); g.addDart(3,20); g.addDart(3,20); g.addDart(1,1);
  assert.equal(g.state.matchWinner,0);
  assert.equal(replayGame({config:g.state.config,players:2,starter:0,log:g.log()}).status,'finished');
  g.undo();
  const r=replayGame({config:g.state.config,players:2,starter:0,log:g.log()});
  assert.equal(r.status,'in_progress');
  assert.equal(r.players[0].remaining,121);  // the undone dart was the third of an uncommitted turn
  assert.deepEqual(g.state.turn.map(d=>d.l),['T20','T20']);
});

test('replay derives visits, rounds and finishable flags', ()=>{
  const config={start:301,doubleIn:false,doubleOut:true,legsToWin:2};
  const log=[
    // Leg 1, seat 0 throws first: 301 -> 121 -> 40 -> out on D20.
    [{p:180},{p:60},{p:81},{p:100},{p:40,n:1}],
    // Leg 2, seat 1 throws first. Seat 0 busts on 1 with two darts, seat 1 busts from 101, then seat 0 takes out 121.
    [{p:100},{d:['T20','T20','T20']},{p:100},{d:['T20','T20']},{b:1},{d:['T20','T19','D2']}],
  ];
  const r=replayGame({config,players:2,starter:0,log});
  assert.equal(r.status,'finished');
  assert.equal(r.winner,0);
  assert.deepEqual(r.places,[1,2]);
  assert.deepEqual(r.legs.map(l=>[l.starter,l.winner]),[[0,0],[1,0]]);
  const row=x=>[x.seat,x.round,x.before,x.points,x.darts,x.bust,x.checkout,x.finishable];
  assert.deepEqual(r.legs[0].visits.map(row),[
    [0,0,301,180,3,false,false,false],
    [1,0,301,60,3,false,false,false],
    [0,1,121,81,3,false,false,true],
    [1,1,241,100,3,false,false,false],
    [0,2,40,40,1,false,true,true],
  ]);
  assert.deepEqual(r.legs[1].visits.map(row).slice(3),[
    [0,1,121,0,2,true,false,true],
    [1,2,101,0,3,true,false,true],
    [0,2,121,121,3,false,true,true],
  ]);
  assert.deepEqual(r.players[0].st,{pts:602,darts:15,hi:180,t100:1,t140:0,t180:2,hiOut:121});
  assert.deepEqual(r.players[1].st,{pts:360,darts:15,hi:100,t100:3,t140:0,t180:0,hiOut:0});
});

test('replay rejects logs the scorer could not produce', ()=>{
  const DO={start:501,doubleIn:false,doubleOut:true,legsToWin:1}, SO={...DO,doubleOut:false};
  const pre=[{p:180},{p:0},{p:180},{p:0}]; // seat 0 on 141
  const bad=(config,log,re)=>assert.throws(()=>replayGame({config,players:2,starter:0,log}),re);
  bad(DO,[[{p:181}]],/possible/);
  bad(DO,[[{p:179}]],/possible/);
  bad(DO,[[...pre,{p:141}]],/bust or checkout/);             // reaching 0 must be a checkout entry
  bad(DO,[[...pre,{p:141,n:1}]],/can't be checked out/);     // 141 needs 3 darts
  bad(SO,[[...pre,{p:141,n:2}]],/can't be checked out/);     // straight out still needs 3 for 141
  bad(DO,[[{b:1}]],/not possible/);                           // can't bust from 501
  bad(DO,[[{d:['T20','T20','T20','T20']}]],/1 to 3 darts/);
  bad(DO,[[{d:['T21']}]],/unknown dart/);
  bad(DO,[[...pre,{p:101},{p:0},{d:['D20','5']}]],/after the visit ended/);  // seat 0: 141 -> 40 -> out on D20
  bad(DO,[[...pre,{p:101},{p:0},{d:['D20']},{p:0}]],/after the checkout/);
  bad(DO,[[...pre,{p:101},{p:0},{d:['D20']}],[]],/after the match/);
  bad({...DO,legsToWin:2},[[{p:60}],[{p:60}]],/never finished/);
  bad(DO,[[{p:60,x:1}]],/shape/);
  bad(DO,{},/array/);
  assert.equal(replayGame({config:SO,players:2,starter:0,log:[[...pre,{p:101},{p:0},{p:40,n:1}]]}).status,'finished');
  assert.equal(minDarts(141,false),3);
});
