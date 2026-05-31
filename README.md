# steel-broker

Run **many browser agents in one Chrome** — each in its own isolated window, all
sharing one logged-in profile, each with a live view/takeover link you can open
in a browser.

It's a tiny sidecar (one Node file) you put in front of a single
[Steel](https://github.com/steel-dev/steel-browser) browser. One CDP endpoint in,
N isolated windows out.

```
                       ┌────────────────────────────┐
  agent A ─ /cdp ──▶   │  one Chrome, one profile    │
  agent B ─ /cdp ──▶   │  ┌────────┐ ┌────────┐      │   shared cookies/logins
  agent C ─ /cdp ──▶   │  │window A│ │window B│ ...   │   isolated windows
                       │  └────────┘ └────────┘      │
   you ─ /v/<lease> ─▶ │   live view + click/type    │
                       └────────────────────────────┘
```

## Why

You want several agents driving a browser at once, **sharing one logged-in
identity** (same cookies, same sessions), but **without stepping on each other**.

The obvious approach — one browser *context* per agent — gives isolation but
splits the cookie jar, so every agent would be logged out. steel-broker keeps a
**single Chrome with one shared profile** and isolates agents at the *window*
level instead, by filtering CDP's Target domain per connection. You get shared
identity **and** non-colliding agents — plus a per-window viewer for humans to
watch or take over.

## Quick start

```bash
git clone … steel-broker && cd steel-broker
docker compose up -d
```

- **Agents** connect a CDP client to `ws://127.0.0.1:3030/cdp`.
  **One connection = one fresh, isolated window.**
- **Humans** open `http://127.0.0.1:3030/` to list windows, spawn new ones, and
  grab a `/v/<lease>` link — a live view with click/type takeover, one per window.

Try it:

```bash
npm i playwright-core
node examples/playwright.mjs      # two agents, two windows, shared cookies
```

### Already running Steel?

Skip the bundled Chrome and add just the broker to your compose:

```yaml
  broker:
    image: ghcr.io/zcag/steel-broker:latest   # or build: ./broker
    network_mode: "service:steel-api"   # ← share your Steel container's netns
    environment:
      - CHROME=localhost:9222
      - PORT=3030
    depends_on: [steel-api]
```

Then publish port `3030` **on your Steel service** (not the broker — see below).

## How agents connect

Any CDP client works. Playwright:

```js
const browser = await chromium.connectOverCDP("http://127.0.0.1:3030/cdp");
const page = browser.contexts()[0].pages()[0];   // your own window, no one else's
```

For Claude / an MCP setup, point the Playwright MCP at the same endpoint:

```bash
npx @playwright/mcp@latest --cdp-endpoint ws://127.0.0.1:3030/cdp
```

One MCP process = one window. Run separate processes (or sessions) for separate
windows. Tabs opened *within* a window stay grouped under that agent.

## Endpoints

| Endpoint | Who | What |
|---|---|---|
| `ws://host:3030/cdp` | agents | CDP; 1 connection = 1 isolated window |
| `http://host:3030/` | humans | list windows, spawn, get viewer links |
| `http://host:3030/v/<lease>` | humans | live viewer + click/type takeover |
| `GET /windows` | — | list current windows |
| `POST /spawn {url?}` | — | open + lease a fresh window → `{leaseId, viewer}` |
| `POST /lease {targetId}` | — | get a viewer link for an existing window |
| `DELETE /lease/:id` | — | close the window |

## Configuration

Broker (env):

| Var | Default | Meaning |
|---|---|---|
| `CHROME` | `localhost:9222` | Chrome CDP host:port (reachable via shared netns) |
| `PORT` | `3030` | broker port |
| `IDLE_TTL_MS` | `900000` | close orphaned windows after this idle time |
| `SCREENCAST_QUALITY` | `75` | viewer JPEG quality |
| `SCREENCAST_MAXW` / `SCREENCAST_MAXH` | `1920` / `1080` | viewer resolution |

Stack (`compose.yml`): `BIND_ADDR` (default `127.0.0.1`) for which interface the
ports bind to. Point it at a tailnet/LAN IP for remote access.

## ⚠️ Isolation is anti-collision, not security

All windows share **one cookie jar and one identity**. That's the whole point —
but it means anyone with a window (or a view link) has every logged-in session.
This is **not** a multi-tenant sandbox for untrusted users. Bind it to a trusted
network only; don't put it on the public internet. (If you want *separate*
identities per agent, you want a browser-context-per-agent design instead — the
opposite of this tool.)

## How it works / Gotchas

The reusable knowledge, in case you're building something similar:

- **`network_mode: "service:<chrome>"`** — the broker runs in Chrome's network
  namespace so it reaches CDP at `localhost:9222`. Chrome binds DevTools to
  127.0.0.1 only and rejects non-localhost Host headers; sharing the netns sidesteps
  all of it. *Consequence:* a netns-sharing container can't publish its own ports —
  the broker's `3030` is published on the **Chrome service**.
- **Per-connection window + Target-domain filter** — each `/cdp` connection opens
  its own window (`Target.createTarget {newWindow:true}`) and the broker filters
  Chrome's browser-level Target events so the client only ever sees/drives that one
  window (plus its iframe/worker child sessions). This is what gives isolation
  *without* separate contexts — so the cookie jar stays shared.
- **CDP needs TEXT frames** — forwarding a Buffer makes `ws` send a binary frame,
  which Chrome silently drops (socket closes `1006`). Always stringify.
- **Rewrite `Target.setAutoAttach` → `waitForDebuggerOnStart:false`** — otherwise a
  hidden foreign target stays paused forever (nobody downstream resumes it) and
  stalls the whole browser.
- **Per-window viewer** — the viewer page is Steel's own player template
  (`broker/player.ejs`, vendored), rendered with a window-scoped WebSocket URL.
  `?tabInfo=true` lists only that window's tabs; `?pageId=` screencasts one page.
  `Target.activateTarget` (bring-to-front) keeps frames flowing,
  `Page.setDeviceMetricsOverride` makes the image crisp and clicks land 1:1.
- **`SKIP_FINGERPRINT_INJECTION=true`** — Steel's stealth fingerprint generator
  crash-loops browser launch; turn it off (fine when driving your own accounts).

## License

MIT (this code). The bundled `broker/player.ejs` is Steel's, Apache-2.0 — see
[NOTICE](NOTICE).
