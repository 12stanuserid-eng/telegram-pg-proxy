import net from 'net';
import { QueryEngine } from '../engine/engine.js';
import {
  parseStartupMessage,
  parseQueryMessage,
  encodeStartupResponse,
  encodeQueryResult,
  encodeErrorResponse,
  encodeSSLReject,
} from './protocol.js';
import { parseSQL } from '../sql/parser.js';

const STARTUP_HEADER_LEN = 8; // Int32 length + Int32 protocol
const MSG_HEADER_LEN = 5; // Byte1 type + Int32 length
const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_VERSION = 196608;

class PgConnection {
  private socket: net.Socket;
  private engine: QueryEngine;
  private pid: number;
  private secretKey: number;
  private buffer: Buffer = Buffer.alloc(0);
  private startupComplete = false;
  private sslHandled = false;

  constructor(socket: net.Socket, engine: QueryEngine, pid: number, secretKey: number) {
    this.socket = socket;
    this.engine = engine;
    this.pid = pid;
    this.secretKey = secretKey;

    this.socket.on('data', this.onData.bind(this));
    this.socket.on('error', () => {});
    this.socket.on('close', () => {});
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    try {
      this.processBuffer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.pid}] Error:`, message);
      try {
        for (const msg of encodeErrorResponse(message)) {
          this.socket.write(msg);
        }
      } catch {
        this.socket.destroy();
      }
    }
  }

  private processBuffer(): void {
    if (!this.startupComplete) {
      this.processStartup();
    } else {
      this.processMessages();
    }
  }

  private processStartup(): void {
    if (this.buffer.length < STARTUP_HEADER_LEN) return;

    const length = this.buffer.readUInt32BE(0);

    // Wait for the full message
    if (this.buffer.length < length) return;

    const msg = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);

    if (!this.sslHandled) {
      // Check for SSLRequest
      const protocol = msg.readUInt32BE(4);
      if (protocol === SSL_REQUEST_CODE) {
        this.socket.write(encodeSSLReject());
        this.sslHandled = true;
        // Continue processing buffer for the actual startup message
        if (this.buffer.length > 0) {
          this.processStartup();
        }
        return;
      }
    }

    // Parse startup message
    const startup = parseStartupMessage(msg);

    if (startup.protocol !== PROTOCOL_VERSION) {
      for (const m of encodeErrorResponse(`Unsupported protocol: ${startup.protocol}`)) {
        this.socket.write(m);
      }
      this.socket.destroy();
      return;
    }

    // Send startup response
    const messages = encodeStartupResponse(this.pid, this.secretKey);
    for (const m of messages) {
      this.socket.write(m);
    }

    this.startupComplete = true;
    this.sslHandled = true;

    // Process any remaining data as query messages
    if (this.buffer.length > 0) {
      this.processMessages();
    }
  }

  private processMessages(): void {
    while (this.buffer.length >= MSG_HEADER_LEN) {
      const typeChar = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readUInt32BE(1);

      // Check if we have the full message
      if (this.buffer.length < length) break;

      const msg = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);

      this.handleMessage(typeChar, msg);
    }
  }

  private async handleMessage(type: string, msg: Buffer): Promise<void> {
    switch (type) {
      case 'Q': {
        const sql = parseQueryMessage(msg);
        console.log(`[${this.pid}] SQL: ${sql}`);

        if (!sql.trim()) {
          for (const m of encodeErrorResponse('Empty query')) {
            this.socket.write(m);
          }
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
          for (const m of messages) {
            this.socket.write(m);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[${this.pid}] Error: ${message}`);
          for (const m of encodeErrorResponse(message)) {
            this.socket.write(m);
          }
        }
        break;
      }

      case 'X': {
        this.socket.end();
        break;
      }

      default: {
        for (const m of encodeErrorResponse(`Unsupported message type: ${type}`)) {
          this.socket.write(m);
        }
        break;
      }
    }
  }
}

export class PgServer {
  private server: net.Server;
  private port: number;
  private host: string;
  private engine: QueryEngine;
  private nextPid: number;

  constructor(engine: QueryEngine, port: number = 5432, host: string = '0.0.0.0') {
    this.engine = engine;
    this.port = port;
    this.host = host;
    this.nextPid = 1000;
    this.server = net.createServer({}, this.handleConnection.bind(this));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        console.log(`PG Proxy listening on ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    const pid = this.nextPid++;
    const secretKey = Math.floor(Math.random() * 2147483647) + 1;
    new PgConnection(socket, this.engine, pid, secretKey);
  }
}
