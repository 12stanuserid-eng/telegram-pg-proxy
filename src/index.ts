import { PgServer } from './pgwire/server.js';
import { TelegramStorage } from './storage/telegram.js';
import { QueryEngine } from './engine/engine.js';
import * as http from 'http';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const PG_PORT = parseInt(process.env.PGPORT || '5432', 10);
const RENDER_PORT = parseInt(process.env.PORT || '10000', 10);
const HOST = process.env.PGHOST || '0.0.0.0';

if (!BOT_TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN environment variable is required');
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error('FATAL: TELEGRAM_CHANNEL_ID environment variable is required');
  process.exit(1);
}

async function main() {
  console.log('=== Telegram PG Proxy ===');
  console.log(`Bot token: ${BOT_TOKEN!.substring(0, 8)}...`);
  console.log(`Channel ID: ${CHANNEL_ID!}`);
  console.log(`PG Port: ${PG_PORT}`);
  console.log(`Health Port: ${RENDER_PORT}`);
  console.log(`Host: ${HOST}`);

  // Initialize Telegram storage
  console.log('\nInitializing Telegram storage...');
  const storage = new TelegramStorage(BOT_TOKEN!, CHANNEL_ID!);
  try {
    await storage.init();
    console.log('Telegram storage initialized successfully');
  } catch (err) {
    console.error('Failed to initialize Telegram storage:', err);
    process.exit(1);
  }

  // Initialize query engine
  const engine = new QueryEngine(storage);

  // Start HTTP health check server on Render's PORT
  const healthServer = http.createServer((req, res) => {
    console.log(`Health check: ${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });
  healthServer.listen(RENDER_PORT, HOST, () => {
    console.log(`Health check server listening on ${HOST}:${RENDER_PORT}`);
  });

  // Start PG server on PGPORT
  if (PG_PORT !== RENDER_PORT) {
    console.log(`\nStarting PG Proxy on port ${PG_PORT}...`);
    const pgServer = new PgServer(engine, PG_PORT, HOST);
    await pgServer.start();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
