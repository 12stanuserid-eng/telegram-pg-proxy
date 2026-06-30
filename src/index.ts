import { PgServer } from './pgwire/server.js';
import { TelegramStorage } from './storage/telegram.js';
import { QueryEngine } from './engine/engine.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const PORT = parseInt(process.env.PORT || '10000', 10);
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
  console.log(`Port: ${PORT}`);
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

  // Start PG proxy on Render's PORT
  // The PG server detects HTTP connections and responds to health checks automatically
  console.log(`\nStarting PG Proxy on port ${PORT}...`);
  const pgServer = new PgServer(engine, PORT, HOST);
  await pgServer.start();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
