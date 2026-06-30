#!/usr/bin/env node

import { createBridge } from './tcp-ws-bridge.js';

const REMOTE_URL =
  process.env.RENDER_URL || process.env.REMOTE_WS_URL ||
  'wss://telegram-pg-proxy.onrender.com/pg';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '5432', 10);
const BRIDGE_HOST = process.env.BRIDGE_HOST || '0.0.0.0';

console.log('=== Telegram PG Proxy — TCP↔WebSocket Bridge ===');
console.log(`Remote WebSocket URL: ${REMOTE_URL}`);
console.log(`Local TCP listen:     ${BRIDGE_HOST}:${BRIDGE_PORT}`);

const server = createBridge({
  port: BRIDGE_PORT,
  host: BRIDGE_HOST,
  remoteUrl: REMOTE_URL,
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[bridge] Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('\n[bridge] Shutting down...');
  server.close(() => process.exit(0));
});
