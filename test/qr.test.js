import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qrMatrix, qrSvg, formatBits, versionBits, _rs} from '../public/js/qr.js';

test('Reed–Solomon matches the HELLO WORLD 1-M example', ()=>{
  assert.deepEqual(_rs([32,91,11,120,209,114,220,77,67,64,236,17,236,17,236,17],10),[196,35,39,119,235,215,231,226,93,23]);
});

test('format and version information match the published tables', ()=>{
  const M=['101010000010010','101000100100101','101111001111100','101101101001011','100010111111001','100000011001110','100111110010111','100101010100000'];
  M.forEach((s,mask)=>assert.equal(formatBits(mask),parseInt(s,2),`mask ${mask}`));
  assert.deepEqual([7,8,9,10].map(versionBits),[0x07C94,0x085BC,0x09A99,0x0A4D3]);
});

test('picks the smallest version that fits, up to 213 bytes', ()=>{
  const fits=[[14,1],[15,2],[26,2],[27,3],[42,3],[43,4],[62,4],[63,5],[84,5],[85,6],[106,6],[107,7],[122,7],[123,8],[152,8],[153,9],[180,9],[181,10],[213,10]];
  for(const [len,v] of fits) assert.equal(qrMatrix('x'.repeat(len)).version,v,`${len} bytes`);
  assert.equal(qrMatrix('x'.repeat(214)),null);
  assert.equal(qrSvg('x'.repeat(214)),'');
  assert.equal(qrMatrix('€'.repeat(5)).version,2); // counts UTF-8 bytes, not characters
});

test('function patterns sit where scanners look for them', ()=>{
  for(const v of [1,4,7,10]){
    const len=[0,14,0,0,62,0,0,122,0,0,213][v], q=qrMatrix('a'.repeat(len)), n=q.size;
    assert.equal(n,17+4*v);
    // Finder: dark ring, light ring, dark 3×3 core, then a light separator.
    for(const [ox,oy] of [[0,0],[n-7,0],[0,n-7]])
      for(let y=-1;y<=7;y++) for(let x=-1;x<=7;x++){
        const X=ox+x, Y=oy+y; if(X<0||Y<0||X>=n||Y>=n) continue;
        const d=Math.max(Math.abs(x-3),Math.abs(y-3));
        assert.equal(q.get(X,Y),d!==2&&d!==4,`finder v${v} at ${X},${Y}`);
      }
    for(let i=8;i<n-8;i++){assert.equal(q.get(i,6),i%2===0); assert.equal(q.get(6,i),i%2===0);}
    assert.equal(q.get(8,n-8),true,'dark module');
    // Both copies of the format information agree with the mask used.
    const fb=formatBits(q.mask), bit=i=>((fb>>>i)&1)===1;
    const a=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    const b=[...Array.from({length:8},(_,i)=>[n-1-i,8]),...Array.from({length:7},(_,i)=>[8,n-7+i])];
    a.forEach(([x,y],i)=>assert.equal(q.get(x,y),bit(i),`format copy 1 bit ${i}`));
    b.forEach(([x,y],i)=>assert.equal(q.get(x,y),bit(i),`format copy 2 bit ${i}`));
  }
});

test('every forced mask gives a different, complete matrix', ()=>{
  const seen=new Set();
  for(let mask=0;mask<8;mask++){
    const q=qrMatrix('http://192.168.1.20:8080/#/keypad/K7QM/aZ09_-aZ09_-aZ09',{mask});
    assert.equal(q.mask,mask);
    let s=''; for(let y=0;y<q.size;y++) for(let x=0;x<q.size;x++) s+=q.get(x,y)?1:0;
    seen.add(s);
  }
  assert.equal(seen.size,8);
});

test('the SVG draws every dark module inside a quiet zone', ()=>{
  const text='https://example.com/darts/#/keypad/K7QM/abcdefghijklmnop', q=qrMatrix(text), svg=qrSvg(text);
  assert.match(svg,new RegExp(`viewBox="0 0 ${q.size+8} ${q.size+8}"`));
  let drawn=0; for(const m of svg.matchAll(/M(\d+) (\d+)h(\d+)/g)){ assert.ok(+m[1]>=4&&+m[2]>=4); drawn+=+m[3]; }
  let dark=0; for(let y=0;y<q.size;y++) for(let x=0;x<q.size;x++) if(q.get(x,y)) dark++;
  assert.equal(drawn,dark);
});
