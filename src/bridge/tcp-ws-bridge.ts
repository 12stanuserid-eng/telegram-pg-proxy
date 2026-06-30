import net from 'net';
import WebSocket from 'ws';

export interface BridgeOptions {
  /** TCP listen port (default 5432) */
  port: number;
  /** TCP listen host (default '0.0.0.0') */
  host: string;
  /** Remote WebSocket URL to forward to (e.g. wss://example.com/pg) */
  remoteUrl: string;
}

/**
 * Creates a TCP-to-WebSocket bridge.
 * Listens on a TCP port and forwards every connection to a remote WebSocket.
 * PG wire protocol bytes are relayed as binary WebSocket frames and vice versa.
 */
export function createBridge(options: BridgeOptions): net.Server {
  const { port, host, remoteUrl } = options;

  const server = net.createServer((tcpSocket: net.Socket) => {
    console.log(`[bridge] TCP connection from ${tcpSocket.remoteAddress}:${tcpSocket.remotePort}`);

    const ws = new WebSocket(remoteUrl);

    let tcpEnded = false;
    let wsClosed = false;

    const closeBoth = () => {
      if (!tcpEnded) {
        tcpEnded = true;
        tcpSocket.end();
      }
      if (!wsClosed) {
        wsClosed = true;
        ws.close();
      }
    };

    ws.on('open', () => {
      console.log('[bridge] WebSocket connected');

      // Forward TCP data → WebSocket binary frames
      tcpSocket.on('data', (data: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      tcpSocket.on('error', (err: Error) => {
        console.error(`[bridge] TCP error: ${err.message}`);
        closeBoth();
      });

      tcpSocket.on('close', () => {
        console.log('[bridge] TCP connection closed');
        closeBoth();
      });
    });

    // Forward WebSocket binary frames → TCP
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (!tcpEnded) {
        tcpSocket.write(buf);
      }
    });

    ws.on('error', (err: Error) => {
      console.error(`[bridge] WebSocket error: ${err.message}`);
      closeBoth();
    });

    ws.on('close', () => {
      console.log('[bridge] WebSocket closed');
      closeBoth();
    });

    // Timeout: if WebSocket doesn't connect within 10s, close TCP
    tcpSocket.setTimeout(10000);
    tcpSocket.on('timeout', () => {
      console.error('[bridge] TCP timeout waiting for WebSocket connection');
      closeBoth();
    });
  });

  server.listen(port, host, () => {
    console.log(`[bridge] TCP bridge listening on ${host}:${port}`);
    console.log(`[bridge] Forwarding to ${remoteUrl}`);
  });

  return server;
}
