/* Password hashing, sessions and the login rate limit. */
import {scrypt, randomBytes, randomInt, timingSafeEqual, createHash} from 'node:crypto';

// scrypt cost. Tests turn it down; everything else keeps the default.
export const hashing={N:2**15,r:8,p:1};
const MAXMEM=64*1024*1024, KEYLEN=32;
const scryptAsync=(pw,salt,len,o)=>new Promise((ok,bad)=>scrypt(pw,salt,len,{...o,maxmem:MAXMEM},(e,k)=>e?bad(e):ok(k)));

export async function hashPassword(pw){
  const {N,r,p}=hashing, salt=randomBytes(16);
  const key=await scryptAsync(pw.normalize('NFC'),salt,KEYLEN,{N,r,p});
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw,stored){
  const [alg,N,r,p,salt,hash]=String(stored).split('$');
  if(alg!=='scrypt') return false;
  const want=Buffer.from(hash,'base64');
  const key=await scryptAsync(pw.normalize('NFC'),Buffer.from(salt,'base64'),want.length,{N:+N,r:+r,p:+p});
  return timingSafeEqual(key,want);
}
// Checked against when the username doesn't exist, so timing doesn't reveal which ones do.
let dummy=null;
export const dummyHash=()=>dummy??=hashPassword(randomBytes(12).toString('base64'));

// Temporary passwords: 12 unambiguous characters in groups of four.
export function tempPassword(){
  const A='abcdefghjkmnpqrstuvwxyz23456789'; let s='';
  for(let i=0;i<12;i++){ s+=A[randomInt(A.length)]; if(i%4===3&&i<11) s+='-'; }
  return s;
}
export const validUsername=u=>typeof u==='string'&&/^[\p{L}\p{N}._-]{2,32}$/u.test(u);
export const validPassword=p=>typeof p==='string'&&p.length>=8&&p.length<=256;

/* ---------- Sessions ---------- */
export const COOKIE='darts_session';
const TTL=30*864e5, SLIDE=3600e3;
const sha=t=>createHash('sha256').update(t).digest('hex');

export function createSession(db,accountId){
  const token=randomBytes(32).toString('base64url'), now=Date.now();
  db.prepare('INSERT INTO sessions(token_hash,account_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha(token),accountId,now,now+TTL);
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
  return token;
}
// No Path: the browser scopes the cookie to wherever api/session lives, which is right under any subpath.
export const sessionCookie=(token,secure)=>`${COOKIE}=${token}; HttpOnly; SameSite=Strict; Max-Age=${TTL/1000}${secure?'; Secure':''}`;
export const clearCookie=secure=>`${COOKIE}=; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`;

export function parseCookies(h=''){
  const out={};
  for(const part of h.split(';')){ const i=part.indexOf('='); if(i>0) out[part.slice(0,i).trim()]=part.slice(i+1).trim(); }
  return out;
}

// Returns {account, tokenHash, token, refreshed} for a live session, else null. Slides the expiry at most hourly.
export function readSession(db,req){
  const token=parseCookies(req.headers.cookie)[COOKIE]; if(!token) return null;
  const now=Date.now();
  const row=db.prepare(`SELECT s.token_hash AS tokenHash, s.expires_at AS expiresAt, a.*, p.name AS player_name
    FROM sessions s JOIN accounts a ON a.id=s.account_id LEFT JOIN players p ON p.id=a.player_id
    WHERE s.token_hash=? AND s.expires_at>? AND a.disabled=0`).get(sha(token),now);
  if(!row) return null;
  let refreshed=false;
  if(row.expiresAt<now+TTL-SLIDE){ db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(now+TTL,row.tokenHash); refreshed=true; }
  return {account:row,tokenHash:row.tokenHash,token,refreshed};
}
export const endSessions=(db,accountId,exceptHash=null)=>
  db.prepare('DELETE FROM sessions WHERE account_id=? AND token_hash IS NOT ?').run(accountId,exceptHash);
export const endSession=(db,tokenHash)=>db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);

export const accountJson=a=>a?{id:a.id,username:a.username,isAdmin:!!a.is_admin,mustChangePw:!!a.must_change_pw,
  disabled:!!a.disabled,playerId:a.player_id??null,playerName:a.player_name??null,createdAt:a.created_at}:null;

/* ---------- Login rate limit ----------
   Per username plus a global cap. Not per IP: behind a proxy every request comes from the same address. */
export class LoginLimiter {
  constructor({window=15*60e3,perUser=5,global=100}={}){Object.assign(this,{window,perUser,global}); this.fails=new Map(); this.all=[];}
  prune(list){const cut=Date.now()-this.window; while(list.length&&list[0]<cut) list.shift(); return list;}
  allowed(key){return this.prune(this.fails.get(key)||[]).length<this.perUser&&this.prune(this.all).length<this.global;}
  failed(key){const l=this.fails.get(key)||[]; l.push(Date.now()); this.fails.set(key,l); this.all.push(Date.now());}
  succeeded(key){this.fails.delete(key);}
}
