# F the Bus

The F the Bus drinking game, built for phones. Three modes:

- **Classic**: red or black, higher or lower, inside or outside, then the suit. Every miss is 1 drink and passes the bus to the next player.
- **Higher or Lower**: a free start card, then 3 higher-or-lower calls in a row to get off.
- **Horse Race**: bet drinks on one of the four aces and flip cards to race them up the track.

There are two versions:

| | Where | How people play |
|---|---|---|
| Pass-and-play | `index.html`, served by GitHub Pages at https://boddard.github.io/CrossRiver/ | One phone, passed around |
| Online | `server/` + `public/index.html`, run on your own server | Everyone on their own phone, in a room with a 4-letter code |

## Online version

The Node.js server holds every room's state and does all the dealing, so nobody can see face-down cards early. Phones connect over WebSockets.

- The person who creates a room is the host: they pick the mode and settings, and get **Menu**, **Restart** and **Skip** (for a rider whose phone has dropped).
- Everyone sees cards flip live. Only the rider's phone shows the guess buttons.
- In Horse Race each player sets their own bet on their phone, and anyone can flip.
- A phone that locks or loses signal rejoins its seat automatically. If the host drops, the next online player becomes host.
- Rooms are cleared 30 minutes after everyone has left, or after 6 hours idle.

### Install on the server with a Cloudflare Tunnel (recommended)

Cloudflare serves the game over HTTPS on your own hostname. The server needs no open ports, nginx or certificates.

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels**, create a **Cloudflared** tunnel, and copy the token from the install command it shows (the long string after `--token` or `service install`).
2. Add a **public hostname** to the tunnel, for example `bus` on `b21g.com`, with service type **HTTP** and URL `http://localhost:3100`.
3. On the server, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/boddard/CrossRiver/main/deploy/setup.sh -o setup.sh
bash setup.sh tunnel PASTE_TOKEN_HERE
```

To update later: `bash /opt/crossriver/deploy/setup.sh`

### Or install with nginx

On the Ubuntu server, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/boddard/CrossRiver/main/deploy/setup.sh -o setup.sh
bash setup.sh bus.b21g.com you@example.com
```

- Replace `bus.b21g.com` with the domain you want. Add a DNS **A record** for it pointing at the server's IP first.
- The email is for the free Let's Encrypt HTTPS certificate. Leave it off for plain HTTP.
- With no arguments at all (`bash setup.sh`), the game runs at `http://SERVER-IP:3100`.

The script installs Node.js 20, puts the code in `/opt/crossriver`, runs it as a systemd service (`crossriver`) under its own user, and sets up an nginx site (with WebSocket support) plus HTTPS.

### Update after a new push

```bash
bash /opt/crossriver/deploy/setup.sh                                  # tunnel installs
bash /opt/crossriver/deploy/setup.sh bus.b21g.com you@example.com     # nginx installs
```

It pulls the latest `main`, reinstalls dependencies and restarts the service.

### Useful commands

```bash
systemctl status crossriver        # is it running?
journalctl -u crossriver -f        # live logs
curl http://127.0.0.1:3100/healthz # "ok N rooms"
```

### Run it locally

```bash
npm install
npm start            # http://localhost:3000
```

`PORT` and `HOST` environment variables change where it listens.
