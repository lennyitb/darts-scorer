import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/index.js';
import {hashing, hashPassword} from '../server/auth.js';

hashing.N=2**10; // fast hashes for tests

let app, base;
before(async()=>{
  app=createApp({dbFile:':memory:'});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  base=`http://127.0.0.1:${app.server.address().port}`;
  app.db.prepare('INSERT INTO accounts(username,username_key,pw_hash,is_admin,created_at) VALUES (?,?,?,1,?)')
    .run('boss','boss',await hashPassword('boss-password'),Date.now());
});
after(()=>app.close());

// A cookie-keeping client. Mutations send JSON, as the browser does.
class Client {
  constructor(){this.cookie='';}
  async req(method,path,body,headers={}){
    const h={...headers}; if(this.cookie) h.cookie=this.cookie;
    let payload;
    if(method!=='GET'&&method!=='HEAD'){ if(!('content-type' in h)) h['content-type']='application/json'; payload=JSON.stringify(body??{}); }
    const res=await fetch(base+path,{method,headers:h,body:payload});
    const sc=res.headers.get('set-cookie'); if(sc) this.cookie=sc.split(';')[0].endsWith('=')?'':sc.split(';')[0];
    const text=await res.text(); let json=null; try{json=JSON.parse(text);}catch(e){}
    return {status:res.status,body:json,text,headers:res.headers};
  }
  get(p,h){return this.req('GET',p,undefined,h);}
  post(p,b,h){return this.req('POST',p,b,h);}
  put(p,b,h){return this.req('PUT',p,b,h);}
  patch(p,b,h){return this.req('PATCH',p,b,h);}
  del(p,h){return this.req('DELETE',p,undefined,h);}
  async signIn(username,password){const r=await this.post('/api/session',{username,password}); assert.equal(r.status,200,JSON.stringify(r.body)); return r.body.account;}
}
const admin=new Client();
const gid=n=>n.toString(16).padStart(32,'0');
const SO={start:301,doubleIn:false,doubleOut:false,legsToWin:1};
const DO={...SO,doubleOut:true};
// Seat 0 wins a single leg: 180, then 121 out in three.
const quickWin=[[{p:180},{p:0},{p:121,n:3}]];

// Makes an account holder (password already changed) and returns a signed-in client.
async function holder(username){
  const r=await admin.post('/api/accounts',{username});
  assert.equal(r.status,201);
  const c=new Client(); await c.signIn(username,r.body.password);
  assert.equal((await c.post('/api/account/password',{current:r.body.password,password:username+'-password'})).status,200);
  return c;
}
async function player(c,name){
  const r=await c.post('/api/players',{name});
  return r.status===201?r.body.player.id:r.body.player.id;
}

