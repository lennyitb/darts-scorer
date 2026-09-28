/* Tiny HTTP helpers shared by the server modules. */
export class HttpError extends Error {
  constructor(status,message,extra){super(message);this.status=status;this.extra=extra;}
}

export function readBody(req,limit=256*1024){
  return new Promise((ok,bad)=>{
    const chunks=[]; let size=0;
    req.on('data',c=>{size+=c.length; if(size>limit){bad(new HttpError(413,'Request body too large')); req.destroy();} else chunks.push(c);});
    req.on('end',()=>ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error',bad);
  });
}

export async function readJson(req){
  const raw=await readBody(req);
  if(!raw) return {};
  try{ return JSON.parse(raw); }catch(e){ throw new HttpError(400,'Body must be JSON'); }
}
