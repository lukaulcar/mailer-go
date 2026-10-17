# mailer-go

A self-hosted mail server and webmail client written in Go and React. 

A live instance runs at [mailer.lukaulcar.com](https://mailer.lukaulcar.com).

Self-hosting email normally means gluing together Postfix, Dovecot, SpamAssassin, a database and Roundcube, then keeping the whole thing patched. mailer-go takes a different route. It splits the mail system into a small public SMTP edge and a private backend, connects the two over an encrypted tunnel, and ships a webmail client plus a REST API for transactional mail.

## Architecture

Putting a database or a whole mail system on public port 25 is asking for trouble, so the project is split in two:

- **The edge** (`backend/smtp`) runs on the public internet and binds port 25. It handles inbound and outbound SMTP, runs the SPF/DKIM/DMARC checks, and signs outgoing mail. It stores no mailboxes and no user credentials.
- **The backend** (`backend/server`) is the control plane. It manages users, per-user SQLite databases, domains and the webmail API. It can live in a private subnet, behind a firewall, or on a separate machine entirely.

The two communicate over a persistent WebSocket connection encrypted with AES-256-GCM. Incoming mail is verified at the edge, encrypted, and relayed to the backend. Outgoing mail goes the other way: the backend hands a message to the edge, which signs it with DKIM and delivers it straight to the recipient's MX.

## What you get

- **Per-user storage isolation.** Every account gets its own SQLite database (`users/<user_id>/mailbox.db`) and message folder instead of one large shared table, so a mailbox that gets hit with 100k messages doesn't drag down anyone else.
- **Inbound verification.** SPF records, DKIM signatures and DMARC alignment are checked before mail reaches an inbox.
- **Two-tier spooling.** Traffic spikes sit in an in-memory ring buffer backed by a SQLite disk spool, so mail isn't dropped under load or during a backend restart.
- **Transactional send API.** A single `POST /v1/send` endpoint with template variables (`{{name}}`, `{{link}}`), domain-scoped API keys and automatic DKIM signing.
- **DNS checks from the dashboard.** The backend tests your MX, SPF, DKIM and DMARC records against public resolvers and flags anything missing or misconfigured.
- **Webmail.** React 19 and Vite, with WebSocket updates instead of polling, a composer, preview modes and a template editor.
- **Safe outbound delivery.** The sender resolves MX records, rejects private IP ranges (SSRF), dials the destination server directly and negotiates TLS.

## Repository layout

```
mailer-go/
├── backend/
│   ├── go.work              # Go multi-module workspace
│   ├── server/              # Central backend & user mailbox manager
│   │   ├── main.go
│   │   ├── .env.example
│   │   └── pkg/
│   │       ├── api/         # HTTP routes, auth, API keys, rate limits
│   │       ├── config/      # Environment configuration loader
│   │       ├── db/          # Central registry & per-user SQLite logic
│   │       ├── dnschecker/  # Live DNS resolution & record checks
│   │       ├── livehub/     # WebSocket hub for real-time UI updates
│   │       ├── relayclient/ # WebSocket client connecting to the edge node
│   │       ├── storage/     # Raw email & attachment storage
│   │       ├── store/       # In-memory mail store used by the API layer
│   │       ├── syncpusher/  # Pushes domains & aliases to the edge on a timer
│   │       └── usermanager/ # User accounts, quotas & authentication
│   ├── shared/              # Code shared by both services
│   │   ├── crypto/          # AES-GCM envelopes and DKIM key generation
│   │   ├── emailparser/     # Multipart MIME, RFC 2047, and body parsing
│   │   ├── envutil/         # .env loader and typed getters
│   │   ├── httputil/        # Small HTTP helpers (client IP, etc.)
│   │   ├── mimeutil/        # HTML-to-text and MIME part helpers
│   │   └── models/          # Shared data structures
│   └── smtp/                # Edge SMTP daemon (runs on port 25)
│       ├── main.go
│       ├── .env.example
│       └── pkg/
│           ├── api/         # Internal WebSocket & HTTP sync endpoints
│           ├── config/      # Environment configuration loader
│           ├── domains/     # Edge-cached authorized domains & DKIM keys
│           ├── hub/         # Live WebSocket sessions from the backend
│           ├── outbound/    # Outbound delivery engine & DKIM signer
│           ├── smtpserver/  # Inbound SMTP listener & session handling
│           ├── spool/       # RAM buffer + disk spool
│           └── verifier/    # SPF, DKIM, and DMARC verification
├── frontend/                # React 19 webmail and admin dashboard
│   ├── src/
│   │   ├── app/             # App routes and views
│   │   ├── components/      # Compose modal, inbox list, template editor
│   │   └── lib/             # API client, WebSocket hooks, auth state
│   ├── package.json
│   └── vite.config.ts
└── README.md
```

## Getting started

You'll need **Go 1.26+** and **Node.js 20.19+** (Vite 8's minimum) with `npm` or `pnpm`.

