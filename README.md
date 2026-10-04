# Darts scorer

A scoreboard for x01 darts (301, 501, 701) that runs in the browser, with
ranked games, history and stats kept on a small server. One Node process with
no dependencies, in an unprivileged container.

- 1 to 6 players, single leg or first to 2–5 legs, with the starting player
  rotating each leg
- Set the throwing order by dragging players by their handles in the
  new-game sheet, or with the arrow keys on a focused handle
- Double out and double in, each toggled on or off
- Two ways to enter scores: type the turn total, or tap each dart
  (single/double/treble × segment)
- Checkout suggestions for any finish up to 170, updated after each dart
- Catches busts and impossible totals (163, 166, 169, 172, 173, 175, 176, 178,
  179, and anything over 180), and only offers dart counts a checkout could
  really take
- Undo, plus stats per player: 3-dart average, best turn, 100+/140+/180
  counts, highest checkout
- Keyboard entry: digits, <kbd>Enter</kbd>, <kbd>Backspace</kbd>,
  <kbd>Esc</kbd>, <kbd>U</kbd> or <kbd>Ctrl/⌘+Z</kbd> to undo
- Big screen mode: show the scoreboard large on a computer or TV and enter
  scores from phones
- Light and dark themes follow the system setting

The game in progress is saved in `localStorage`, so a reload or a closed tab
picks up where you left off.

## Ranked games, history and stats

Casual games work as they always have: anyone can play, and nothing leaves
the browser. Switch on **Ranked** in the new-game sheet to save the game to
the server, where it counts toward history, stats and ratings.

| Role | Can |
| --- | --- |
| Player | Appear in games. A name on the roster, with no login |
| Account holder | Sign in, start ranked games with any players, add players |
| Admin | Also create accounts, appoint or remove admins, reset passwords, disable accounts, void games, rename or hide players |

Nobody can sign themselves up: admins create accounts and hand over a
temporary password, which has to be changed at first sign-in. History and
stats are public to anyone who can reach the app.

A ranked game is saved after every turn. If the server can't be reached, the
game keeps going and the changes queue up in the browser until it can. The
server replays every saved game with the same scoring rules as the scorer,
so it only stores games that could really have been played.

- **History** lists ranked games, with a page per game: stats, legs, and
  every visit.
- **Players** is a leaderboard sorted by an Elo rating, and each player has
  a page with career stats, their rating over time, and head-to-head records.
- **Ratings** come from finished ranked games whatever the rules. Each pair of
  players in a game counts as a match decided by legs won, scaled down in
  bigger games. Voiding a game recalculates everyone's rating.
- **Checkout stats** (top out, out %, best legs) are split by straight out and
  double out, and never mixed. Out % is checkouts per visit that started on a
  score that could be finished.
- An unfinished ranked game counts as abandoned when someone starts a new
  one, or after a day without a turn. Abandoned games don't count.

## Big screen and phone keypad

On the computer or TV that will show the scores, tap **Big screen**, then
**Use this screen as the scoreboard**. The scoreboard fills the window and a
pairing card shows a QR code and a 4-character code. Scan the QR code with a
phone's camera, or open the app on the phone, tap **Big screen**, choose **Use
this device as a keypad** and type the code. Several phones can join the same
screen.

- The big screen runs the game, as the scorer always does: setup, undo and
  ranked saving all happen there, under whoever is signed in on it. Phones only
  send what was thrown, then show the board the big screen sends back.
- Phones get the same keypad as the scorer: turn totals or dart by dart, the
  checkout question, and next leg, rematch and undo checkout once a leg is won.
  New games are set up on the big screen.
- If two phones enter at once, only the first entry counts. The other phone is
  told the board changed, so the same turn can't be entered twice.
- A reload of either page picks up where it left off, and so does a server
  restart. The big screen keeps its code, and phones reconnect by themselves.
- **Disconnect phones** gives the big screen a new code, so anyone still holding
  the old one is out. Opening the big screen in a second tab moves it there,
  and the first tab offers to take it back.
