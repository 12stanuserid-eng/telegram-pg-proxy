import { ColumnType } from '../sql/types.js';

// PostgreSQL OIDs for common types
const OID: Record<string, number> = {
  TEXT: 25,
  INTEGER: 23,
  REAL: 701,
  BOOLEAN: 16,
};

const TYPE_SIZE: Record<string, number> = {
  TEXT: -1,
  INTEGER: 4,
  REAL: 8,
  BOOLEAN: 1,
};

// Helper: write 2-byte int16 (network byte order)
function writeInt16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeInt16BE(value, 0);
  return buf;
}

// Helper: write 4-byte int32 (network byte order)
function writeInt32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return buf;
}

// Helper: write null-terminated string
function writeString(str: string): Buffer {
  return Buffer.concat([Buffer.from(str, 'utf-8'), Buffer.alloc(1)]);
}

// Build a regular pgwire message: type byte + length(int32) + payload
function buildMessage(type: string, payload: Buffer): Buffer {
  const len = 4 + payload.length; // length includes itself
  return Buffer.concat([
    Buffer.from([type.charCodeAt(0)]),
    writeInt32(len),
    payload,
  ]);
}

/**
 * Parse StartupMessage (special format: no type byte, just length + protocol + params)
 * Returns the parameters map.
 */
export function parseStartupMessage(buffer: Buffer): { protocol: number; params: Record<string, string> } {
  let offset = 0;
  const length = buffer.readUInt32BE(offset);
  offset += 4;
  const protocol = buffer.readUInt32BE(offset);
  offset += 4;

  // Check for SSL request code
  if (protocol === 80877103) {
    return { protocol, params: {} };
  }

  const params: Record<string, string> = {};
  while (offset < length) {
    const keyEnd = buffer.indexOf(0, offset);
    if (keyEnd === -1) break;
    const key = buffer.toString('utf-8', offset, keyEnd);
    offset = keyEnd + 1;

    const valEnd = buffer.indexOf(0, offset);
    if (valEnd === -1) break;
    const val = buffer.toString('utf-8', offset, valEnd);
    offset = valEnd + 1;

    if (key === '') break; // empty string terminator
    params[key] = val;
  }

  return { protocol, params };
}

/**
 * Parse Query message (type 'Q').
 * Returns the SQL string (without the trailing null).
 */
export function parseQueryMessage(buffer: Buffer): string {
  // Skip type byte (1) + length (4)
  // Payload is null-terminated string
  const payload = buffer.subarray(5);
  // Remove trailing null
  const nullIdx = payload.indexOf(0);
  if (nullIdx >= 0) {
    return payload.toString('utf-8', 0, nullIdx);
  }
  return payload.toString('utf-8');
}

/**
 * AuthenticationOk message
 */
export function encodeAuthOk(): Buffer {
  return buildMessage('R', writeInt32(0));
}

/**
 * ParameterStatus message
 */
export function encodeParameterStatus(key: string, value: string): Buffer {
  const payload = Buffer.concat([writeString(key), writeString(value)]);
  return buildMessage('S', payload);
}

/**
 * BackendKeyData message
 */
export function encodeBackendKeyData(pid: number, secretKey: number): Buffer {
  const payload = Buffer.concat([writeInt32(pid), writeInt32(secretKey)]);
  return buildMessage('K', payload);
}

/**
 * ReadyForQuery message
 */
export function encodeReadyForQuery(): Buffer {
  return buildMessage('Z', Buffer.from([0x49])); // 'I' = idle
}

/**
 * RowDescription message for a SELECT result.
 * columns: array of { name, type }
 */
export function encodeRowDescription(columns: { name: string; type: ColumnType }[]): Buffer {
  const payloadParts: Buffer[] = [];

  // Number of columns (int16)
  payloadParts.push(writeInt16(columns.length));

  for (const col of columns) {
    const oid = OID[col.type] || 25; // default to TEXT
    const size = TYPE_SIZE[col.type] || -1;

    payloadParts.push(writeString(col.name));   // field name (null-terminated)
    payloadParts.push(writeInt32(0));           // table OID (0 = unknown)
    payloadParts.push(writeInt16(0));           // attribute number (0 = unknown)
    payloadParts.push(writeInt32(oid));          // type OID
    payloadParts.push(writeInt16(size));         // type size
    payloadParts.push(writeInt32(-1));           // type modifier (-1 = unspecified)
    payloadParts.push(writeInt16(0));           // format code (0 = text)
  }

  return buildMessage('T', Buffer.concat(payloadParts));
}