### 1. Start the backend server

```bash
cd backend/server
cp .env.example .env
```

Open `.env` and set your values. The important ones are `AUTH_TOKEN` and `AES_KEY`: use random 32-character strings and make sure they match what you put in the SMTP node config.

```env
HTTP_PORT=8082
SERVER_HOSTNAME=mail.yourdomain.com
SMTP_SERVICE_URL=http://localhost:8081
SMTP_SERVICE_WS=ws://localhost:8081/ws
AUTH_TOKEN=your-random-32-character-secret
AES_KEY=your-random-32-character-aes-key
CENTRAL_DB_PATH=central_backend.db
STORAGE_PATH=data/storage
BASE_USERS_DIR=data/users
```

Then start it:

```bash
go run .
```

The server creates its SQLite database and listens on `http://localhost:8082`.

### 2. Start the edge SMTP service

In a second terminal:

```bash
cd backend/smtp
cp .env.example .env
```

Edit `backend/smtp/.env` and make sure `AUTH_TOKEN` and `AES_KEY` match the server config:

```env
ENV=production
DEBUG=false
SMTP_PORT=25
HTTP_PORT=8081
SERVER_HOSTNAME=mail.yourdomain.com
AUTH_TOKEN=your-random-32-character-secret
AES_KEY=your-random-32-character-aes-key
MAX_RAM_MB=64
MAX_DISK_MB=500
SQLITE_PATH=smtp_spool.db
MAX_MESSAGE_MB=25
```

> Binding port 25 needs root on Linux and macOS. For local development set `SMTP_PORT=2525` and `ENV=development` so it runs as an unprivileged user.

Start the daemon:

```bash
go run .
```

### 3. Run the webmail dashboard

In a third terminal:

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Vite dev server proxies `/api`, `/v1` and `/ws` to the backend on port 8082.

To build the production bundle:

```bash
npm run build
```

This writes static assets to `frontend/dist/`.

## Sending mail via the API

Create an API key in the dashboard (scoped to one domain or all of them), then send a message:

```bash
curl -X POST http://localhost:8082/v1/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@yourdomain.com",
    "to": ["user@example.com"],
    "subject": "Welcome aboard!",
    "body": "Hi {{name}},\n\nThanks for signing up. Your account is ready to go.",
    "html": "<p>Hi <strong>{{name}}</strong>,</p><p>Thanks for signing up. Your account is ready to go.</p>",
    "vars": {
      "name": "Alex"
    }
  }'
```

A successful response:

```json
{
  "success": true,
  "message": "Mail queued for delivery",
  "mail_id": "msg_01h7abc123"
}
```

The backend replaces `{{name}}` with `Alex`, queues the message to the edge node, signs it with your domain's DKIM key, and starts MX delivery.

## Managing messages via the API

You can clear a folder or batch-delete specific messages using an API key, a mailbox token, or a JWT session token.

### Clear an inbox or folder

This permanently removes every message in a folder (the default is `inbox`):

```bash
# Clear the inbox
curl -X DELETE http://localhost:8082/api/mailboxes/user@yourdomain.com/messages?folder=inbox \
  -H "Authorization: Bearer YOUR_API_KEY"

# Same thing via POST
curl -X POST http://localhost:8082/api/mailboxes/user@yourdomain.com/messages/clear \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"folder": "inbox"}'
```

To clear every folder in the mailbox, pass `?folder=all` or `{"all": true}`:

```bash
curl -X DELETE "http://localhost:8082/api/mailboxes/user@yourdomain.com/messages?folder=all" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Response:

```json
{
  "success": true,
  "mailbox": "user@yourdomain.com",
  "folder": "inbox",
  "deleted_count": 14,
  "deleted_ids": ["msg_1", "msg_2"],
  "freed_bytes": 145892
}
```

### Delete selected messages

Delete specific messages by ID in a single call:

```bash
# For one mailbox
curl -X DELETE http://localhost:8082/api/mailboxes/user@yourdomain.com/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["msg_01h7abc123", "msg_01h7def456"]
  }'

# Or through the global endpoint
curl -X DELETE http://localhost:8082/api/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["msg_01h7abc123", "msg_01h7def456"]
  }'
