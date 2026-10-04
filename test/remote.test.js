import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {createApp} from '../server/index.js';
import {LoginLimiter} from '../server/auth.js';

const opts=()=>({remote:{heartbeatMs:40,idleMs:150,maxRooms:3,maxPhones:2},joinLimiter:new LoginLimiter({perUser:3,global:3})});
let app, base, limiter;
const streams=new Set();
async function start(port=0){
  const o=opts(); limiter=o.joinLimiter;
  app=createApp(o);
  await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
  base=`http://127.0.0.1:${app.server.address().port}`;
}
before(()=>start());
after(()=>{streams.forEach(s=>s.close()); app.close();});

async function post(path,body,headers={}){
  const res=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  return {status:res.status,body:await res.json().catch(()=>null)};
}
const open=async(b={})=>{const r=await post('/api/remote',b); assert.equal(r.status,200,JSON.stringify(r.body)); return r.body;};
const q=(code,k)=>`/api/remote/events?code=${encodeURIComponent(code)}&k=${encodeURIComponent(k)}`;

// Reads a server-sent event stream. next(type) resolves with the next event of that type,
// skipping (and keeping) others; seen() lists every event so far.
async function sse(path){
  const ac=new AbortController();
  const res=await fetch(base+path,{signal:ac.signal});
  const reader=res.body.pipeThrough(new TextDecoderStream()).getReader();
  const all=[], waiters=[]; let buf='', ended=false, pos=0;
  const pump=()=>{for(const w of [...waiters]) w();};
  (async()=>{
    try{
      for(;;){
        const {value,done}=await reader.read(); if(done) break;
        buf+=value; let i;
        while((i=buf.indexOf('\n\n'))>=0){
          const block=buf.slice(0,i); buf=buf.slice(i+2);
          const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
          if(data){all.push(JSON.parse(data)); pump();}
        }
      }
    }catch(e){}
    ended=true; pump();
  })();
  const s={res,
    next(type,ms=1500){
      return new Promise((ok,bad)=>{
        const t=setTimeout(()=>{waiters.splice(waiters.indexOf(check),1); bad(new Error(`no ${type} event; saw ${JSON.stringify(all.map(e=>e.type))}`));},ms);
        function check(){
          while(pos<all.length){const ev=all[pos++]; if(ev.type===type){clearTimeout(t); waiters.splice(waiters.indexOf(check),1); return ok(ev);}}
          if(ended){clearTimeout(t); waiters.splice(waiters.indexOf(check),1); bad(new Error(`stream ended before ${type}; saw ${JSON.stringify(all.map(e=>e.type))}`));}
        }
        waiters.push(check); check();
      });
    },
    async ends(ms=1500){const t0=Date.now(); while(!ended){if(Date.now()-t0>ms) throw new Error('stream still open'); await new Promise(r=>setTimeout(r,10));}},
    seen:()=>all.map(e=>e.type),
    get all(){return all;},
    close(){ac.abort(); streams.delete(s);},
  };
  streams.add(s);
  return s;
}

test('opening a room gives a short code and two keys', async()=>{
  const r=await open();
  assert.match(r.code,/^[A-HJKMNP-Z2-9]{4}$/);
  assert.match(r.hostKey,/^[\w-]{16}$/); assert.match(r.key,/^[\w-]{16}$/);
  assert.notEqual(r.hostKey,r.key);
  await post('/api/remote/close',{code:r.code,k:r.hostKey});
});