/**
 * DataRow message for one row of results.
 * values: array of string values (or null)
 */
export function encodeDataRow(values: (string | null)[]): Buffer {
  const payloadParts: Buffer[] = [];

  // Number of columns (int16)
  payloadParts.push(writeInt16(values.length));

  for (const val of values) {
    if (val === null || val === undefined) {
      // NULL indicator: int32(-1)
      payloadParts.push(writeInt32(-1));
    } else {
      const valBuf = Buffer.from(String(val), 'utf-8');
      payloadParts.push(writeInt32(valBuf.length));
      payloadParts.push(valBuf);
    }
  }

  return buildMessage('D', Buffer.concat(payloadParts));
}

/**
 * CommandComplete message
 * tag examples: 'SELECT 5', 'INSERT 0 1', 'UPDATE 3', 'DELETE 2', 'CREATE TABLE', 'DROP TABLE'
 */
export function encodeCommandComplete(tag: string): Buffer {
  return buildMessage('C', writeString(tag));
}

/**
 * ErrorResponse message.
 * Sends severity, SQL state code, and message.
 */
export function encodeError(message: string): Buffer {
  const payloadParts: Buffer[] = [];

  // Severity (S)
  payloadParts.push(Buffer.from([0x53])); // 'S'
  payloadParts.push(writeString('ERROR'));

  // SQL state (C) - use 'XX000' for internal error
  payloadParts.push(Buffer.from([0x43])); // 'C'
  payloadParts.push(writeString('XX000'));

  // Message (M)
  payloadParts.push(Buffer.from([0x4d])); // 'M'
  payloadParts.push(writeString(message));

  // Terminator: null byte
  payloadParts.push(Buffer.alloc(1));

  return buildMessage('E', Buffer.concat(payloadParts));
}

/**
 * Full query result: RowDescription + DataRows + CommandComplete + ReadyForQuery
 */
export function encodeQueryResult(
  columns: { name: string; type: ColumnType }[],
  rows: (string | null)[][],
  command: string,
  rowCount: number
): Buffer[] {
  const messages: Buffer[] = [];

  const tag = command === 'SELECT'
    ? `SELECT ${rowCount}`
    : command === 'INSERT'
      ? `INSERT 0 ${rowCount}`
      : command === 'UPDATE'
        ? `UPDATE ${rowCount}`
        : command === 'DELETE'
          ? `DELETE ${rowCount}`
          : command;

  if (command === 'SELECT') {
    messages.push(encodeRowDescription(columns));
    for (const row of rows) {
      messages.push(encodeDataRow(row));
    }
  }

  messages.push(encodeCommandComplete(tag));
  messages.push(encodeReadyForQuery());

  return messages;
}

/**
 * Error response sequence: ErrorResponse + ReadyForQuery
 */
export function encodeErrorResponse(message: string): Buffer[] {
  return [encodeError(message), encodeReadyForQuery()];
}

/**
 * Startup response sequence (after auth): AuthOk + ParameterStatuses + BackendKeyData + ReadyForQuery
 */
export function encodeStartupResponse(pid: number, secretKey: number): Buffer[] {
  return [
    encodeAuthOk(),
    encodeParameterStatus('server_version', '16.0'),
    encodeParameterStatus('server_encoding', 'UTF8'),
    encodeParameterStatus('client_encoding', 'UTF8'),
    encodeParameterStatus('DateStyle', 'ISO, MDY'),
    encodeParameterStatus('integer_datetimes', 'on'),
    encodeParameterStatus('standard_conforming_strings', 'on'),
    encodeBackendKeyData(pid, secretKey),
    encodeReadyForQuery(),
  ];
}

// SSL reject: single byte 'N'
export function encodeSSLReject(): Buffer {
  return Buffer.from([0x4e]); // 'N'
}
