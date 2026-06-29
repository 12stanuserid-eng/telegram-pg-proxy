# Telegram PG Proxy

A lightweight PostgreSQL Wire-Protocol Proxy that stores all data in Telegram channels via the Bot API.

## Architecture

```
[App on Render] ←→ [PG Proxy :5432] ←→ [Telegram Bot API] ←→ [Telegram Channel (data)]
```

## How It Works

1. Speaks the PostgreSQL wire protocol (v3) from scratch — no external pgwire library
2. Accepts standard PostgreSQL connections on port 5432
3. Parses basic SQL (CREATE TABLE, INSERT, SELECT, UPDATE, DELETE, DROP TABLE)
4. Stores all data as messages in a Telegram channel
5. Uses a local JSON file as an index for fast lookups

## Requirements

- Node.js 18+ or Docker
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- A Telegram channel where the bot is added as an administrator

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token you receive

### 2. Create a Channel and Add the Bot

1. Create a new Telegram channel (private or public)
2. Add your bot as an **administrator** with at least these permissions:
   - Send messages
   - Delete messages
   - Edit messages
3. Get the channel ID (e.g., `-1001234567890`):
   - Forward a message from the channel to [@getidsbot](https://t.me/getidsbot)
   - Or check the channel's invite link info

### 3. Run the Proxy

#### Using Node.js directly

```bash
# Clone and install
cd telegram-pg-proxy
npm install

# Set environment variables
export TELEGRAM_BOT_TOKEN=your_bot_token
export TELEGRAM_CHANNEL_ID=-1001234567890
export PGPORT=5432
export PGHOST=0.0.0.0

# Build and start
npm run build
npm start

# Or run in development mode
npm run dev
```

#### Using Docker

```bash
docker build -t telegram-pg-proxy .
docker run -p 5432:5432 \
  -e TELEGRAM_BOT_TOKEN=your_bot_token \
  -e TELEGRAM_CHANNEL_ID=-1001234567890 \
  telegram-pg-proxy
```

### 4. Connect Any PostgreSQL Client

Use any standard PostgreSQL client with the connection string:

```
postgresql://postgres@localhost:5432/postgres
```

Or use `psql`:

```bash
psql -h localhost -p 5432 -U postgres -d postgres
```

> Note: The password is not required (trust authentication).

## Supported SQL

### Data Definition

```sql
CREATE TABLE users (id INTEGER, name TEXT, age INTEGER, active BOOLEAN);
DROP TABLE users;
```

### Data Manipulation

```sql
INSERT INTO users (id, name, age, active) VALUES (1, 'Alice', 30, true);
SELECT * FROM users;
SELECT * FROM users WHERE age > 25;
SELECT * FROM users WHERE active = true AND age < 40;
UPDATE users SET age = 31 WHERE name = 'Alice';
DELETE FROM users WHERE name = 'Bob';
```

### Supported Types

| SQL Type  | JS/JSON Mapping |
|-----------|----------------|
| TEXT      | string         |
| INTEGER   | number (int)   |
| REAL      | number (float) |
| BOOLEAN   | boolean        |
| INT       | alias for INTEGER |
| BOOL      | alias for BOOLEAN |
| FLOAT     | alias for REAL |

### WHERE Clause Operators

- `=`, `!=`, `>`, `<`, `>=`, `<=`
- Multiple conditions with `AND`

## Environment Variables

| Variable               | Default       | Description                        |
|------------------------|---------------|------------------------------------|
| `TELEGRAM_BOT_TOKEN`   | _(required)_  | Bot token from BotFather           |
| `TELEGRAM_CHANNEL_ID`  | _(required)_  | Channel ID (e.g., -1001234567890)  |
| `PGPORT`               | `5432`        | TCP port for PostgreSQL protocol   |
| `PGHOST`               | `0.0.0.0`     | Bind address                       |
| `STATE_FILE`           | `state.json`  | Path to local state index file     |

## Rate Limiting

Telegram Bot API allows approximately 20 messages per minute per bot token.
The proxy implements an internal queue with automatic retry and backoff:

- Minimum 3-second interval between API calls
- Up to 3 retry attempts on failure
- Exponential backoff (1s, 2s, 4s)

## Deployment on Render

Code is already at: https://github.com/12stanuserid-eng/telegram-pg-proxy

### Quick Deploy

1. Go to https://dashboard.render.com/ and log in
2. Click **New +** → **Web Service**
3. Connect GitHub → select `12stanuserid-eng/telegram-pg-proxy`
4. Render will auto-detect the Dockerfile — just click **Deploy**
5. Before deploying, add these environment variables:
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `TELEGRAM_CHANNEL_ID` = your channel ID (e.g., `-1003998671748`)
6. Click **Deploy**

Your service will be available at: `postgresql://postgres@telegram-pg-proxy.onrender.com:5432/postgres`

### Using render.yaml Blueprint

If you're using Render Blueprint (Infrastructure as Code), just connect your GitHub repo
and the `render.yaml` file will be picked up automatically.

## Limitations

- No password authentication (trust auth only)
- No SSL/TLS support
- Single user / no connection pooling
- Simple SQL parser (no joins, subqueries, aggregations, etc.)
- Data stays in Telegram — local index is needed for fast SELECT queries
- If the local state file is lost, existing data in Telegram can't be re-indexed automatically