test('host stream: headers, hello, presence, commands and state', async()=>{
  const r=await open();
  const host=await sse(q(r.code,r.hostKey));
  assert.equal(host.res.status,200);
  assert.match(host.res.headers.get('content-type'),/^text\/event-stream/);
  assert.equal(host.res.headers.get('cache-control'),'no-store');
  assert.equal(host.res.headers.get('x-accel-buffering'),'no');
  assert.equal(host.res.headers.get('content-length'),null);
  assert.ok(host.res.headers.get('content-security-policy'));
  assert.deepEqual(await host.next('hello'),{type:'hello',phones:0});

  // A phone that types the code gets the room key.
  const j=await post('/api/remote/join',{code:r.code.toLowerCase()});
  assert.equal(j.status,200); assert.deepEqual(j.body,{code:r.code,key:r.key});
  const phone=await sse(q(r.code,r.key));
  assert.deepEqual(await phone.next('presence'),{type:'presence',host:true});
  assert.deepEqual(await host.next('presence'),{type:'presence',phones:1});

  // State fans out, and a phone that connects later gets the latest straight away.
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.hostKey,state:{rev:1,n:'one'}})).status,200);
  assert.deepEqual((await phone.next('state')).view,{rev:1,n:'one'});
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.hostKey,state:{rev:2}})).status,200);
  const late=await sse(q(r.code,r.key));
  assert.deepEqual((await late.next('state')).view,{rev:2});
  assert.deepEqual(await host.next('presence'),{type:'presence',phones:2});

  // Commands reach the host unchanged.
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.key,cmd:{id:'a',rev:2,cmd:'total',v:60}})).status,200);
  assert.deepEqual((await host.next('command')).cmd,{id:'a',rev:2,cmd:'total',v:60});

  // Each side may only send its own kind of message.
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.key,state:{}})).status,403);
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.hostKey,cmd:{}})).status,403);
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.key,cmd:'x'})).status,400);
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.key,cmd:{pad:'x'.repeat(600)}})).status,413);
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.hostKey,state:{pad:'x'.repeat(70000)}})).status,413);
  assert.equal((await post('/api/remote/close',{code:r.code,k:r.key})).status,403);

  // The room is full at two phones.
  const third=await sse(q(r.code,r.key));
  await third.next('full'); await third.ends();

  // Without the host, phones hear it's gone and commands are refused.
  host.close();
  assert.deepEqual(await phone.next('presence'),{type:'presence',host:false});
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.key,cmd:{cmd:'undo'}})).status,409);

  // Closing ends every stream with 'closed'.
  const host2=await sse(q(r.code,r.hostKey)); await host2.next('hello');
  assert.deepEqual(await phone.next('presence'),{type:'presence',host:true});
  assert.equal((await post('/api/remote/close',{code:r.code,k:r.hostKey})).status,200);
  for(const s of [phone,late,host2]){await s.next('closed'); await s.ends();}
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.key,cmd:{}})).status,404);
  [phone,late,third].forEach(s=>s.close());
});

test('wrong keys and unknown codes look the same', async()=>{
  const r=await open();
  for(const path of [q(r.code,'x'.repeat(16)),q(r.code,'ü'.repeat(16)),q('ZZZZ',r.key),'/api/remote/events']){
    const s=await sse(path); await s.next('gone'); await s.ends(); assert.deepEqual(s.seen(),['gone']);
  }
  assert.equal((await post('/api/remote/send',{code:r.code,k:'nope',cmd:{}})).status,404);
  assert.equal((await post('/api/remote/send',{code:'ZZZZ',k:r.key,cmd:{}})).status,404);
  await post('/api/remote/close',{code:r.code,k:r.hostKey});
});

test('a second host connection replaces the first', async()=>{
  const r=await open();
  const a=await sse(q(r.code,r.hostKey)); await a.next('hello');
  const phone=await sse(q(r.code,r.key)); await phone.next('presence');
  const b=await sse(q(r.code,r.hostKey)); await b.next('hello');
  await a.next('replaced'); await a.ends();
  // The old stream closing doesn't mark the host as gone.
  await new Promise(r=>setTimeout(r,50));
  assert.equal((await post('/api/remote/send',{code:r.code,k:r.key,cmd:{cmd:'undo'}})).status,200);
  assert.equal((await b.next('command')).cmd.cmd,'undo');
  assert.ok(!phone.all.some(e=>e.type==='presence'&&e.host===false),JSON.stringify(phone.all));
  [b,phone].forEach(s=>s.close());
  await post('/api/remote/close',{code:r.code,k:r.hostKey});
});

test('resuming keeps the code only with the right host key', async()=>{
  const r=await open();
  assert.deepEqual(await open({...r}),r);
  const other=await open({code:r.code,hostKey:'y'.repeat(16),key:'z'.repeat(16)});
  assert.notEqual(other.code,r.code); assert.notEqual(other.key,r.key);
  for(const x of [r,other]) await post('/api/remote/close',{code:x.code,k:x.hostKey});
});

