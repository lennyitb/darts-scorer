/* The scorer's game state and every move that changes it, without any DOM, so
   tests can drive it. `emit(type, ...)` reports 'say' messages and 'confetti' ('leg' for a smaller one between legs). */
import {IMPOSSIBLE, minDarts, evalDarts, parseDart, applyVisit, newStats} from './scoring.js';

const clone=o=>JSON.parse(JSON.stringify(o));

export class Game {
  // state: everything undo can roll back. history: undo snapshots of state.
  // done: visit logs of finished legs, kept out of the snapshots so they stay small.
  constructor({state,history=[],done=[]},emit=()=>{}){
    this.state=state; this.history=history; this.done=done; this.emit=emit;
    if(!state.visits) state.visits=[];
  }
  static create(cfg,{starter=0,mode='total',ranked=null}={},emit){
    const state={config:clone(cfg),mode,current:starter,legStarter:starter,leg:1,turn:[],visits:[],legWinner:null,matchWinner:null,lastCheckout:null,ranked,
      players:cfg.names.map(n=>({name:n,remaining:cfg.start,opened:!cfg.doubleIn,legs:0,last:null,st:newStats()}))};
    return new Game({state},emit);
  }
  toJSON(){return {state:this.state,history:this.history.slice(-60),done:this.done};}
  get cur(){return this.state.players[this.state.current];}
  get over(){return this.state.legWinner!=null||this.state.matchWinner!=null;}
  log(){return [...this.done,this.state.visits];}
  snap(){this.history.push(JSON.stringify(this.state)); if(this.history.length>300) this.history.shift();}

  commit(c,entry){
    const state=this.state, p=this.cur;
    applyVisit(p,c);
    state.visits.push(entry);
    if(c.bust) this.emit('say',p.name+' bust','bad');
    else if(c.pts===180) this.emit('say','One hundred and eighty!','good');
    state.turn=[];
    if(c.checkout){
      state.lastCheckout={player:state.current,pts:c.pts,darts:c.darts};
      if(p.legs>=state.config.legsToWin){state.matchWinner=state.current; this.emit('confetti');} else {state.legWinner=state.current; this.emit('confetti','leg');}
      return;
    }
    state.current=(state.current+1)%state.players.length;
  }

  // Loser of the match: fewest legs won; ties go to whoever was furthest from finishing.
  loserIndex(){
    const s=this.state; let li=0;
    s.players.forEach((p,i)=>{const l=s.players[li];
      if(i===s.matchWinner) return;
      if(li===s.matchWinner||p.legs<l.legs||(p.legs===l.legs&&p.remaining>l.remaining)) li=i;});
    return li;
  }

  nextLeg(){
    const s=this.state;
    this.done.push(s.visits); s.visits=[];
    s.players.forEach(p=>{p.remaining=s.config.start;p.opened=!s.config.doubleIn;p.last=null;});
    s.legStarter=(s.legStarter+1)%s.players.length;
    s.current=s.legStarter; s.leg++; s.legWinner=null; s.turn=[];
    this.history=[];
  }

  undo(){
    if(!this.history.length) return false;
    this.state=JSON.parse(this.history.pop()); return true;
  }

  // Returns a pending checkout ({v,min,opened}) that needs a dart count, or null.
  submitTotal(v){
    if(this.over||!Number.isInteger(v)) return null;
    if(v>180||IMPOSSIBLE.has(v)){this.emit('say',v+" isn't possible with three darts",'bad');return null;}
    const p=this.cur, cfg=this.state.config;
    const opened=p.opened||v>0, nr=p.remaining-v;
    if(nr<0||(cfg.doubleOut&&nr===1)){this.snap();this.commit({pts:0,darts:3,bust:true},{b:1});return null;}
    if(nr===0){
      const md=minDarts(v,cfg.doubleOut);
      if(!md){this.snap();this.commit({pts:0,darts:3,bust:true},{b:1});this.emit('say',v+" can't be checked out, so that's a bust",'bad');return null;}
      return {v,min:md,opened};
    }
    this.snap();this.commit({pts:v,darts:3,opened},{p:v});return null;
  }
  confirmCheckout({v,opened},n){this.snap();this.commit({pts:v,darts:n,checkout:true,opened},{p:v,n});}
  pendingBust(){this.snap();this.commit({pts:0,darts:3,bust:true},{b:1});}

  addDart(m,n){
    if(this.over) return;
    const d=parseDart(n===0?'Miss':n===25?'25':n===50?'Bull':(m===3?'T':m===2?'D':'')+n);
    const s=this.state; this.snap(); s.turn.push(d);
    const r=evalDarts(s.config,this.cur.remaining,this.cur.opened,s.turn), entry={d:s.turn.map(x=>x.l)};
    if(r.bust) this.commit({pts:0,darts:r.n,bust:true},entry);
    else if(r.checkout) this.commit({pts:r.pts,darts:r.n,checkout:true,opened:true},entry);
    else if(s.turn.length===3) this.commit({pts:r.pts,darts:3,opened:r.opened},entry);
  }
  endTurnEarly(){
    const s=this.state; if(!s.turn.length) return;
    this.snap(); const r=evalDarts(s.config,this.cur.remaining,this.cur.opened,s.turn);
    this.commit({pts:r.pts,darts:3,opened:r.opened},{d:s.turn.map(x=>x.l)});
  }
  // Darts so far this turn, scored: for the live remaining and turn total.
  turnEval(){const s=this.state; return s.turn.length?evalDarts(s.config,this.cur.remaining,this.cur.opened,s.turn):null;}
}
