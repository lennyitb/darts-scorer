/* The whole backend: static files from public/, the JSON API under /api, and /healthz.
   Zero dependencies: node:http, node:sqlite and node:crypto. */
import http from 'node:http';
import {readFileSync, readdirSync, statSync, mkdirSync} from 'node:fs';
import {join, extname, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {openDb, tx, nameKey} from './db.js';
import {HttpError, readJson} from './http.js';
import * as auth from './auth.js';
import {putGame, setVoid, listGames, getGame} from './games.js';
import {leaderboard, playerStats} from './stats.js';

const HERE=dirname(fileURLToPath(import.meta.url));
export const PUBLIC=join(HERE,'..','public');

const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
const CSP=["default-src 'self'","script-src 'self'","style-src 'self' https://fonts.googleapis.com","font-src https://fonts.gstatic.com",
  "img-src 'self' data:","connect-src 'self'","form-action 'self'","frame-ancestors 'none'","base-uri 'none'","object-src 'none'"].join('; ');
const BASE_HEADERS={'Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'};

// Everything under public/ is read once at startup, so no request path ever touches the filesystem.
function loadStatic(dir){
  const files=new Map();
  (function walk(d,prefix){
    for(const name of readdirSync(d)){
      if(name.startsWith('.')) continue;
      const p=join(d,name);
      if(statSync(p).isDirectory()){walk(p,prefix+name+'/'); continue;}
      const type=TYPES[extname(name)]; if(!type) continue;
      const body=readFileSync(p);
      files.set('/'+prefix+name,{body,type,etag:`"${createHash('sha1').update(body).digest('base64url').slice(0,20)}"`,
        gz:/^text\/|svg|json/.test(type)&&body.length>512?gzipSync(body):null});
    }
  })(dir,'');
  files.set('/',files.get('/index.html'));
  return files;
}

const MUTATING=new Set(['POST','PUT','PATCH','DELETE']);
const cleanName=s=>typeof s==='string'?s.normalize('NFC').trim().replace(/\s+/g,' '):'';
const validName=s=>s.length>=1&&s.length<=20&&!/[\p{Cc}\p{Cf}]/u.test(s);
const int=v=>{const n=Number(v); return Number.isSafeInteger(n)?n:null;};

export function createApp({dbFile=':memory:',publicDir=PUBLIC,cookieSecure=false,limiter=new auth.LoginLimiter()}={}){
  const db=openDb(dbFile);
  const files=loadStatic(publicDir);
  const secure=req=>cookieSecure||req.headers['x-forwarded-proto']==='https';
  const accountById=id=>db.prepare('SELECT a.*,p.name AS player_name FROM accounts a LEFT JOIN players p ON p.id=a.player_id WHERE a.id=?').get(id);
  const playerJson=p=>({id:p.id,name:p.name,hidden:!!p.hidden,rating:p.rating});
  const activeAdmins=(except)=>db.prepare('SELECT count(*) AS n FROM accounts WHERE is_admin=1 AND disabled=0 AND id<>?').get(except).n;

  function checkPlayer(id){
    if(id==null) return null;
    if(!Number.isSafeInteger(id)||!db.prepare('SELECT 1 FROM players WHERE id=?').get(id)) throw new HttpError(422,'Unknown player');
    return id;
  }

  /* ---------- Handlers: each gets {body, params, url, s (session), req} and returns JSON ---------- */
  const H={
    getSession:({s})=>({account:auth.accountJson(s&&s.account)}),

    async signIn({body,req}){
      const {username,password}=body;
      if(typeof username!=='string'||typeof password!=='string') throw new HttpError(400,'Enter a username and password');
      const key=nameKey(username);
      if(!limiter.allowed(key)) throw new HttpError(429,'Too many failed sign-ins. Try again in a few minutes.');
      const a=db.prepare('SELECT * FROM accounts WHERE username_key=?').get(key);
      const ok=a?await auth.verifyPassword(password,a.pw_hash):(await auth.verifyPassword(password,await auth.dummyHash()),false);
      if(!ok||a.disabled){limiter.failed(key); throw new HttpError(401,'Wrong username or password');}
      limiter.succeeded(key);
      const token=auth.createSession(db,a.id);
      return {status:200,body:{account:auth.accountJson(accountById(a.id))},headers:{'Set-Cookie':auth.sessionCookie(token,secure(req))}};
    },

    signOut({s,req}){
      if(s) auth.endSession(db,s.tokenHash);
      return {status:200,body:{ok:true},headers:{'Set-Cookie':auth.clearCookie(secure(req))}};
    },

    async changePassword({s,body}){
      const {current,password}=body, a=s.account, key='pw:'+a.id;
      if(!limiter.allowed(key)) throw new HttpError(429,'Too many wrong passwords. Try again in a few minutes.');
      if(typeof current!=='string'||!await auth.verifyPassword(current,a.pw_hash)){limiter.failed(key); throw new HttpError(400,'Your current password is wrong');}
      limiter.succeeded(key);
      if(!auth.validPassword(password)) throw new HttpError(400,'Use at least 8 characters');
      if(password===current) throw new HttpError(400,'Pick a password different from the current one');
      db.prepare('UPDATE accounts SET pw_hash=?,must_change_pw=0 WHERE id=?').run(await auth.hashPassword(password),a.id);
      auth.endSessions(db,a.id,s.tokenHash);
      return {account:auth.accountJson(accountById(a.id))};
    },

    updateOwnAccount({s,body}){
      if('playerId' in body) db.prepare('UPDATE accounts SET player_id=? WHERE id=?').run(checkPlayer(body.playerId),s.account.id);
      return {account:auth.accountJson(accountById(s.account.id))};
    },

    listPlayers:()=>({players:db.prepare('SELECT * FROM players ORDER BY name COLLATE NOCASE').all().map(playerJson)}),

    createPlayer({s,body}){
      const name=cleanName(body.name);
      if(!validName(name)) throw new HttpError(400,'Player names are 1 to 20 characters');
      const clash=db.prepare('SELECT * FROM players WHERE name_key=?').get(nameKey(name));
      if(clash) throw new HttpError(409,`${clash.name} is already on the roster`,{player:playerJson(clash)});
      const {lastInsertRowid:id}=db.prepare('INSERT INTO players(name,name_key,created_at,created_by) VALUES (?,?,?,?)').run(name,nameKey(name),Date.now(),s.account.id);
      return {status:201,body:{player:playerJson(db.prepare('SELECT * FROM players WHERE id=?').get(id))}};
    },

    updatePlayer({params:[id],body}){
      const p=db.prepare('SELECT * FROM players WHERE id=?').get(+id);
      if(!p) throw new HttpError(404,'No such player');
      if('name' in body){
        const name=cleanName(body.name);
        if(!validName(name)) throw new HttpError(400,'Player names are 1 to 20 characters');
        const clash=db.prepare('SELECT name FROM players WHERE name_key=? AND id<>?').get(nameKey(name),p.id);
        if(clash) throw new HttpError(409,`${clash.name} is already on the roster`);
        db.prepare('UPDATE players SET name=?,name_key=? WHERE id=?').run(name,nameKey(name),p.id);
      }
      if('hidden' in body) db.prepare('UPDATE players SET hidden=? WHERE id=?').run(body.hidden?1:0,p.id);
      return {player:playerJson(db.prepare('SELECT * FROM players WHERE id=?').get(p.id))};
    },

    playerStats:({params:[id]})=>playerStats(db,+id),

    listGames({url}){
      const q=url.searchParams, player=q.get('player')?int(q.get('player')):null;
      const limit=Math.min(100,Math.max(1,int(q.get('limit'))||25));
      return listGames(db,{player,before:q.get('before'),limit});
    },
    getGame:({params:[id]})=>getGame(db,id),
    putGame:({s,params:[id],body})=>putGame(db,s.account,id,body),
    voidGame:({params:[id],body})=>setVoid(db,id,body.void!==false),
    leaderboard:({url})=>leaderboard(db,url.searchParams.get('out')),

    listAccounts:()=>({accounts:db.prepare('SELECT a.*,p.name AS player_name FROM accounts a LEFT JOIN players p ON p.id=a.player_id ORDER BY a.username_key').all().map(auth.accountJson)}),

    async createAccount({s,body}){
      const username=typeof body.username==='string'?body.username.normalize('NFC').trim():'';
      if(!auth.validUsername(username)) throw new HttpError(400,'Usernames are 2 to 32 letters, numbers, dots, dashes or underscores');
      if(db.prepare('SELECT 1 FROM accounts WHERE username_key=?').get(nameKey(username))) throw new HttpError(409,'That username is taken');
      const password=auth.tempPassword(), hash=await auth.hashPassword(password);
      const id=tx(db,()=>{
        let playerId=checkPlayer(body.playerId??null);
        if(body.newPlayer){
          const name=username.slice(0,20), existing=db.prepare('SELECT id FROM players WHERE name_key=?').get(nameKey(name));
          playerId=existing?existing.id:Number(db.prepare('INSERT INTO players(name,name_key,created_at,created_by) VALUES (?,?,?,?)').run(name,nameKey(name),Date.now(),s.account.id).lastInsertRowid);
        }
        return db.prepare(`INSERT INTO accounts(username,username_key,pw_hash,is_admin,must_change_pw,player_id,created_at,created_by) VALUES (?,?,?,?,1,?,?,?)`)
          .run(username,nameKey(username),hash,body.isAdmin?1:0,playerId,Date.now(),s.account.id).lastInsertRowid;
      });
      return {status:201,body:{account:auth.accountJson(accountById(Number(id))),password}};
    },

    async updateAccount({s,params:[id],body}){
      const a=accountById(+id), me=s.account.id;
      if(!a) throw new HttpError(404,'No such account');
      const demote=body.isAdmin===false&&a.is_admin, disable=body.disabled===true&&!a.disabled;
      if(disable&&a.id===me) throw new HttpError(400,"You can't disable your own account");
      if(body.resetPassword&&a.id===me) throw new HttpError(400,'Change your own password from your account menu');
      if((demote||disable)&&a.is_admin&&!activeAdmins(a.id)) throw new HttpError(409,'There has to be at least one active admin');
      let password=null, hash=null;
      if(body.resetPassword){password=auth.tempPassword(); hash=await auth.hashPassword(password);}
      tx(db,()=>{
        if(typeof body.isAdmin==='boolean') db.prepare('UPDATE accounts SET is_admin=? WHERE id=?').run(+body.isAdmin,a.id);
        if(typeof body.disabled==='boolean') db.prepare('UPDATE accounts SET disabled=? WHERE id=?').run(+body.disabled,a.id);
        if('playerId' in body) db.prepare('UPDATE accounts SET player_id=? WHERE id=?').run(checkPlayer(body.playerId),a.id);
        if(hash) db.prepare('UPDATE accounts SET pw_hash=?,must_change_pw=1 WHERE id=?').run(hash,a.id);
        if(disable||hash) auth.endSessions(db,a.id);
      });
      return {account:auth.accountJson(accountById(a.id)),...(password?{password}:{})};
    },
  };

  // [method, path, handler, who may call it]
  const ROUTES=[
    ['GET','/api/session',H.getSession],
    ['POST','/api/session',H.signIn],
    ['DELETE','/api/session',H.signOut],
    ['POST','/api/account/password',H.changePassword,'account'],
    ['PATCH','/api/account',H.updateOwnAccount,'account'],
    ['GET','/api/players',H.listPlayers],
    ['POST','/api/players',H.createPlayer,'account'],
    ['PATCH',/^\/api\/players\/(\d+)$/,H.updatePlayer,'admin'],
    ['GET',/^\/api\/players\/(\d+)\/stats$/,H.playerStats],
    ['GET','/api/games',H.listGames],
    ['GET',/^\/api\/games\/([0-9a-f]{32})$/,H.getGame],
    ['PUT',/^\/api\/games\/([0-9a-f]{32})$/,H.putGame,'account'],
    ['POST',/^\/api\/games\/([0-9a-f]{32})\/void$/,H.voidGame,'admin'],
    ['GET','/api/stats/leaderboard',H.leaderboard],
    ['GET','/api/accounts',H.listAccounts,'admin'],
    ['POST','/api/accounts',H.createAccount,'admin'],
    ['PATCH',/^\/api\/accounts\/(\d+)$/,H.updateAccount,'admin'],
  ];
  // Mutations still allowed while a temporary password is waiting to be changed.
  const DURING_PW_CHANGE=new Set([H.changePassword,H.signOut]);

  // Browsers send Sec-Fetch-Site on every request; older ones and curl fall back to Origin vs Host.
  function checkOrigin(req){
    if(!/^application\/json\b/i.test(req.headers['content-type']||'')) throw new HttpError(415,'Send JSON');
    const site=req.headers['sec-fetch-site'];
    if(site) { if(site!=='same-origin'&&site!=='none') throw new HttpError(403,'Cross-site request refused'); return; }
    const origin=req.headers.origin;
    if(origin&&origin!=='null'){
      const host=req.headers['x-forwarded-host']||req.headers.host;
      let ok=false; try{ ok=new URL(origin).host===host; }catch(e){}
      if(!ok) throw new HttpError(403,'Cross-site request refused');
    }
  }

  async function handleApi(req,res,url){
    const matches=ROUTES.map(r=>{const m=typeof r[1]==='string'?(r[1]===url.pathname?[url.pathname]:null):r[1].exec(url.pathname); return m&&[r,m];}).filter(Boolean);
    if(!matches.length) throw new HttpError(404,'Not found');
    const hit=matches.find(([r])=>r[0]===req.method);
    if(!hit) throw new HttpError(405,'Method not allowed',{allow:matches.map(([r])=>r[0]).join(', ')});
    const [[,,handler,who],m]=hit;
    const mutating=MUTATING.has(req.method);
    if(mutating) checkOrigin(req);
    const body=mutating?await readJson(req):{};
    if(body===null||typeof body!=='object'||Array.isArray(body)) throw new HttpError(400,'Body must be a JSON object');
    const s=auth.readSession(db,req);
    const headers={};
    if(s&&s.refreshed) headers['Set-Cookie']=auth.sessionCookie(s.token,secure(req));
    if(who&&!s) throw new HttpError(401,'Sign in first');
    if(who==='admin'&&!s.account.is_admin) throw new HttpError(403,'Admins only');
    if(mutating&&s&&s.account.must_change_pw&&!DURING_PW_CHANGE.has(handler)) throw new HttpError(403,'Choose a new password first');
    let out=await handler({req,url,body,s,params:m.slice(1)});
    if(!out||!('status' in out&&'body' in out)) out={status:200,body:out};
    send(res,out.status,JSON.stringify(out.body),'application/json',{...headers,...out.headers,'Cache-Control':'no-store'});
  }

  function send(res,status,body,type,headers={}){
    res.writeHead(status,{...BASE_HEADERS,'Content-Type':type,'Content-Length':Buffer.byteLength(body),...headers});
    res.end(res.req.method==='HEAD'?undefined:body);
  }

  function serveStatic(req,res,path){
    if(req.method!=='GET'&&req.method!=='HEAD') return send(res,405,'Method not allowed\n','text/plain',{Allow:'GET, HEAD'});
    const f=files.get(path);
    if(!f) return send(res,404,'Not found\n','text/plain; charset=utf-8');
    const headers={ETag:f.etag,'Cache-Control':'no-cache',Vary:'Accept-Encoding'};
    if(req.headers['if-none-match']===f.etag){res.writeHead(304,{...BASE_HEADERS,...headers}); return res.end();}
    const gz=f.gz&&/\bgzip\b/.test(req.headers['accept-encoding']||'');
    if(gz) headers['Content-Encoding']='gzip';
    send(res,200,gz?f.gz:f.body,f.type,headers);
  }

  const server=http.createServer(async(req,res)=>{
    let url;
    try{ url=new URL(req.url,'http://localhost'); }catch(e){ return send(res,400,'Bad request\n','text/plain'); }
    try{
      if(url.pathname==='/healthz') return send(res,200,'ok\n','text/plain; charset=utf-8',{'Cache-Control':'no-store'});
      if(url.pathname==='/api'||url.pathname.startsWith('/api/')) return await handleApi(req,res,url);
      return serveStatic(req,res,url.pathname);
    }catch(e){
      if(res.headersSent) return res.destroy();
      if(!(e instanceof HttpError)){ console.error(e); e=new HttpError(500,'Something went wrong'); }
      const headers=e.extra&&e.extra.allow?{Allow:e.extra.allow}:{};
      const body={error:e.message,...(e.extra&&!e.extra.allow?e.extra:{})};
      send(res,e.status,JSON.stringify(body),'application/json',{...headers,'Cache-Control':'no-store'});
    }
  });
  return {server,db,close(){server.closeAllConnections(); server.close(); db.close();}};
}

/* ---------- Run ---------- */
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const dataDir=process.env.DATA_DIR||join(HERE,'..','data');
  mkdirSync(dataDir,{recursive:true});
  const app=createApp({dbFile:join(dataDir,'darts.db'),cookieSecure:process.env.COOKIE_SECURE==='1'});
  const port=Number(process.env.PORT)||8080, host=process.env.HOST||'0.0.0.0';
  app.server.listen(port,host,()=>console.log(`Darts scorer on http://${host==='0.0.0.0'?'localhost':host}:${port}`));
  const admins=app.db.prepare('SELECT count(*) AS n FROM accounts WHERE is_admin=1').get().n;
  if(!admins) console.log('No admin account yet. Create one with: node server/cli.js create-admin <username>');
  for(const sig of ['SIGTERM','SIGINT']) process.on(sig,()=>{app.close(); process.exit(0);});
}
