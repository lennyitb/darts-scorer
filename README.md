# Darts scorer

A scoreboard for x01 darts (301, 501, 701) that runs in the browser. One static
page served by unprivileged nginx in a container.

- 1 to 6 players, single leg or first to 2–5 legs, with the starting player
  rotating each leg
- Double out and double in, each toggled on or off
- Two ways to enter scores: type the turn total, or tap each dart
  (single/double/treble × segment)
- Checkout suggestions for any finish up to 170, updated after each dart
- Catches busts and impossible totals (163, 166, 169, 172, 173, 175, 176, 178,
  179, and anything over 180)
- Undo, plus stats per player: 3-dart average, best turn, 100+/140+/180
  counts, highest checkout
- Keyboard entry: digits, <kbd>Enter</kbd>, <kbd>Backspace</kbd>,
  <kbd>Esc</kbd>, <kbd>U</kbd> or <kbd>Ctrl/⌘+Z</kbd> to undo
- Light and dark themes follow the system setting

The game is saved in `localStorage`, so a reload or a closed tab picks up
where you left off. Nothing leaves the browser, and there is no backend.

## Run it

```sh
docker compose up -d --build
```

Then open <http://127.0.0.1:8080>. To use a different port or reach it from
the LAN without a proxy, copy `.env.example` to `.env` and edit it.

Without Docker, open `public/index.html` straight from disk.

## Behind a reverse proxy

Every asset path in the page is relative, so the app works under a subpath
with no rewriting. nginx example for `https://example.com/darts/`:

```nginx
location = /darts {
    return 301 /darts/;
}

location /darts/ {
    proxy_pass http://127.0.0.1:8080/;
}
```

The redirect matters: without the trailing slash, the browser resolves
`favicon.svg` against the parent path.

## Layout

| Path | What it is |
| --- | --- |
| `public/index.html` | The whole app: markup, styles, and script |
| `public/favicon.svg` | Tab icon |
| `nginx.conf` | Server config inside the container, with a `/healthz` endpoint |
| `Dockerfile` | `nginx-unprivileged` image with a healthcheck |
| `compose.yaml` | Read-only root filesystem, no capabilities, loopback-bound port |

## Updating

```sh
git pull
docker compose up -d --build
```
