/* A small QR code encoder for the big screen's pairing link: byte mode, error correction
   level M, versions 1 to 10 (up to 213 bytes), with the mask picked by the standard penalty
   score. Written here because the CSP allows no outside scripts. */

// Level M per version: EC codewords per block, then [block count, data codewords] for each group.
const BLOCKS=[null,[10,1,16],[16,1,28],[26,1,44],[18,2,32],[24,2,43],[16,4,27],[18,4,31],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44]];
const dataWords=v=>{const b=BLOCKS[v]; let n=0; for(let i=1;i<b.length;i+=2) n+=b[i]*b[i+1]; return n;};
const countBits=v=>v<10?8:16;

/* ---------- Reed–Solomon over GF(256), polynomial 0x11D ---------- */
function mul(x,y){let z=0; for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11D); z^=((y>>>i)&1)*x;} return z;}
function divisor(degree){
  const d=new Array(degree).fill(0); d[degree-1]=1; let root=1;
  for(let i=0;i<degree;i++){
    for(let j=0;j<degree;j++){d[j]=mul(d[j],root); if(j+1<degree) d[j]^=d[j+1];}
    root=mul(root,2);
  }
  return d;
}
// The EC codewords for one block of data.
export function _rs(data,degree){
  const d=divisor(degree), out=new Array(degree).fill(0);
  for(const b of data){const f=b^out.shift(); out.push(0); d.forEach((c,i)=>{out[i]^=mul(c,f);});}
  return out;
}

/* ---------- Codewords ---------- */
function codewords(bytes,v){
  const bits=[], put=(val,n)=>{for(let i=n-1;i>=0;i--) bits.push((val>>>i)&1);};
  const cap=dataWords(v)*8;
  put(4,4); put(bytes.length,countBits(v)); bytes.forEach(b=>put(b,8));
  put(0,Math.min(4,cap-bits.length));
  put(0,(8-bits.length%8)%8);
  for(let pad=0xEC;bits.length<cap;pad^=0xEC^0x11) put(pad,8);
  const data=[]; for(let i=0;i<bits.length;i+=8) data.push(bits.slice(i,i+8).reduce((a,b)=>a<<1|b,0));
  // Split into blocks, add each block's EC words, then interleave column by column.
  const b=BLOCKS[v], blocks=[]; let k=0;
  for(let g=1;g<b.length;g+=2) for(let i=0;i<b[g];i++){const d=data.slice(k,k+=b[g+1]); blocks.push({d,ec:_rs(d,b[0])});}
  const out=[], longest=Math.max(...blocks.map(x=>x.d.length));
  for(let i=0;i<longest;i++) for(const x of blocks) if(i<x.d.length) out.push(x.d[i]);
  for(let i=0;i<b[0];i++) for(const x of blocks) out.push(x.ec[i]);
  return out;
}

