/* SQLite via node:sqlite. Migrations run in order and are tracked with PRAGMA user_version. */
import {DatabaseSync} from 'node:sqlite';

const MIGRATIONS=[
`CREATE TABLE players(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  hidden INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 1500,
  created_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES accounts(id)
);
CREATE TABLE accounts(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  player_id INTEGER REFERENCES players(id),
  created_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES accounts(id)
);
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE TABLE games(
  id TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES accounts(id),
  start INTEGER NOT NULL,
  double_in INTEGER NOT NULL,
  double_out INTEGER NOT NULL,
  legs_to_win INTEGER NOT NULL,
  starter_seat INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress','finished','abandoned','void')),
  rev INTEGER NOT NULL,
  log TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  winner_player_id INTEGER REFERENCES players(id)
);
CREATE INDEX games_started ON games(started_at);
CREATE INDEX games_status ON games(status, finished_at);
CREATE TABLE game_players(
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seat INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  legs_won INTEGER NOT NULL DEFAULT 0,
  place INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(game_id, seat),
  UNIQUE(game_id, player_id)
);
CREATE INDEX game_players_player ON game_players(player_id);
CREATE TABLE legs(
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  leg INTEGER NOT NULL,
  starter_seat INTEGER NOT NULL,
  winner_seat INTEGER,
  winner_darts INTEGER,
  checkout INTEGER,
  PRIMARY KEY(game_id, leg)
);
CREATE TABLE visits(
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  leg INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  round INTEGER NOT NULL,
  before INTEGER NOT NULL,
  points INTEGER NOT NULL,
  darts INTEGER NOT NULL,
  bust INTEGER NOT NULL,
  checkout INTEGER NOT NULL,
  finishable INTEGER NOT NULL,
  detail TEXT,
  PRIMARY KEY(game_id, leg, idx)
);
CREATE INDEX visits_player ON visits(player_id);
CREATE TABLE ratings(
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id),
  before REAL NOT NULL,
  after REAL NOT NULL,
  PRIMARY KEY(game_id, player_id)
);
CREATE INDEX ratings_player ON ratings(player_id);`,
];

export function openDb(file){
  const db=new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
  const {user_version:v}=db.prepare('PRAGMA user_version').get();
  for(let i=v;i<MIGRATIONS.length;i++) tx(db,()=>{db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version=${i+1}`);});
  return db;
}

// Runs fn inside a write transaction; node:sqlite has no helper for this.
export function tx(db,fn){
  db.exec('BEGIN IMMEDIATE');
  try{ const r=fn(); db.exec('COMMIT'); return r; }
  catch(e){ db.exec('ROLLBACK'); throw e; }
}

// Trimmed, single-spaced, NFC, lower case: "Bob", " bob " and "BOB" collide.
export const nameKey=s=>String(s).normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();
