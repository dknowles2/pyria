# Pyria Game Server

Lightweight zero-dependency **Python 3 stdlib + SQLite** HTTP server that serves the browser RPG (`web/`), engine-agnostic JSON content (`content/`), pixel-art assets (`assets/`), and a REST API for hero saves and trial attempt analytics.

## Run Locally (macOS / Linux)

```bash
python3 server/app.py --host 127.0.0.1 --port 8080
```

Then open [http://127.0.0.1:8080](http://127.0.0.1:8080).

### CLI Flags
- `--host` (default: `127.0.0.1`)
- `--port` (default: `8080`)
- `--root` (default: repo root `..`)
- `--db` (default: `<root>/data/pyria.sqlite3`)

## Run Automated Tests

```bash
python3 -m unittest server/test_server.py
```

## REST API
- `GET /api/health` — server health, DB path, and save count
- `GET /api/config` — freshly reads `content/game.json` and `content/catalog.json`
- `GET /api/saves` — list saved heroes (`updated_at DESC`)
- `POST /api/saves` — create a new hero save (`201`)
- `GET /api/saves/<id>` — load a save (`404` if missing)
- `PUT /api/saves/<id>` — update hero state (`200`)
- `DELETE /api/saves/<id>` — remove a save (`200`)
- `POST /api/saves/<id>/attempts` — log a trial attempt (`201`)
- `GET /api/saves/<id>/attempts` — list trial attempts for parent progress insights

## Deploy to `elzar` (Debian 13) + Cloudflare Tunnel

1. One-time host setup on `elzar`:
   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin pyria || true
   sudo mkdir -p /opt/pyria /var/lib/pyria
   sudo chown -R pyria:pyria /opt/pyria /var/lib/pyria
   ```
2. Sync files from your workstation:
   ```bash
   ./server/deploy_elzar.sh
   ```
3. Install & enable systemd unit on `elzar`:
   ```bash
   sudo cp /opt/pyria/server/pyria.service /etc/systemd/system/pyria.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now pyria.service
   ```
4. Expose privately/publicly via **Cloudflare Tunnel** (`cloudflared`) pointing your hostname ingress rule to `http://127.0.0.1:8080` — the server binds to `127.0.0.1` by default so it is never directly exposed on LAN/WAN without the tunnel.