```

Response:

```json
{
  "success": true,
  "deleted_count": 2,
  "deleted_ids": ["msg_01h7abc123", "msg_01h7def456"],
  "freed_bytes": 38400
}
```

## DNS setup

To send and receive mail reliably, add these records at your DNS provider:

| Record | Name / Host | Value | Priority | Why it's needed |
| :--- | :--- | :--- | :---: | :--- |
| **MX** | `@` | `mail.yourdomain.com.` | `10` | Routes incoming mail to your edge server. |
| **TXT** | `@` | `v=spf1 mx ~all` | — | Tells receivers your server may send mail for the domain. |
| **TXT** | `mailergo._domainkey` | `v=DKIM1; k=rsa; p=<PUBLIC_KEY>` | — | The public DKIM key, so receivers can verify your signature. |
| **TXT** | `_dmarc` | `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@yourdomain.com` | — | Tells providers how to treat mail that fails SPF or DKIM. |

The dashboard has a built-in checker that tests these records against public resolvers and shows the status of each one.

## Production deployment

### Binding port 25 without root (Linux)

Don't run the mail daemon as root. Give the compiled binary permission to bind low ports instead:

```bash
sudo setcap 'cap_net_bind_service=+ep' /opt/mailer-go/backend/smtp/smtpServer
```

### Reverse DNS (PTR)

Bad reverse DNS is the most common reason self-hosted mail lands in spam. Ask your host (Hetzner, DigitalOcean, Linode, AWS, and so on) to set the PTR record for your server's public IP to your mail hostname, for example `mail.yourdomain.com`.

### systemd services

Backend, at `/etc/systemd/system/mailer-server.service`:

```ini
[Unit]
Description=mailer-go Backend Control Plane
After=network.target

[Service]
Type=simple
User=mailer
Group=mailer
WorkingDirectory=/opt/mailer-go/backend/server
ExecStart=/opt/mailer-go/backend/server/server
Restart=always
RestartSec=5
EnvironmentFile=/opt/mailer-go/backend/server/.env

[Install]
WantedBy=multi-user.target
```

Edge SMTP, at `/etc/systemd/system/mailer-smtp.service`:

```ini
[Unit]
Description=mailer-go Edge SMTP Service
After=network.target

[Service]
Type=simple
User=mailer
Group=mailer
WorkingDirectory=/opt/mailer-go/backend/smtp
ExecStart=/opt/mailer-go/backend/smtp/smtpServer
Restart=always
RestartSec=5
EnvironmentFile=/opt/mailer-go/backend/smtp/.env
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

Enable and start them:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mailer-server mailer-smtp
```

### Nginx reverse proxy and TLS

An Nginx config that serves the web client and proxies the API:

```nginx
server {
    listen 80;
    server_name mail.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name mail.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/mail.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mail.yourdomain.com/privkey.pem;

    root /opt/mailer-go/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8082;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /v1/ {
        proxy_pass http://127.0.0.1:8082;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## Configuration reference

### Backend (`backend/server/.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HTTP_PORT` | `8082` | Port for the backend API and web client proxy. |
| `SERVER_HOSTNAME` | `mail.yourdomain.com` | Primary mail server hostname. |
| `SMTP_SERVICE_URL` | `http://localhost:8081` | HTTP address of your SMTP edge node. |
| `SMTP_SERVICE_WS` | `ws://localhost:8081/ws` | WebSocket address of your SMTP edge node. |
| `AUTH_TOKEN` | — | Shared secret for edge-to-backend authentication. |
| `AES_KEY` | — | 32-character AES-256 key for payload encryption. |
| `CENTRAL_DB_PATH` | `central_backend.db` | SQLite database for accounts, domains and API keys. |
| `STORAGE_PATH` | `data/storage` | Directory where raw email bodies and attachments are stored. |
| `BASE_USERS_DIR` | `data/users` | Directory containing individual user SQLite databases. |
| `DOMAIN_SYNC_INTERVAL_SEC` | `60` | How often domain and alias updates are pushed to the edge node. |
| `DNS_CHECK_INTERVAL_MINUTES` | `5` | How often background DNS verification runs. |
| `DNS_RESOLVER` | `1.1.1.1:53` | Upstream DNS resolver for record checks. |

### SMTP edge (`backend/smtp/.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ENV` | `production` | Environment mode (`production` or `development`). |
| `DEBUG` | `false` | Enable detailed SMTP protocol logs. |
| `SMTP_PORT` | `25` | Port for incoming mail (use `2525` for local testing). |
| `SMTP_SUBMISSION_PORT` | `587` | Optional submission port. |
| `HTTP_PORT` | `8081` | Internal HTTP/WebSocket port for backend sync. |
| `SERVER_HOSTNAME` | `mail.yourdomain.com` | Hostname sent in HELO/EHLO responses. |
| `AUTH_TOKEN` | — | Shared secret (must match the backend). |
| `AES_KEY` | — | 32-character AES-256 key (must match the backend). |
| `MAX_RAM_MB` | `64` | In-memory queue buffer size limit. |
| `MAX_DISK_MB` | `500` | Disk spool size limit before incoming mail is rejected. |
| `MAX_DISK_MESSAGES` | `10000` | Max queued messages on disk. |
| `SQLITE_PATH` | `smtp_spool.db` | Spool SQLite database file. |
| `MAX_MESSAGE_MB` | `25` | Max size for incoming email. |
| `MAX_RECIPIENTS` | `50` | Max recipients per SMTP transaction. |
| `OUTBOUND_DIAL_TIMEOUT_SEC` | `10` | Timeout when connecting to destination MX servers. |

## License

MIT. See [LICENSE](LICENSE).
