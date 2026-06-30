import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { QueryEngine } from '../engine/engine.js';
import {
  parseStartupMessage,
  parseQueryMessage,
  parseParseMessage,
  parseBindMessage,
  substituteParams,
  encodeStartupResponse,
  encodeQueryResult,
  encodeErrorResponse,
  encodeReadyForQuery,
  encodeParseComplete,
  encodeBindComplete,
  encodeNoData,
  encodeCommandComplete,
  encodeRowDescription,
  encodeDataRow,
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
  /** Named prepared statements: name → SQL */
  private statements: Map<string, string> = new Map();
  /** Named portals: portalName → { statementName, params } */
  private portals: Map<string, { statementName: string; params: (string | null)[] }> = new Map();

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

    // Check for SSLRequest — reject with 'N' so psql knows to continue without SSL
    const protocol = msg.readUInt32BE(4);
    if (protocol === SSL_REQUEST_CODE) {
      this.send(Buffer.from([0x4E])); // 'N' = SSL not supported
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

  /** Runs a SQL string through the engine and sends the result messages. */
  private async executeSql(sql: string): Promise<void> {
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
  }

  /** Routes a single PG protocol message to the right handler. */
  private async handleMessage(type: string, msg: Buffer): Promise<void> {
    switch (type) {
      case 'Q': {
        // Simple Query message
        const sql = parseQueryMessage(msg);
        console.log(`[${this.pid}] Q: ${sql}`);
        await this.executeSql(sql);
        break;
      }

      case 'P': {
        // Parse message — store prepared statement
        const parsed = parseParseMessage(msg);
        console.log(`[${this.pid}] Parse: name="${parsed.name}" sql="${parsed.sql.substring(0, 80)}..."`);
        this.statements.set(parsed.name, parsed.sql);
        this.send(encodeParseComplete());
        break;
      }

      case 'B': {
        // Bind message — store portal with parameters
        const bind = parseBindMessage(msg);
        console.log(`[${this.pid}] Bind: portal="${bind.portalName}" stmt="${bind.statementName}" params=${bind.params.length}`);
        // Look up the statement SQL
        const sql = bind.statementName ? this.statements.get(bind.statementName) : undefined;
        if (sql === undefined) {
          // If no statement name, try unnamed
          const unnamed = this.statements.get('');
          if (unnamed === undefined) {
            this.send(Buffer.concat(encodeErrorResponse('Unknown prepared statement: ' + bind.statementName)));
            break;
          }
          this.portals.set(bind.portalName, { statementName: '', params: bind.params });
        } else {
          this.portals.set(bind.portalName, { statementName: bind.statementName, params: bind.params });
        }
        this.send(encodeBindComplete());
        break;
      }

      case 'D': {
        // Describe message — return NoData (safe fallback for both statement and portal)
        this.send(encodeNoData());
        break;
      }

      case 'E': {
        // Execute message — run the portal's query with substituted parameters
        // Read portal name from the message
        let portalName = '';
        if (msg.length > 5) {
          const nameEnd = msg.indexOf(0, 5);
          portalName = nameEnd >= 0 ? msg.toString('utf-8', 5, nameEnd) : '';
        }
        const portal = this.portals.get(portalName);
        if (!portal) {
          this.send(Buffer.concat(encodeErrorResponse(`Portal "${portalName}" not found`)));
          break;
        }
        const sql = this.statements.get(portal.statementName);
        if (sql === undefined) {
          this.send(Buffer.concat(encodeErrorResponse(`Prepared statement "${portal.statementName}" not found`)));
          break;
        }
        // Substitute $1, $2, ... placeholders with actual parameter values
        const finalSql = portal.params.length > 0 ? substituteParams(sql, portal.params) : sql;
        console.log(`[${this.pid}] Execute: ${finalSql.substring(0, 100)}...`);

        if (!finalSql.trim()) {
          this.send(Buffer.concat(encodeErrorResponse('Empty query after parameter substitution')));
          break;
        }
        try {
          const parsed = parseSQL(finalSql);
          const result = await this.engine.execute(parsed);
          const tag = result.command === 'SELECT'
            ? `SELECT ${result.rowCount}`
            : result.command === 'INSERT'
              ? `INSERT 0 ${result.rowCount}`
              : result.command === 'UPDATE'
                ? `UPDATE ${result.rowCount}`
                : result.command === 'DELETE'
                  ? `DELETE ${result.rowCount}`
                  : result.command;

          // For extended query, send RowDescription + DataRows + CommandComplete (no ReadyForQuery yet)
          const messages: Buffer[] = [];
          if (result.command === 'SELECT') {
            messages.push(encodeRowDescription(result.columns));
            for (const row of result.rows) {
              messages.push(encodeDataRow(row));
            }
          }
          messages.push(encodeCommandComplete(tag));
          this.send(Buffer.concat(messages));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[${this.pid}] Error: ${message}`);
          this.send(Buffer.concat(encodeErrorResponse(message)));
        }
        break;
      }

      case 'S': {
        // Sync message — return ReadyForQuery
        this.send(encodeReadyForQuery());
        break;
      }

      case 'X': {
        // Terminate message
        this.ws.close();
        break;
      }

      default: {
        console.log(`[${this.pid}] Unsupported message type: ${type} (0x${type.charCodeAt(0).toString(16)})`);
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