- The QR code links to the address the big screen's page was opened at, so
  open it at the address phones use too, normally your proxy's public URL.
  Phones then connect from any network. On `localhost` or `127.0.0.1` the link
  would point phones at themselves, and the pairing card warns about that.
- Over HTTPS, both pages keep their screens awake while in use. Browsers only
  allow that on secure pages.

## Run it

```sh
docker compose up -d --build
```

Then create the first admin. This prints a temporary password:

```sh
docker compose exec -T darts-scorer node server/cli.js create-admin <username>
```

Open <http://127.0.0.1:8080> and sign in. To use a different port or reach it
from the LAN without a proxy, copy `.env.example` to `.env` and edit it.

Without Docker, you need Node 22.13 or later. There is nothing to install:

```sh
npm start
```

Data goes in `data/` next to the code, or wherever `DATA_DIR` points.
Opening `public/index.html` straight from disk no longer works, because
browsers won't load its modules over `file://`.

### Admin commands

| Command | Does |
| --- | --- |
| `node server/cli.js create-admin <username>` | Creates an admin with a temporary password |
| `node server/cli.js reset-password <username>` | Issues a new temporary password, re-enables the account, and signs it out everywhere |
| `node server/cli.js backup [file]` | Writes a consistent copy of the database (default: `/data/backup-<time>.db`) |
| `node server/cli.js rebuild` | Replays every saved game and recalculates stats and ratings |

In Docker, run each one with `docker compose exec -T darts-scorer` in front.
Everything lives in the `darts-data` volume as one SQLite file.

## Behind a reverse proxy

Every path in the page is relative, including the API, so the app works under
a subpath with no rewriting. nginx example for `https://example.com/darts/`:

```nginx
location = /darts {
    return 301 /darts/;
}

location /darts/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

The redirect matters: without the trailing slash, the browser resolves
`favicon.svg` and `api/` against the parent path. Big screen mode keeps an
event stream open to `api/remote/events`. That needs nothing extra in nginx:
the server turns off proxy buffering for it with `X-Accel-Buffering: no`, and
sends a heartbeat every 25 seconds, well inside the default 60-second read
timeout. `X-Forwarded-Proto` lets the
server mark the sign-in cookie `Secure` over HTTPS. Without it, set
`COOKIE_SECURE=1` in `.env`. The cookie has no fixed path, so the browser keeps
it to the app's own `api/` path.

## Layout

| Path | What it is |
| --- | --- |
| `public/index.html` | Page shell |
| `public/styles.css` | Styles |
| `public/js/scoring.js` | x01 rules and log replay, shared by the scorer and the server |
| `public/js/game.js` | Scorer state and moves, without the DOM |
| `public/js/scorer.js` | Scoreboard, number pad, new-game sheet, and big screen mode |
| `public/js/board.js` | Scoreboard markup shared by the scorer, the big screen and the keypad |
| `public/js/keypad.js`, `public/js/remote.js` | The phone keypad, and the link between it and the big screen |
| `public/js/qr.js` | QR code encoder for the pairing link |
| `public/js/app.js`, `public/js/views/` | Routing, sign-in, History, Players, and Admin pages |
| `public/js/api.js` | API calls and the queue of unsaved ranked games |
| `server/index.js` | HTTP server: static files, JSON API, `/healthz` |
| `server/games.js`, `server/stats.js` | Saving and reading games; stats and Elo |
| `server/remotes.js` | Relay between a big screen and its phones, kept in memory |
| `server/auth.js`, `server/db.js`, `server/cli.js` | Accounts and sessions, SQLite schema, admin commands |
| `test/` | `npm test`, using Node's built-in test runner |
| `Dockerfile` | `node:24-alpine`, running as the `node` user, with a healthcheck |
| `compose.yaml` | Read-only root filesystem, no capabilities, loopback-bound port, data volume |

## Updating

```sh
git pull
docker compose up -d --build
```

The database schema migrates itself on startup.

## License

[MIT](LICENSE)
