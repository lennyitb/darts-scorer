import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IMPOSSIBLE, checkout, minDarts, parseDart} from '../public/js/scoring.js';

const LABELS=['25','Bull'];
for(let n=1;n<=20;n++) LABELS.push(String(n),'D'+n,'T'+n);
const DARTS=LABELS.map(parseDart);

// Fewest darts that total v, with the last dart a double when doubleOut, found by trying every sequence.
function bruteMin(v,doubleOut){
  const ok=seq=>seq.reduce((a,d)=>a+d.s,0)===v&&(!doubleOut||seq.at(-1).dbl);
  for(const a of DARTS){ if(ok([a])) return 1; }
  for(const a of DARTS) for(const b of DARTS){ if(ok([a,b])) return 2; }
  for(const a of DARTS) for(const b of DARTS) for(const c of DARTS){ if(ok([a,b,c])) return 3; }
  return 0;
}

test('minDarts matches brute force for both out rules', ()=>{
  for(const doubleOut of [false,true])
    for(let v=0;v<=185;v++) assert.equal(minDarts(v,doubleOut),bruteMin(v,doubleOut),`v=${v} doubleOut=${doubleOut}`);
});

test('straight-out finishes cover every three-dart score except IMPOSSIBLE', ()=>{
  for(let v=1;v<=180;v++) assert.equal(minDarts(v,false)>0,!IMPOSSIBLE.has(v),`v=${v}`);
  assert.equal(minDarts(181,false),0);
});

test('minDarts fixes the old range guesses', ()=>{
  // Straight out: these were offered as 1- or 2-dart finishes.
  for(const v of [23,29,31,41,43,59]) assert.equal(minDarts(v,false),2,`${v}`);
  for(const v of [118,119]) assert.equal(minDarts(v,false),3,`${v}`);
  // Double out: bull is one dart, T20-Bull is two.
  assert.equal(minDarts(50,true),1);
  assert.equal(minDarts(110,true),2);
  assert.equal(minDarts(170,true),3);
  for(const v of [159,162,163,165,166,168,169]) assert.equal(minDarts(v,true),0,`${v}`);
});

test('checkout routes add up, end on a double, and exist whenever a finish does', ()=>{
  const val=l=>parseDart(l).s;
  for(let v=2;v<=170;v++){
    const md=minDarts(v,true), r=checkout(v,3);
    assert.equal(!!r,md>0,`v=${v}`);
    if(!r) continue;
    assert.equal(r.reduce((a,l)=>a+val(l),0),v,`sum v=${v}`);
    assert.ok(parseDart(r.at(-1)).dbl,`double v=${v}`);
    assert.ok(checkout(v,md)&&checkout(v,md).length<=md,`route within ${md} darts for ${v}`);
  }
  assert.deepEqual(checkout(170,3),['T20','T20','Bull']);
  assert.equal(checkout(170,2),null);
});

test('parseDart', ()=>{
  assert.deepEqual(parseDart('T20'),{l:'T20',s:60,dbl:false});
  assert.deepEqual(parseDart('D16'),{l:'D16',s:32,dbl:true});
  assert.deepEqual(parseDart('7'),{l:'7',s:7,dbl:false});
  assert.deepEqual(parseDart('Bull'),{l:'Bull',s:50,dbl:true});
  assert.deepEqual(parseDart('Miss'),{l:'Miss',s:0,dbl:false});
  for(const bad of ['T21','D0','0','T25','D25','x','',null,20]) assert.equal(parseDart(bad),null,String(bad));
});

test('leg wins fire a small confetti, match wins the full one',async()=>{
  const {Game}=await import('../public/js/game.js');
  const events=[], g=Game.create({start:101,doubleOut:false,doubleIn:false,legsToWin:2,names:['A','B']},{},(...e)=>events.push(e));
  const win=()=>{g.confirmCheckout(g.submitTotal(101),3);};
  win();
  assert.deepEqual(events.filter(e=>e[0]==='confetti'),[['confetti','leg']]);
  g.nextLeg(); g.state.current=0; win();
  assert.equal(g.state.matchWinner,0);
  assert.deepEqual(events.filter(e=>e[0]==='confetti'),[['confetti','leg'],['confetti']]);
});
