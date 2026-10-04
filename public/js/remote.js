/* The link between a big screen and the phones used as its keypad (server/remotes.js has the
   other end): room requests, an event stream that heals itself, a publisher that only ever
   sends the latest state, and a screen wake lock. */
import {api} from './api.js';

export const openRoom=creds=>api.post('api/remote',creds||{});
export const joinRoom=code=>api.post('api/remote/join',{code});
export const sendRoom=(code,k,body)=>api.post('api/remote/send',{code,k,...body});
export const closeRoom=(code,k)=>api.post('api/remote/close',{code,k});
export const eventsUrl=(code,k)=>`api/remote/events?code=${encodeURIComponent(code)}&k=${encodeURIComponent(k)}`;
// crypto.randomUUID needs a secure context, and plain-HTTP LAN addresses aren't one.
export function randomId(){const b=new Uint8Array(8); crypto.getRandomValues(b); return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');}

/* An EventSource that recovers by itself. The browser stops retrying after any non-200 answer
   (a proxy's 502 during a restart, say), and a socket can die silently while the computer
   sleeps, so this reconnects on its own: with backoff when the browser gives up, after 45 seconds
   without even a ping (the server sends one every 25), and when the page becomes visible again after a while.
   The server ends a stream with one of TERMINAL; what happens next is up to the caller,
   who can retry() (with backoff) or close(). onStatus gets 'live' or 'down'. */
const TERMINAL=new Set(['gone','full','replaced','closed']);
export class Channel {
  constructor(url,{onEvent,onStatus=()=>{}}){
    Object.assign(this,{url,onEvent,onStatus,es:null,timer:null,delay:1000,last:0,dead:false});
    this.onVis=()=>{if(document.visibilityState==='visible'&&this.es&&Date.now()-this.last>20e3) this.reconnect();};
    document.addEventListener('visibilitychange',this.onVis);
    this.watch=setInterval(()=>{if(this.es&&Date.now()-this.last>45e3) this.reconnect();},5e3);
    this.connect();
  }
  connect(){
    clearTimeout(this.timer); if(this.dead) return;
    if(this.es) this.es.close();
    const es=this.es=new EventSource(this.url); this.last=Date.now();
    es.onmessage=e=>{
      if(this.es!==es) return;
      this.last=Date.now();
      let m; try{m=JSON.parse(e.data);}catch(x){return;}
      if(m.type==='ping') return;
      // Backoff resets on real events only: 'gone' arrives on a perfectly good connection.
      if(TERMINAL.has(m.type)){es.close(); this.es=null;} else {this.delay=1000; this.onStatus('live');}
      this.onEvent(m);
    };
    es.onerror=()=>{
      if(this.es!==es) return;
      this.onStatus('down');
      if(es.readyState===EventSource.CLOSED){this.es=null; this.retry();}
    };
  }
  retry(){this.reconnect(this.delay); this.delay=Math.min(this.delay*2,15e3);}
  reconnect(ms=0){
    if(this.dead) return;
    clearTimeout(this.timer);
    if(this.es){this.es.close(); this.es=null;}
    this.timer=setTimeout(()=>this.connect(),ms);
  }
  close(){
    this.dead=true; clearTimeout(this.timer); clearInterval(this.watch);
    document.removeEventListener('visibilitychange',this.onVis);
    if(this.es){this.es.close(); this.es=null;}
  }
}

/* Sends views one at a time, newest first: anything superseded while a send is in flight is
   skipped, and so is a repeat of what was last sent. Failures retry every couple of seconds. */
export class Publisher {
  constructor(send){Object.assign(this,{send,want:null,sent:null,busy:false,timer:null,stopped:false});}
  push(view){this.want=JSON.stringify(view); this.kick();}
  reset(){this.sent=null;}
  stop(){this.stopped=true; clearTimeout(this.timer);}
  async kick(){
    if(this.busy||this.stopped||this.want==null||this.want===this.sent) return;
    clearTimeout(this.timer); this.busy=true;
    const body=this.want;
    try{ await this.send(JSON.parse(body)); this.sent=body; }
    catch(e){ this.timer=setTimeout(()=>this.kick(),2000); return; }
    finally{ this.busy=false; }
    this.kick();
  }
}

// Keeps the screen on while wanted, where the browser allows it (HTTPS only), and takes the
// lock again after the page comes back, since browsers drop it whenever the page is hidden.
export class Awake {
  constructor(){
    this.lock=null; this.want=false;
    document.addEventListener('visibilitychange',()=>{if(this.want) this.hold();});
  }
  async hold(){
    this.want=true;
    if(this.lock||!navigator.wakeLock||document.visibilityState!=='visible') return;
    this.lock='pending';
    try{
      const l=await navigator.wakeLock.request('screen');
      if(!this.want){l.release().catch(()=>{}); this.lock=null; return;}
      this.lock=l; l.addEventListener('release',()=>{if(this.lock===l) this.lock=null;});
    }catch(e){this.lock=null;}
  }
  release(){
    this.want=false;
    if(this.lock&&this.lock!=='pending') this.lock.release().catch(()=>{});
    this.lock=null;
  }
}