test('sign in, session cookie, sign out', async()=>{
  const c=new Client();
  assert.equal((await c.post('/api/session',{username:'boss',password:'nope'})).status,401);
  assert.equal((await c.post('/api/session',{username:'nobody',password:'nope'})).status,401);
  const r=await c.post('/api/session',{username:'BOSS',password:'boss-password'});
  assert.equal(r.status,200);
  const cookie=r.headers.get('set-cookie');
  assert.match(cookie,/^darts_session=[\w-]{40,}; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  assert.equal((await c.get('/api/session')).body.account.username,'boss');
  assert.equal((await c.del('/api/session')).status,200);
  assert.equal((await c.get('/api/session')).body.account,null);
  const s=await new Client().post('/api/session',{username:'boss',password:'boss-password'},{'x-forwarded-proto':'https','content-type':'application/json'});
  assert.match(s.headers.get('set-cookie'),/; Secure$/);
  await admin.signIn('boss','boss-password');
});

test('failed sign-ins are rate limited per username', async()=>{
  await admin.post('/api/accounts',{username:'target'});
  const c=new Client();
  for(let i=0;i<5;i++) assert.equal((await c.post('/api/session',{username:'target',password:'wrong'})).status,401);
  assert.equal((await c.post('/api/session',{username:'target',password:'wrong'})).status,429);
  assert.equal((await c.post('/api/session',{username:'boss',password:'wrong'})).status,401, 'other usernames unaffected');
});

test('mutations need JSON and a same-origin request', async()=>{
  assert.equal((await admin.post('/api/players',{name:'X'},{'content-type':'text/plain'})).status,415);
  assert.equal((await admin.post('/api/players',{name:'X'},{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await admin.post('/api/players',{name:'X'},{origin:'https://evil.example'})).status,403);
  assert.equal((await admin.post('/api/players',{name:'Csrf ok'},{'sec-fetch-site':'same-origin'})).status,201);
  const host=new URL(base).host;
  assert.equal((await admin.post('/api/players',{name:'Origin ok'},{origin:'http://'+host})).status,201);
});

test('temporary passwords must be changed before doing anything else', async()=>{
  const r=await admin.post('/api/accounts',{username:'newbie',newPlayer:true});
  assert.equal(r.status,201);
  assert.equal(r.body.account.playerName,'newbie');
  assert.match(r.body.password,/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  const c=new Client(); const a=await c.signIn('newbie',r.body.password);
  assert.equal(a.mustChangePw,true);
  assert.equal((await c.post('/api/players',{name:'Nope'})).status,403);
  assert.equal((await c.post('/api/account/password',{current:'wrong',password:'something-long'})).status,400);
  assert.equal((await c.post('/api/account/password',{current:r.body.password,password:'short'})).status,400);
  const ok=await c.post('/api/account/password',{current:r.body.password,password:'newbie-password'});
  assert.equal(ok.status,200); assert.equal(ok.body.account.mustChangePw,false);
  assert.equal((await c.post('/api/players',{name:'Now fine'})).status,201);
});

test('permission matrix', async()=>{
  const anon=new Client(), acct=await holder('holder1');
  const pid=await player(admin,'Matrix');
  for(const [c,who] of [[anon,'anon'],[acct,'holder'],[admin,'admin']]){
    const want=(a,h,ad)=>({anon:a,holder:h,admin:ad})[who];
    assert.equal((await c.get('/api/players')).status,200);
    assert.equal((await c.get('/api/games')).status,200);
    assert.equal((await c.get('/api/stats/leaderboard')).status,200);
    assert.equal((await c.get(`/api/players/${pid}/stats`)).status,200);
    assert.equal((await c.post('/api/players',{name:'M '+who})).status,want(401,201,201),who+' add player');
    assert.equal((await c.patch(`/api/players/${pid}`,{hidden:false})).status,want(401,403,200),who+' edit player');
    assert.equal((await c.get('/api/accounts')).status,want(401,403,200),who+' list accounts');
    assert.equal((await c.post('/api/accounts',{username:'x'+who})).status,want(401,403,201),who+' create account');
    assert.equal((await c.put('/api/games/'+gid(900+want(1,2,3)),{rev:1,config:SO,playerIds:[pid,pid+1],starter:0,log:[]})).status,want(401,200,200),who+' save game');
    assert.equal((await c.post(`/api/games/${gid(902)}/void`,{void:true})).status,want(401,403,200),who+' void');
  }
});

test('admins: last-admin guard, disabling and password resets end sessions', async()=>{
  const me=(await admin.get('/api/session')).body.account;
  const others=(await admin.get('/api/accounts')).body.accounts.filter(a=>a.isAdmin&&a.id!==me.id);
  for(const o of others) await admin.patch('/api/accounts/'+o.id,{isAdmin:false});
  assert.equal((await admin.patch('/api/accounts/'+me.id,{isAdmin:false})).status,409);
  assert.equal((await admin.patch('/api/accounts/'+me.id,{disabled:true})).status,400);
  assert.equal((await admin.patch('/api/accounts/'+me.id,{resetPassword:true})).status,400);

  const c=await holder('victim');
  const id=(await c.get('/api/session')).body.account.id;
  assert.equal((await admin.patch('/api/accounts/'+id,{disabled:true})).status,200);
  assert.equal((await c.get('/api/session')).body.account,null);
  assert.equal((await c.post('/api/session',{username:'victim',password:'victim-password'})).status,401);
  await admin.patch('/api/accounts/'+id,{disabled:false});
  await c.signIn('victim','victim-password');
  const r=await admin.patch('/api/accounts/'+id,{resetPassword:true});
  assert.ok(r.body.password);
  assert.equal((await c.get('/api/session')).body.account,null,'reset signs them out');
  assert.equal((await c.signIn('victim',r.body.password)).mustChangePw,true);

  // A second admin can be appointed, after which the first can step down.
  assert.equal((await admin.patch('/api/accounts/'+id,{isAdmin:true})).status,200);
  const second=new Client(); await second.signIn('victim',r.body.password);
  await second.post('/api/account/password',{current:r.body.password,password:'victim-password2'});
  assert.equal((await second.patch('/api/accounts/'+me.id,{isAdmin:false})).status,200);
  assert.equal((await admin.get('/api/accounts')).status,403);
  assert.equal((await second.patch('/api/accounts/'+me.id,{isAdmin:true})).status,200);
});

test('players: names are unique ignoring case and spacing', async()=>{
  const r=await admin.post('/api/players',{name:'  Dave   Smith '});
  assert.equal(r.status,201); assert.equal(r.body.player.name,'Dave Smith');
  const dup=await admin.post('/api/players',{name:'dave smith'});
  assert.equal(dup.status,409); assert.equal(dup.body.player.id,r.body.player.id);
  assert.equal((await admin.post('/api/players',{name:''})).status,400);
  assert.equal((await admin.post('/api/players',{name:'x'.repeat(21)})).status,400);
  assert.equal((await admin.patch(`/api/players/${r.body.player.id}`,{name:'Csrf ok'})).status,409);
  assert.equal((await admin.patch(`/api/players/${r.body.player.id}`,{name:'Davey'})).body.player.name,'Davey');
});

test('saving games: upsert, stale revs, undo, abandon, ownership', async()=>{
  const c=await holder('scorer1'), other=await holder('scorer2');
  const a=await player(c,'Ann'), b=await player(c,'Ben');
  const id=gid(1), body=(rev,log,extra)=>({rev,config:SO,playerIds:[a,b],starter:0,log,...extra});

  assert.equal((await c.put('/api/games/'+id,body(1,[[]]))).body.status,'in_progress');
  assert.equal((await c.put('/api/games/'+id,body(3,quickWin))).body.status,'finished');
  const stale=await c.put('/api/games/'+id,body(2,[[{p:180}]]));
  assert.equal(stale.body.stale,true); assert.equal(stale.body.status,'finished');
  // Undoing the checkout is just a shorter log.
  assert.equal((await c.put('/api/games/'+id,body(4,[[{p:180},{p:0}]]))).body.status,'in_progress');
  assert.equal((await c.put('/api/games/'+id,body(5,quickWin))).body.status,'finished');

  const g=(await c.get('/api/games/'+id)).body;
  assert.equal(g.game.status,'finished');
  assert.deepEqual(g.players.map(p=>[p.name,p.legs,p.place,p.pts,p.darts,p.hiOut]),[['Ann',1,1,301,6,121],['Ben',0,2,0,3,null]]);
  assert.deepEqual(g.legs.map(l=>[l.leg,l.starter,l.winner,l.winnerDarts,l.checkout,l.visits.length]),[[1,0,0,6,121,3]]);

  assert.equal((await other.put('/api/games/'+id,body(9,quickWin))).status,403,'only the creator');
  assert.equal((await admin.put('/api/games/'+id,body(9,quickWin))).status,200,'or an admin');
  assert.equal((await c.put('/api/games/'+id,{...body(10,quickWin),playerIds:[b,a]})).status,409,'players are fixed');
  assert.equal((await c.put('/api/games/'+id,{...body(10,quickWin),config:DO})).status,409,'rules are fixed');
  assert.equal((await c.put('/api/games/'+gid(2),body(1,[[{p:181}]]))).status,422);
  assert.equal((await c.put('/api/games/'+gid(2),{...body(1,[]),playerIds:[a,999999]})).status,422);
  assert.equal((await c.put('/api/games/'+gid(2),{...body(1,[]),playerIds:[a,a]})).status,400);
  assert.equal((await c.put('/api/games/'+gid(2),{...body(1,[]),log:undefined})).status,400);
  assert.equal((await c.put('/api/games/NOTHEX','{}')).status,404);

  const ab=gid(3);
  await c.put('/api/games/'+ab,body(1,[[{p:60}]]));
  assert.equal((await c.put('/api/games/'+ab,body(2,[[{p:60}]],{abandon:true}))).body.status,'abandoned');
  const list=(await c.get('/api/games?player='+a)).body.games.map(x=>x.id);
  assert.ok(list.includes(id)&&!list.includes(ab),'abandoned games are left out of history');
});

test('history pages with a cursor', async()=>{
  const c=await holder('pager');
  const a=await player(c,'Pag A'), b=await player(c,'Pag B');
  for(let i=0;i<5;i++) await c.put('/api/games/'+gid(100+i),{rev:1,config:SO,playerIds:[a,b],starter:0,log:quickWin});
  const seen=[]; let next=null;
  do{ const r=(await c.get(`/api/games?player=${a}&limit=2`+(next?'&before='+next:''))).body; seen.push(...r.games.map(g=>g.id)); next=r.next; }while(next);
  assert.equal(seen.length,5); assert.equal(new Set(seen).size,5);
});

test('Elo, voiding, and the out-rule split in stats', async()=>{
  const c=await holder('elo');
  const [A,B,C,D]=[await player(c,'Elo A'),await player(c,'Elo B'),await player(c,'Elo C'),await player(c,'Elo D')];
  const rating=async id=>Math.round((await c.get(`/api/players/${id}/stats`)).body.player.rating*100)/100;

  // Two players, straight out: the winner takes K/2 from the loser.
  await c.put('/api/games/'+gid(200),{rev:1,config:SO,playerIds:[A,B],starter:0,log:quickWin});
  assert.equal(await rating(A),1516); assert.equal(await rating(B),1484);

  // Voiding puts everyone back; restoring brings it back.
  await admin.post(`/api/games/${gid(200)}/void`,{void:true});
  assert.equal(await rating(A),1500);
  assert.equal((await c.get('/api/stats/leaderboard')).body.players.some(p=>p.id===A),false);
  await admin.post(`/api/games/${gid(200)}/void`,{void:false});
  assert.equal(await rating(A),1516);
  await admin.post(`/api/games/${gid(200)}/void`,{void:true});

  // Four players, first to 2, double out. A wins 2 legs, B and C one each (a draw between them), D none.
  const win=[{p:180},{p:0},{p:0},{p:0},{p:121,n:3}];
  const log=[win,win,win,[{p:0},{p:180},{p:0},{p:0},{p:0},{p:121,n:3}]];
  const r=await c.put('/api/games/'+gid(201),{rev:1,config:{...DO,legsToWin:2},playerIds:[A,B,C,D],starter:0,log});
  assert.equal(r.body.status,'finished');
  assert.deepEqual([await rating(A),await rating(B),await rating(C),await rating(D)],[1516,1500,1500,1484]);

  // A straight-out game for A, so the out-rule split has something to separate.
  await c.put('/api/games/'+gid(202),{rev:1,config:SO,playerIds:[A,D],starter:0,log:[[{p:180},{p:0},{p:100},{p:0},{p:21,n:1}]]});
  const board=async out=>(await c.get('/api/stats/leaderboard'+(out?'?out='+out:''))).body.players.find(p=>p.id===A);
  const all=await board(), dbl=await board('double'), str=await board('straight');
  assert.equal(all.games,2); assert.equal(dbl.games,1); assert.equal(str.games,1);
  assert.equal(dbl.hiOut,121); assert.equal(str.hiOut,21);
  assert.equal(dbl.checkouts,2); assert.equal(str.checkouts,1);
  assert.equal(str.chances,2,'straight out: from 121 and from 21');
  assert.equal(all.pts,dbl.pts+str.pts);
  const s=(await c.get(`/api/players/${A}/stats`)).body;
  assert.deepEqual(s.finishing.map(f=>[f.doubleOut,f.checkouts,f.hiOut]),[[false,1,21],[true,2,121]]);
  assert.deepEqual(s.bestLegs.map(b=>[b.start,b.doubleOut,b.darts]),[[301,false,7],[301,true,6]]);
  assert.deepEqual(s.h2h.map(h=>[h.name,h.games,h.ahead,h.level,h.behind]),[['Elo D',2,2,0,0],['Elo B',1,1,0,0],['Elo C',1,1,0,0]]);
  assert.equal(s.ratings.length,2);
  assert.ok(s.player.rank>=1&&s.player.rank<=s.player.ranked);
});

test('static files and headers', async()=>{
  const c=new Client();
  const r=await c.get('/');
  assert.equal(r.status,200);
  assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  assert.equal(r.headers.get('cache-control'),'no-cache');
  const etag=r.headers.get('etag');
  assert.equal((await c.get('/',{'if-none-match':etag})).status,304);
  assert.equal((await c.get('/js/scoring.js')).headers.get('content-type'),'text/javascript; charset=utf-8');
  for(const p of ['/../server/index.js','/%2e%2e/package.json','/nope.html','/js/']) assert.equal((await c.get(p)).status,404,p);
  assert.equal((await c.get('/healthz')).text,'ok\n');
  assert.equal((await c.get('/api/nope')).status,404);
  assert.equal((await c.req('DELETE','/api/players')).status,405);
  assert.equal((await c.get('/api/games')).headers.get('cache-control'),'no-store');
});
