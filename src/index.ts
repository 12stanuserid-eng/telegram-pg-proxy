import { PgServer } from './pgwire/server.js';
import { TelegramStorage } from './storage/telegram.js';
import { QueryEngine } from './engine/engine.js';
import { createServer } from 'http';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const PORT = parseInt(process.env.PGPORT || '5432', 10);
const HOST = process.env.PGHOST || '0.0.0.0';
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);

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
  console.log(`PG Port: ${PORT}`);
  console.log(`Host: ${HOST}`);
  console.log(`HTTP Health Port: ${HTTP_PORT}`);

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

  // Start HTTP health check server
  const httpServer = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'telegram-pg-proxy' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  httpServer.listen(HTTP_PORT, HOST, () => {
    console.log(`HTTP health check listening on ${HOST}:${HTTP_PORT}`);
  });

  // Start PG server
  console.log('\nStarting PG Proxy server...');
  const server = new PgServer(engine, PORT, HOST);
  await server.start();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
