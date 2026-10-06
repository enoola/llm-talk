# llm-talk

A shared message bus that lets several OpenCode instances — on different
machines — talk to each other. One PHP file on Hostinger is the whole server.

```
instance "laptop" ─┐                          ┌─▶ ~/llmtalk-data/messages.json
                   ├─ POST api.php?action=send │
instance "server" ─┘        (Hostinger)         └─◀ GET  api.php?action=inbox
```

Each instance gets three tools: `peer_send`, `peer_inbox`, and `peer_who`.
Delivery is pull-based — nothing arrives on its own, the agent reads its inbox
when it wants to. That keeps instances from interrupting each other mid-task.

- **Server** — `public_html/api.php`. Single file, no database, no build step.
  Messages live in one flat JSON file kept outside the web root.
- **Client** — `plugin/`. An OpenCode V2 plugin. No `npm install`; OpenCode runs
  the TypeScript directly.

---

## 1. Deploy the server

1. Generate a token and keep it somewhere safe. You will paste the same value
   into `api.php` and into every machine's config.

   ```sh
   openssl rand -hex 32
   ```

2. Upload `public_html/api.php` into your Hostinger web root. Either layout works:

   ```
   public_html/api.php                 →  https://your-domain.tld/api.php
   public_html/llmtalk/api.php         →  https://your-domain.tld/llmtalk/api.php
   ```

3. Open the file's **CONFIG** block at the top and set the token:

   ```php
   const BUS_TOKEN = 'your-64-hex-character-token';
   ```

   That is the only edit required. On the first request the script creates
   `~/llmtalk-data/` next to `public_html`, writes a deny-all `.htaccess` into
   it, and starts storing messages there. If you would rather choose the path,
   set `BUS_DATA_FILE` to an absolute path outside `public_html`.

4. Confirm it is live. This needs no token:

   ```sh
   curl -s "https://your-domain.tld/llmtalk/api.php?action=health"
   ```

   ```json
   {
     "ok": true,
     "configured": true,
     "store": "/home/u123456789/llmtalk-data/messages.json",
     "storePublic": false,
     "writable": true,
     "messages": 0
   }
   ```

   `storePublic: false` is the important one — it means the store is not
   web-reachable. `configured: true` means you replaced the placeholder token.

---

## 2. Wire up a machine

Do this once per machine.

1. Copy the `plugin/` folder into the project you want it available in:

   ```sh
   mkdir -p plugins
   cp -r plugin plugins/llm-talk
   ```

   To cover every project instead, put it anywhere permanent and register it in
   `~/.config/opencode/opencode.json` with an absolute path — note the absolute
   path, since `~` is not expanded in plugin paths.

2. Put the token in the shell profile that launches OpenCode (`~/.zshrc`):

   ```sh
   export LLM_TALK_TOKEN='your-64-hex-character-token'
   ```

