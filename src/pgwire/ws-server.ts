import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { QueryEngine } from '../engine/engine.js';
import {
  parseStartupMessage,
  parseQueryMessage,
  encodeStartupResponse,
  encodeQueryResult,
  encodeErrorResponse,
} from './protocol.js';
import { parseSQL } from '../sql/parser.js';

const STARTUP_HEADER_LEN = 8; // Int32 length + Int32 protocol
const MSG_HEADER_LEN = 5; // Byte1 type + Int32 length
const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_VERSION = 196608;

/**
 * Per-connection handler for PG protocol over WebSocket.
 * Mirrors PgConnection from server.ts but reads/writes via WebSocket binary frames.
 */
class WsPgConnection {
  private engine: QueryEngine;
  private ws: WebSocket;
  private pid: number;
  private secretKey: number;
  private buffer: Buffer = Buffer.alloc(0);
  private startupComplete = false;

  constructor(ws: WebSocket, engine: QueryEngine, pid: number, secretKey: number) {
    this.ws = ws;
    this.engine = engine;
    this.pid = pid;
    this.secretKey = secretKey;
  }

  /**
   * Called when a binary WebSocket frame arrives.
   * Buffers and processes PG wire protocol messages.
   */
  async onMessage(data: Buffer): Promise<void> {
    this.buffer = Buffer.concat([this.buffer, data]);

    try {
      if (!this.startupComplete) {
        this.processStartup();
      } else {
        await this.processMessages();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.pid}] Error:`, message);
      try {
        this.send(Buffer.concat(encodeErrorResponse(message)));
      } catch {
        this.ws.close();
      }
    }
  }

  /** Send raw PG protocol bytes as a binary WebSocket frame. */
  private send(data: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /** Process the StartupMessage (special format: no type byte). */
  private processStartup(): void {
    if (this.buffer.length < STARTUP_HEADER_LEN) return;

    const length = this.buffer.readUInt32BE(0);

    if (this.buffer.length < length) return;

    const msg = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);

    // Check for SSLRequest and skip it (not applicable over WebSocket)
    const protocol = msg.readUInt32BE(4);
    if (protocol === SSL_REQUEST_CODE) {
      if (this.buffer.length > 0) {
        this.processStartup();
      }
      return;
    }

    // Parse startup message
    const startup = parseStartupMessage(msg);

    if (startup.protocol !== PROTOCOL_VERSION) {
      this.send(
        Buffer.concat(encodeErrorResponse(`Unsupported protocol: ${startup.protocol}`))
      );
      this.ws.close();
      return;
    }

    // Send startup response (AuthOk + params + BackendKeyData + ReadyForQuery)
    const messages = encodeStartupResponse(this.pid, this.secretKey);
    this.send(Buffer.concat(messages));

    this.startupComplete = true;

    // Process any remaining data as query messages
    if (this.buffer.length > 0) {
      this.processMessages();
    }
  }

  /** Process regular PG wire protocol messages (Query, Terminate, etc.). */
  private async processMessages(): Promise<void> {
    while (this.buffer.length >= MSG_HEADER_LEN) {
      const typeChar = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readUInt32BE(1);

      if (this.buffer.length < length) break;

      const msg = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);

      await this.handleMessage(typeChar, msg);
    }
  }

  /** Route a single PG protocol message to the right handler. */
  private async handleMessage(type: string, msg: Buffer): Promise<void> {
    switch (type) {
      case 'Q': {
        // Query message
        const sql = parseQueryMessage(msg);
        console.log(`[${this.pid}] SQL: ${sql}`);

        if (!sql.trim()) {
          this.send(Buffer.concat(encodeErrorResponse('Empty query')));
          return;
        }

        try {
          const parsed = parseSQL(sql);
          const result = await this.engine.execute(parsed);
          const messages = encodeQueryResult(
            result.columns,
            result.rows,
            result.command,
            result.rowCount
          );
          this.send(Buffer.concat(messages));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[${this.pid}] Error: ${message}`);
          this.send(Buffer.concat(encodeErrorResponse(message)));
        }
        break;
      }

      case 'X': {
        // Terminate message
        this.ws.close();
        break;
      }

      default: {
        this.send(
          Buffer.concat(encodeErrorResponse(`Unsupported message type: ${type}`))
        );
        break;
      }
    }
  }
}

/**
 * Creates an HTTP+WebSocket server for PostgreSQL wire protocol.
 * - Serves /healthz for Render health checks
 * - WebSocket endpoint at /pg accepts PG protocol as binary frames
 */
export function createWsServer(
  engine: QueryEngine,
  port: number,
  host: string
): http.Server {
  const httpServer = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
      }
      res.writeHead(404);
      res.end();
    }
  );

  const wss = new WebSocketServer({ server: httpServer, path: '/pg' });
  let nextPid = 1000;

  wss.on('connection', (ws: WebSocket) => {
    const pid = nextPid++;
    const secretKey = Math.floor(Math.random() * 2147483647) + 1;
    const conn = new WsPgConnection(ws, engine, pid, secretKey);

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      // Convert to a single Buffer regardless of ws framing
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      conn.onMessage(buf);
    });

    ws.on('error', () => {
      // WebSocket errors are non-fatal; connection is already dead
    });
  });

  httpServer.listen(port, host, () => {
    console.log(`PG-Proxy WebSocket server listening on ws://${host}:${port}/pg`);
    console.log(`Health check: http://${host}:${port}/healthz`);
  });

  return httpServer;
}
