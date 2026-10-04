/* The relay between a big screen and the phones used as its keypad. The big screen runs the game:
   phones send it commands, and it sends back the state they render. Server-sent events carry
   everything to the browsers, which send with POST.
   Rooms live only in memory. After a restart the big screen reopens its room with the same code
   and keys, and phones simply reconnect. A phone holds {code, key}; the big screen also holds hostKey. */
import {randomBytes, randomInt, timingSafeEqual} from 'node:crypto';
import {HttpError} from './http.js';

const ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE=/^[A-HJKMNP-Z2-9]{4}$/;
const KEY=/^[A-Za-z0-9_-]{16}$/;
const PING='{"type":"ping"}';
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);

export function createRemotes({joinLimiter,baseHeaders={},maxRooms=50,maxPhones=10,idleMs=15*60e3,heartbeatMs=25e3}){
  const rooms=new Map();
  const newKey=()=>randomBytes(12).toString('base64url');
  const same=(a,b)=>{if(typeof a!=='string') return false; const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length&&timingSafeEqual(x,y);};
  const info=r=>({code:r.code,hostKey:r.hostKey,key:r.key});
  // A slow reader that has fallen a long way behind is cut off rather than buffered for.
  function write(res,msg){
    if(res.writableEnded) return;
    if(res.writableLength>1<<20) return res.destroy();
    res.write(`data: ${typeof msg==='string'?msg:JSON.stringify(msg)}\n\n`);
  }
  const end=(res,msg)=>{if(msg) write(res,msg); res.end();};

  // A wrong key looks exactly like a missing room, so nothing here tells anyone which codes are in use.
  function lookup(code,k){
    const r=typeof code==='string'?rooms.get(code.trim().toUpperCase()):null;
    const role=!r?null:same(k,r.hostKey)?'host':same(k,r.key)?'phone':null;
    return role?{r,role}:{};
  }

  // Phones see 'gone' when they reconnect, and wait for the big screen to come back.
  function drop(r){rooms.delete(r.code); r.phones.forEach(p=>p.end()); if(r.host) r.host.end();}

  function open({code,hostKey,key}={}){
    const r=typeof code==='string'?rooms.get(code):null;
    if(r&&same(hostKey,r.hostKey)) return info(r);
    // Asking for a particular code costs a guess, or open() would tell anyone which codes are taken.
    let want=null;
    if(typeof code==='string'&&CODE.test(code)&&KEY.test(hostKey)&&KEY.test(key)&&hostKey!==key&&joinLimiter.allowed('join')){
      joinLimiter.failed('join'); if(!r) want=code;
    }
    if(rooms.size>=maxRooms){
      let old=null;
      for(const x of rooms.values()) if(!x.host&&(!old||x.idleSince<old.idleSince)) old=x;
      if(!old) throw new HttpError(503,'Too many big screens are open. Try again later.');
      drop(old);
    }
    if(!want){
      hostKey=newKey(); key=newKey();
      do want=Array.from({length:4},()=>ALPHABET[randomInt(ALPHABET.length)]).join(''); while(rooms.has(want));
    }
    const room={code:want,hostKey,key,host:null,phones:new Set(),state:null,idleSince:Date.now()};
    rooms.set(want,room);
    return info(room);
  }

  // Typed codes are the only guessable way in, so wrong ones count against the limiter. succeeded() is
  // never called: anyone can open a room, and joining their own would wipe out their failures.
  function join({code}={}){
    if(!joinLimiter.allowed('join')) throw new HttpError(429,'Too many wrong codes. Try again in a few minutes.');
    const r=typeof code==='string'?rooms.get(code.trim().toUpperCase()):null;
    if(!r){joinLimiter.failed('join'); throw new HttpError(404,'No big screen has that code');}
    return {code:r.code,key:r.key};
  }

  // Always 200: EventSource can't read a status and gives up on anything else, so the
  // outcome goes in the last event instead ('gone', 'full', 'replaced', 'closed').
  function events(req,res,url){
    res.writeHead(200,{...baseHeaders,'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.write('retry: 2000\n\n');
    const {r,role}=lookup(url.searchParams.get('code'),url.searchParams.get('k'));
    if(!r) return end(res,{type:'gone'});
    if(role==='host'){
      // The newest connection wins: a tab that woke from sleep replaces its own dead socket.
      if(r.host) end(r.host,{type:'replaced'});
      r.host=res;
      write(res,{type:'hello',phones:r.phones.size});
      r.phones.forEach(p=>write(p,{type:'presence',host:true}));
      res.on('close',()=>{
        if(r.host!==res) return;
        r.host=null; r.idleSince=Date.now();
        r.phones.forEach(p=>write(p,{type:'presence',host:false}));
      });
      return;
    }
    if(r.phones.size>=maxPhones) return end(res,{type:'full'});
    r.phones.add(res);
    write(res,{type:'presence',host:!!r.host});
    if(r.state) write(res,r.state);
    if(r.host) write(r.host,{type:'presence',phones:r.phones.size});
    res.on('close',()=>{ if(r.phones.delete(res)&&r.host) write(r.host,{type:'presence',phones:r.phones.size}); });
  }

  // Phones send {cmd}, which goes to the big screen as it is; the big screen checks it.
  // The big screen sends {state}, which is kept for phones that connect later.
  function send(body){
    const {r,role}=lookup(body.code,body.k);
    if(!r) throw new HttpError(404,"That big screen isn't open");
    if(role==='phone'){
      if('state' in body) throw new HttpError(403,'Only the big screen sends state');
      if(!plain(body.cmd)) throw new HttpError(400,'cmd must be an object');
      const json=JSON.stringify(body.cmd);
      if(json.length>512) throw new HttpError(413,'Command too large');
      if(!r.host) throw new HttpError(409,"The big screen isn't connected");
      write(r.host,`{"type":"command","cmd":${json}}`);
      return {ok:true};
    }
    if('cmd' in body) throw new HttpError(403,'Only phones send commands');
    if(!plain(body.state)) throw new HttpError(400,'state must be an object');
    const json=JSON.stringify(body.state);
    if(json.length>64*1024) throw new HttpError(413,'State too large');
    r.state=`{"type":"state","view":${json}}`;
    r.phones.forEach(p=>write(p,r.state));
    return {ok:true};
  }

  function close(body){
    const {r,role}=lookup(body.code,body.k);
    if(!r) return {ok:true};
    if(role!=='host') throw new HttpError(403,'Only the big screen can close its room');
    rooms.delete(r.code);
    r.phones.forEach(p=>end(p,{type:'closed'}));
    if(r.host) end(r.host,{type:'closed'});
    return {ok:true};
  }

  // Heartbeats keep proxies from timing the streams out and let browsers notice a dead link,
  // which they can't do with SSE comments since those never reach JS.
  const timer=setInterval(()=>{
    const now=Date.now();
    for(const r of rooms.values()){
      if(!r.host&&now-r.idleSince>idleMs){drop(r); continue;}
      if(r.host) write(r.host,PING);
      r.phones.forEach(p=>write(p,PING));
    }
  },heartbeatMs);
  timer.unref();

  return {open,join,events,send,close,shutdown(){clearInterval(timer); rooms.clear();}};
}