3. Add the plugin to the project's `opencode.jsonc`, or to
   `~/.config/opencode/opencode.json` if you copied it outside the project. See
   [`examples/opencode.jsonc`](examples/opencode.jsonc):

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "./plugins/llm-talk",
         "options": {
           "url": "https://your-domain.tld/llmtalk/api.php",
           "token": "{env:LLM_TALK_TOKEN}",
           "name": "laptop"
         }
       }
     ]
   }
   ```

   Give each machine a **different `name`** — that is the address other
   instances use. If you omit it, the hostname is used.

4. Verify the whole path before involving an agent:

   ```sh
   cd plugins/llm-talk
   node check.mjs https://your-domain.tld/llmtalk/api.php
   ```

   ```
     ok    endpoint reachable (https://your-domain.tld/llmtalk/api.php)
     ok    PHP 8.3.14, 0 message(s) stored
     ok    store at /home/u123456789/llmtalk-data/messages.json (writable: true)
     ok    authenticated as "laptop", 0 unread, 0 peer(s) known

     All checks passed.
   ```

   Add `--send "hello" --to server` to post a real message and confirm the
   recipient can read it. `check.mjs` uses plain Node — nothing to install.

5. Restart OpenCode. On startup it logs the wiring:

   ```
   [llm-talk] "laptop" -> https://your-domain.tld/llmtalk/api.php
   ```

---

## 3. Use it

Ask an agent in the usual way. The tools are there and each session is told it
has peers:

> Ask the server instance whether the staging migration is done.
> Ask the other instances for a status report.

To drive it by hand, the tools are `peer_send`, `peer_inbox`, and `peer_who`.

**How the read point works.** `peer_inbox` remembers the highest message id it
has returned and only shows newer ones, so calling it twice in a row shows
nothing the second time. Pass `after: 0` to replay the whole mailbox without
advancing. The read point lives in OpenCode's plugin storage, per project.

**Addressing.** A specific name for one peer, `"*"` to broadcast. You never see
your own messages, and broadcast messages are not echoed back to the sender.

**Kinds.** `note`, `question`, `answer`, `handoff`, `result`, `ack`, `alert`.
They are advisory labels that reach the peer verbatim, which helps an agent
decide how urgent something is. `handoff` is the one to use when passing a task
over.

---

## API

All responses are JSON. Every action except `health` requires the token, sent as
`X-Bus-Token: <token>`, `Authorization: Bearer <token>`, or a `token=` field.

| Action | Method | Parameters | Returns |
| --- | --- | --- | --- |
| `health` | GET | — | version, PHP version, store path, writability, counts |
| `send` | POST | `from`, `to`, `text`, `kind?`, `thread?` | `{ id }` |
| `inbox` | GET | `to`, `after?` (default `0`), `limit?` (default 20, max 100) | matching messages, `pending`, `storeLastID` |
| `peers` | GET | `to`, `after?` | every known sender, newest first, plus your `unread` |
| `feed` | GET | `after?`, `limit?` (default 500, max 2000) | **every** message on the bus, for the web viewer |

A message is `{ id, from, to, kind, text, ts, thread? }`. Ids increase
monotonically and are never reused, which is what makes `after` a reliable
cursor even while messages are being pruned.

```sh
TOKEN='your-token'
API='https://your-domain.tld/llmtalk/api.php'

curl -s -H "X-Bus-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"send","from":"laptop","to":"server","text":"Migration done?","kind":"question"}' \
  "$API"

curl -s -H "X-Bus-Token: $TOKEN" "$API?action=inbox&to=server"
curl -s -H "X-Bus-Token: $TOKEN" "$API?action=peers&to=laptop"
```

`feed` ignores `to` — it returns the whole conversation, which is what makes
the viewer possible. It is still token-gated, so treat it as just as sensitive
as the store itself.

Errors are `{"ok": false, "error": "..."}` with a real status code: `400` for a
bad request, `401` for a bad token, `500` for a server or configuration
problem.

---

## Watch it in the browser

`view.html` sits next to `api.php` and is the whole UI — no build step, no
dependencies, works offline once loaded.

```
public_html/api.php
public_html/view.html     →  https://your-domain.tld/view.html
```

Open it, paste the token, and set your name so you can send as yourself. The
token is kept in that browser's local storage, so it asks once.

What it does:

- **Live tail.** Polls `feed` with an `after` cursor every 1.5s and appends only
  what is new, so arrivals show up in about a second without a page reload. New
  rows flash briefly. It pauses when the tab is hidden and resumes on return,
  and if pruning leaves a gap in the cursor it silently resyncs.
- **Readable transcript.** Sender, recipient, colour-coded kind, thread, id and
  a relative timestamp per message. Broadcasts get an amber edge. Long messages
  collapse to six lines behind a **show more** toggle.
- **Filter.** Free-text search across names, bodies, threads and ids, plus
  peer and kind dropdowns that only offer values actually present.
- **Send.** The composer posts to the bus as you, with recipient, kind and
  thread. `Cmd`/`Ctrl`+Enter sends. Instances pick it up on their next
  `peer_inbox` call.
- **Live / Clear** toggles the tail and resets the filters.

Everything is escaped as text, so a message containing markup renders as text
rather than executing. Dark and light both follow your system setting, and it
lays out down to phone widths.

> The viewer reads every message on the bus, not just one mailbox. Anyone with
> the token can see the full conversation, so the token is the only thing
> standing between a stranger and your agents' working notes.

## Try it locally first

No Hostinger account needed to shake out the logic:

```sh
cp -r public_html /tmp/llmtalk-test/public_html
sed -i '' "s|^const BUS_TOKEN = .*|const BUS_TOKEN = 'local';|" /tmp/llmtalk-test/public_html/api.php
cd /tmp/llmtalk-test && php -S 127.0.0.1:8000 -t public_html
```

```sh
TOKEN=local
curl -s "http://127.0.0.1:8000/api.php?action=health"
curl -s -H "X-Bus-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"send","from":"alice","to":"bob","text":"hi"}' "http://127.0.0.1:8000/api.php?action=send"
curl -s -H "X-Bus-Token: $TOKEN" "http://127.0.0.1:8000/api.php?action=inbox&to=bob"
```

---

## Behaviour worth knowing

- **The store is a flat JSON file**, so writes are serialised with `flock` and
  land via an atomic rename. Sixty simultaneous sends from six instances were
  verified to produce sixty intact messages with no gaps and no id collisions.
  Reads do not lock and may momentarily see the previous version, which is
  harmless here.
- **Nothing is delivered.** An instance learns about a message only when its
  agent calls `peer_inbox`. If you want a message to be acted on, tell the agent
  to check its inbox, or add the polling loop yourself.
- **Old messages are pruned** past `BUS_MAX_MESSAGES` (2000). Lower it if the
  file should stay small; the store rewrites in full on every send, so very high
  volumes will get slower.
- **Names are not accounts.** Anyone holding the token can post as any name.
  Treat the token as the only credential.
- **The bus has no delivery receipts.** A `send` that returns an id means the
  message is stored, not that the peer read it. `handoff` plus a `result` reply
  is the closest thing to an acknowledgement.

## Security

- The store lives outside `public_html` and gets a deny-all `.htaccess`. The
  script **refuses to run** if it resolves a store path inside the web root, and
  `health` reports `storePublic` so you can confirm it.
- Every action except `health` requires the token, compared with
  `hash_equals`. `health` exposes only counts and paths.
- Hostinger serves HTTPS by default. If your domain does not have a
  certificate yet, turn one on — the token is a bearer credential and would
  cross the network in the clear otherwise.
- The token is a bearer secret. Anyone with it can read and post as any
  instance. Do not commit it, and keep it out of shared config files.
- Optional hardening — make the agent confirm before it messages a peer:

  ```jsonc
  "permissions": [{ "action": "peer_send", "resource": "*", "effect": "ask" }]
  ```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `[llm-talk] disabled: llm-talk is missing: url and token` | Plugin options and `LLM_TALK_URL` / `LLM_TALK_TOKEN` are both missing. Set them and restart. |
| `401 Bad or missing token` | `BUS_TOKEN` on the server does not match the token on the machine. Compare them; a trailing newline in a `.env` file is a common cause. |
| `500 Server is not configured: edit BUS_TOKEN` | The placeholder token is still in `api.php`. |
| `Data directory is inside the web root` | `BUS_DATA_FILE` points inside `public_html`. Move it out, or blank the setting to auto-detect. |
| `Timed out after 15000ms` | Raise `timeoutMs`, or check that the domain is reachable from that machine. Free shared hosting can be slow; 15s is generous but not infinite. |
| `Could not reach ...` | Wrong URL, or the machine has no network route to it. `node check.mjs <url>` isolates this from OpenCode entirely. |
| `non-JSON body` | The URL is probably hitting an index page or a 404 rather than `api.php`. Confirm it ends in `api.php`. |
| Agent never checks the inbox | Pull-based by design. Say so in your prompt, or add a rule to your `AGENTS.md` telling it to call `peer_inbox` before reporting it is blocked. |
| Viewer says the token was refused | It probes with `peers`, not `health`, so this means `BUS_TOKEN` genuinely does not match. Re-check both, including stray whitespace. |
| Viewer stays on "retrying…" | The endpoint is unreachable or slow. Watch the network tab; `node check.mjs <url>` isolates it from the browser. |
| Viewer loads but stays empty | Normal if nothing has been sent yet. Confirm an instance has actually called `peer_send`. |
| Peer name in a message is not who you expected | Instances derive their name from `options.name`, then `LLM_TALK_NAME`, then the hostname. Set `name` explicitly. |
| Tools missing in the TUI | Confirm `plugins` is registered and restart. Check `~/.local/share/opencode/log/opencode.log` for the `[llm-talk]` line. |

## Layout

```
public_html/api.php     the server: routing, auth, storage, pruning
public_html/view.html   the web viewer: live tail, filters, composer
plugin/index.ts         plugin entry: tool and session-hook registration
plugin/client.ts        HTTP client: retries, timeouts, typed errors
plugin/config.ts        config resolution and validation
plugin/check.mjs        standalone connectivity check (plain Node)
examples/               opencode.jsonc and the optional machine config
```
