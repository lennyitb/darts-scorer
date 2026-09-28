/* Admin tasks from the shell:
     node server/cli.js create-admin <username>
     node server/cli.js reset-password <username>
     node server/cli.js backup [file]
     node server/cli.js rebuild
   In Docker: docker compose exec -T darts-scorer node server/cli.js create-admin alice */
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync, existsSync} from 'node:fs';
import {openDb, tx, nameKey} from './db.js';
import {hashPassword, tempPassword, validUsername, endSessions} from './auth.js';
import {rebuildAll} from './games.js';

const dataDir=process.env.DATA_DIR||join(dirname(fileURLToPath(import.meta.url)),'..','data');
mkdirSync(dataDir,{recursive:true});
const [cmd,arg]=process.argv.slice(2);
const die=m=>{console.error(m); process.exit(1);};
const db=openDb(join(dataDir,'darts.db'));

switch(cmd){
  case 'create-admin':{
    const username=(arg||'').normalize('NFC').trim();
    if(!validUsername(username)) die('Usage: create-admin <username>  (2 to 32 letters, numbers, dots, dashes or underscores)');
    if(db.prepare('SELECT 1 FROM accounts WHERE username_key=?').get(nameKey(username))) die(`${username} already exists. Use reset-password to get back in.`);
    const password=tempPassword();
    db.prepare('INSERT INTO accounts(username,username_key,pw_hash,is_admin,must_change_pw,created_at) VALUES (?,?,?,1,1,?)')
      .run(username,nameKey(username),await hashPassword(password),Date.now());
    console.log(`Created admin ${username} with temporary password:\n\n  ${password}\n\nSign in with it and you'll be asked to choose your own.`);
    break;
  }
  case 'reset-password':{
    const a=db.prepare('SELECT * FROM accounts WHERE username_key=?').get(nameKey(arg||''));
    if(!a) die(`No account called ${arg||'(none given)'}`);
    const password=tempPassword(), hash=await hashPassword(password);
    tx(db,()=>{ db.prepare('UPDATE accounts SET pw_hash=?,must_change_pw=1,disabled=0 WHERE id=?').run(hash,a.id); endSessions(db,a.id); });
    console.log(`New temporary password for ${a.username}${a.disabled?' (account re-enabled)':''}:\n\n  ${password}\n`);
    break;
  }
  case 'backup':{
    const stamp=new Date().toISOString().replace(/[:T]/g,'-').slice(0,19);
    const file=resolve(arg||join(dataDir,`backup-${stamp}.db`));
    if(existsSync(file)) die(`${file} already exists`);
    db.prepare('VACUUM INTO ?').run(file);
    console.log(`Backed up to ${file}`);
    break;
  }
  case 'rebuild':{
    const bad=rebuildAll(db);
    for(const b of bad) console.log(`Game ${b.id} no longer replays: ${b.error}`);
    console.log(`Rebuilt stats and ratings${bad.length?`; ${bad.length} game(s) left as they were`:''}.`);
    break;
  }
  default:
    die('Commands: create-admin <username> | reset-password <username> | backup [file] | rebuild');
}
db.close();