test('rooms expire once the host has been gone a while, and the cap evicts the stalest', async()=>{
  const a=await open(), b=await open(), c=await open();
  const hb=await sse(q(b.code,b.hostKey)), hc=await sse(q(c.code,c.hostKey));
  await hb.next('hello'); await hc.next('hello');
  // Pings arrive on the heartbeat.
  await hb.next('ping',500);
  // Full: the room with no host goes first...
  const d=await open();
  const s=await sse(q(a.code,a.key)); await s.next('gone');
  // ...and once every host is live there's nothing to evict.
  const hd=await sse(q(d.code,d.hostKey)); await hd.next('hello');
  assert.equal((await post('/api/remote',{})).status,503);
  // A room whose host left expires, and its phones are cut off.
  const phone=await sse(q(d.code,d.key)); await phone.next('presence');
  hd.close();
  await phone.next('presence'); await phone.ends(1000);
  const again=await sse(q(d.code,d.key)); await again.next('gone');
  [hb,hc,phone].forEach(s=>s.close());
  for(const x of [b,c]) await post('/api/remote/close',{code:x.code,k:x.hostKey});
});

test('after a restart the host reopens the same room and phones reconnect', async()=>{
  const r=await open();
  const port=app.server.address().port;
  streams.forEach(s=>s.close()); app.close();
  await new Promise(r=>setTimeout(r,50)); // lets fetch notice its pooled sockets were closed
  await start(port);
  const phone=await sse(q(r.code,r.key)); await phone.next('gone');
  assert.deepEqual(await open({...r}),r);
  const host=await sse(q(r.code,r.hostKey)); await host.next('hello');
  await post('/api/remote/send',{code:r.code,k:r.hostKey,state:{rev:9}});
  const phone2=await sse(q(r.code,r.key));
  assert.deepEqual(await phone2.next('presence'),{type:'presence',host:true});
  assert.deepEqual((await phone2.next('state')).view,{rev:9});
  [host,phone2].forEach(s=>s.close());
  await post('/api/remote/close',{code:r.code,k:r.hostKey});
});

test('wrong codes are rate limited, separately from sign-in', async()=>{
  limiter.fails.clear(); limiter.all=[];
  const r=await open();
  // Each request for a particular code counts as a guess too, so open() can't probe for codes.
  assert.equal((await post('/api/remote/join',{code:'ZZZZ'})).status,404);
  assert.equal((await post('/api/remote/join',{code:'ZZZY'})).status,404);
  const taken=await open({code:r.code,hostKey:'y'.repeat(16),key:'z'.repeat(16)});
  assert.notEqual(taken.code,r.code);
  assert.equal((await post('/api/remote/join',{code:r.code})).status,429);
  // Once limited, asking for a code just gets a fresh one.
  const fresh=await open({code:'ZZZX',hostKey:'y'.repeat(16),key:'z'.repeat(16)});
  assert.notEqual(fresh.code,'ZZZX');
  const signIn=await post('/api/session',{username:'nobody',password:'nope'});
  assert.equal(signIn.status,401);
  for(const x of [r,taken,fresh]) await post('/api/remote/close',{code:x.code,k:x.hostKey});
});

test('posts need JSON from the same site; events only answers GET', async()=>{
  const res=await fetch(base+'/api/remote',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'});
  assert.equal(res.status,415);
  assert.equal((await post('/api/remote',{},{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await post('/api/remote/send',{},{origin:'http://evil.example'})).status,403);
  assert.equal((await post('/api/remote/events',{})).status,405);
});

test('streams work over HTTP/1.0, as nginx proxies by default', async()=>{
  const r=await open();
  const sock=net.connect(app.server.address().port,'127.0.0.1');
  sock.write(`GET ${q(r.code,r.hostKey)} HTTP/1.0\r\nHost: x\r\n\r\n`);
  let text=''; sock.setEncoding('utf8');
  await new Promise((ok,bad)=>{const t=setTimeout(()=>bad(new Error('no hello: '+text)),1500);
    sock.on('data',d=>{text+=d; if(text.includes('"hello"')){clearTimeout(t); ok();}});});
  assert.match(text,/^HTTP\/1\.1 200/);
  assert.doesNotMatch(text,/transfer-encoding/i);
  assert.doesNotMatch(text,/content-length/i);
  assert.doesNotMatch(text,/keep-alive/i);
  sock.destroy();
  await post('/api/remote/close',{code:r.code,k:r.hostKey});
});