/* ---------- Matrix ---------- */
export function formatBits(mask){
  const data=mask; let rem=data;  // level M is 00
  for(let i=0;i<10;i++) rem=(rem<<1)^((rem>>>9)*0x537);
  return ((data<<10)|rem)^0x5412;
}
export function versionBits(v){
  let rem=v;
  for(let i=0;i<12;i++) rem=(rem<<1)^((rem>>>11)*0x1F25);
  return (v<<12)|rem;
}
function alignment(v){
  if(v===1) return [];
  const n=Math.floor(v/7)+2, size=17+4*v, step=Math.ceil((v*4+4)/(n*2-2))*2, out=[6];
  for(let pos=size-7;out.length<n;pos-=step) out.splice(1,0,pos);
  return out;
}
const MASKS=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,x=>x%3===0,(x,y)=>(x+y)%3===0,
  (x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,(x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];

function build(v,words,mask){
  const size=17+4*v, dark=Array.from({length:size},()=>new Array(size).fill(false)), fixed=dark.map(r=>r.map(()=>false));
  const set=(x,y,on)=>{dark[y][x]=on; fixed[y][x]=true;};
  for(let i=0;i<size;i++){set(6,i,i%2===0); set(i,6,i%2===0);}
  for(const [cx,cy] of [[3,3],[size-4,3],[3,size-4]])
    for(let dy=-4;dy<=4;dy++) for(let dx=-4;dx<=4;dx++){
      const x=cx+dx, y=cy+dy, d=Math.max(Math.abs(dx),Math.abs(dy));
      if(x>=0&&x<size&&y>=0&&y<size) set(x,y,d!==2&&d!==4);
    }
  const al=alignment(v), last=al.length-1;
  al.forEach((cx,i)=>al.forEach((cy,j)=>{
    if((i===0&&j===0)||(i===0&&j===last)||(i===last&&j===0)) return;
    for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) set(cx+dx,cy+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);
  }));
  const fb=formatBits(mask), bit=(n,i)=>((n>>>i)&1)===1;
  for(let i=0;i<=5;i++) set(8,i,bit(fb,i));
  set(8,7,bit(fb,6)); set(8,8,bit(fb,7)); set(7,8,bit(fb,8));
  for(let i=9;i<15;i++) set(14-i,8,bit(fb,i));
  for(let i=0;i<8;i++) set(size-1-i,8,bit(fb,i));
  for(let i=8;i<15;i++) set(8,size-15+i,bit(fb,i));
  set(8,size-8,true);
  if(v>=7){
    const vb=versionBits(v);
    for(let i=0;i<18;i++){const a=size-11+i%3, b=Math.floor(i/3); set(a,b,bit(vb,i)); set(b,a,bit(vb,i));}
  }
  // Data in two-column strips from the right, zigzagging up and down, skipping the timing column.
  let i=0; const total=words.length*8, m=MASKS[mask];
  for(let right=size-1;right>=1;right-=2){
    if(right===6) right=5;
    for(let vert=0;vert<size;vert++) for(let j=0;j<2;j++){
      const x=right-j, y=((right+1)&2)===0?size-1-vert:vert;
      if(fixed[y][x]) continue;
      const on=i<total&&bit(words[i>>>3],7-(i&7)); i++;
      dark[y][x]=on!==m(x,y);
    }
  }
  return dark;
}

// The spec's mask penalty: runs, 2×2 blocks, finder-like patterns, and dark/light balance.
function penalty(dark){
  const n=dark.length; let p=0;
  const line=get=>{
    let run=1;
    for(let i=1;i<=n;i++){
      if(i<n&&get(i)===get(i-1)) run++;
      else {if(run>=5) p+=run-2; run=1;}
    }
    for(let i=0;i+11<=n;i++){
      const s=Array.from({length:11},(_,k)=>get(i+k)?1:0).join('');
      if(s==='10111010000'||s==='00001011101') p+=40;
    }
  };
  for(let y=0;y<n;y++) line(x=>dark[y][x]);
  for(let x=0;x<n;x++) line(y=>dark[y][x]);
  let count=0;
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){
    if(dark[y][x]) count++;
    if(x<n-1&&y<n-1){const c=dark[y][x]; if(c===dark[y][x+1]&&c===dark[y+1][x]&&c===dark[y+1][x+1]) p+=3;}
  }
  return p+Math.floor(Math.abs(count*20-n*n*10)/(n*n))*10;
}

// {version, size, mask, get(x,y)} for text, or null when it won't fit in version 10.
export function qrMatrix(text,{mask=null}={}){
  const bytes=[...new TextEncoder().encode(text)];
  let v=1; while(v<=10&&dataWords(v)*8<4+countBits(v)+bytes.length*8) v++;
  if(v>10) return null;
  const words=codewords(bytes,v);
  let best=null, bestMask=0, bestP=Infinity;
  for(let k=0;k<8;k++){
    if(mask!=null&&k!==mask) continue;
    const d=build(v,words,k), pk=mask!=null?0:penalty(d);
    if(pk<bestP){best=d; bestMask=k; bestP=pk;}
  }
  return {version:v,size:best.length,mask:bestMask,get:(x,y)=>best[y][x]};
}

// An SVG of the code with its 4-module quiet zone, or '' when the text is too long.
export function qrSvg(text){
  const q=qrMatrix(text); if(!q) return '';
  let d='';
  for(let y=0;y<q.size;y++) for(let x=0;x<q.size;x++){
    if(!q.get(x,y)||(x>0&&q.get(x-1,y))) continue;
    let w=1; while(x+w<q.size&&q.get(x+w,y)) w++;
    d+=`M${x+4} ${y+4}h${w}v1h-${w}z`;
  }
  const s=q.size+8;
  return `<svg class="qr" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="QR code for the keypad link"><path fill="currentColor" d="${d}"/></svg>`;
}
