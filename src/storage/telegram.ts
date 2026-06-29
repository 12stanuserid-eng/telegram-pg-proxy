import { ColumnDef } from '../sql/types.js';
import { StorageBackend, RowData, TableInfo, StorageState, WhereCondition } from './types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const BOT_API = 'https://api.telegram.org/bot';

class RateLimiter {
  private lastRequestTime = 0;
  private minInterval: number;
  private retryCount = 3;
  private baseBackoff = 1000; // 1 second

  constructor(requestsPerMinute = 20) {
    // ~3 seconds between requests
    this.minInterval = Math.ceil(60000 / requestsPerMinute);
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;

    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.retryCount; attempt++) {
      try {
        this.lastRequestTime = Date.now();
        const result = await fn();
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.retryCount - 1) {
          const backoff = this.baseBackoff * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }
    throw lastError!;
  }
}

export class TelegramStorage implements StorageBackend {
  private botToken: string;
  private channelId: string;
  private apiBase: string;
  private state!: StorageState;
  private statePath: string;
  private rateLimiter: RateLimiter;

  constructor(botToken: string, channelId: string) {
    this.botToken = botToken;
    this.channelId = channelId;
    this.apiBase = `${BOT_API}${botToken}`;
    this.statePath = process.env.STATE_FILE || join(process.cwd(), 'state.json');
    this.rateLimiter = new RateLimiter(20);
  }

  async init(): Promise<void> {
    // Verify bot is admin in the channel
    await this.verifyAccess();

    // Load or initialize state
    this.loadState();
  }

  private async verifyAccess(): Promise<void> {
    const data = await this.apiCall('getChat', { chat_id: this.channelId });
    if (!data.ok) {
      throw new Error(`Cannot access channel ${this.channelId}: ${data.description}`);
    }
    const chat = data.result;
    if (chat.type !== 'channel') {
      throw new Error(`Chat ${this.channelId} is not a channel (type: ${chat.type})`);
    }
  }

  private loadState(): void {
    if (existsSync(this.statePath)) {
      try {
        const content = readFileSync(this.statePath, 'utf-8');
        this.state = JSON.parse(content);
      } catch {
        console.warn('Failed to load state file, starting fresh');
        this.state = { tables: {} };
      }
    } else {
      this.state = { tables: {} };
    }
  }

  private saveState(): void {
    try {
      const dir = dirname(this.statePath);
      // Ensure directory exists
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save state file:', err);
    }
  }

  private async apiCall(method: string, params: Record<string, any> = {}): Promise<any> {
    return this.rateLimiter.schedule(async () => {
      const url = `${this.apiBase}/${method}`;
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        body.append(key, String(value));
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = await response.json();
      if (!data.ok) {
        throw new Error(`Telegram API error (${method}): ${data.description}`);
      }
      return data;
    });
  }

  async createTable(name: string, columns: ColumnDef[]): Promise<void> {
    if (this.state.tables[name]) {
      throw new Error(`Table "${name}" already exists`);
    }

    // Send schema message to channel
    const schemaData = JSON.stringify({ type: 'schema', table: name, columns });
    const result = await this.apiCall('sendMessage', {
      chat_id: this.channelId,
      text: `📋 TABLE: ${name}`,
    });

    const schemaMessageId = result.result.message_id;

    // Store table info in state
    this.state.tables[name] = {
      name,
      columns,
      schemaMessageId,
      rows: [],
    };

    // Save state after creating table
    this.saveState();
  }

  async dropTable(name: string): Promise<void> {
    const table = this.state.tables[name];
    if (!table) {
      throw new Error(`Table "${name}" does not exist`);
    }

    // Delete all row messages
    for (const row of table.rows) {
      try {
        await this.apiCall('deleteMessage', {
          chat_id: this.channelId,
          message_id: row.messageId,
        });
      } catch {
        // Ignore errors when deleting individual messages
      }
    }

    // Delete schema message
    try {
      await this.apiCall('deleteMessage', {
        chat_id: this.channelId,
        message_id: table.schemaMessageId,
      });
    } catch {
      // Ignore
    }

    delete this.state.tables[name];
    this.saveState();
  }

  async insertRow(tableName: string, values: Record<string, string>): Promise<void> {
    const table = this.state.tables[tableName];
    if (!table) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    // Prepare row data as JSON
    const rowData = JSON.stringify(values);

    // Send message to channel
    const result = await this.apiCall('sendMessage', {
      chat_id: this.channelId,
      text: rowData,
    });

    const messageId = result.result.message_id;

    // Add to state
    table.rows.push({
      messageId,
      values,
    });

    // Keep a reasonable number of message IDs in memory for editing
    // If too many rows, prune older ones from the state but data stays in Telegram
    this.saveState();
  }

  async selectRows(
    tableName: string,
    where?: WhereCondition[]
  ): Promise<Record<string, string>[]> {
    const table = this.state.tables[tableName];
    if (!table) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    let rows = table.rows.map(r => r.values);

    if (where && where.length > 0) {
      rows = rows.filter(row => {
        return where!.every(cond => {
          const rowVal = row[cond.left];
          if (rowVal === undefined) return false;
          return this.evaluateCondition(rowVal, cond.operator, cond.right);
        });
      });
    }

    return rows;
  }

  async updateRows(
    tableName: string,
    sets: Record<string, string>,
    where?: WhereCondition[]
  ): Promise<number> {
    const table = this.state.tables[tableName];
    if (!table) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    // Find matching rows
    const matchingRows = table.rows.filter(row => {
      if (!where || where.length === 0) return true;
      return where!.every(cond => {
        const rowVal = row.values[cond.left];
        if (rowVal === undefined) return false;
        return this.evaluateCondition(rowVal, cond.operator, cond.right);
      });
    });

    // Update each matching row
    for (const row of matchingRows) {
      const newValues = { ...row.values, ...sets };
      row.values = newValues;

      // Update Telegram message
      try {
        await this.apiCall('editMessageText', {
          chat_id: this.channelId,
          message_id: row.messageId,
          text: JSON.stringify(newValues),
        });
      } catch {
        // If edit fails (e.g., message too old), still update local state
      }
    }

    this.saveState();
    return matchingRows.length;
  }

  async deleteRows(
    tableName: string,
    where?: WhereCondition[]
  ): Promise<number> {
    const table = this.state.tables[tableName];
    if (!table) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    // Find matching rows
    const toDelete = table.rows.filter(row => {
      if (!where || where.length === 0) return true;
      return where!.every(cond => {
        const rowVal = row.values[cond.left];
        if (rowVal === undefined) return false;
        return this.evaluateCondition(rowVal, cond.operator, cond.right);
      });
    });

    // Delete from Telegram
    const deletedIds = new Set(toDelete.map(r => r.messageId));
    for (const row of toDelete) {
      try {
        await this.apiCall('deleteMessage', {
          chat_id: this.channelId,
          message_id: row.messageId,
        });
      } catch {
        // Ignore delete errors
      }
    }

    // Remove from state
    table.rows = table.rows.filter(r => !deletedIds.has(r.messageId));
    this.saveState();

    return toDelete.length;
  }

  async getTableInfo(name: string): Promise<TableInfo | undefined> {
    return this.state.tables[name];
  }

  private evaluateCondition(rowValue: string, operator: string, condValue: string): boolean {
    const rowNum = Number(rowValue);
    const condNum = Number(condValue);
    const isNumeric = !isNaN(rowNum) && !isNaN(condNum) && rowValue.trim() !== '' && condValue.trim() !== '';

    switch (operator) {
      case '=':
        return isNumeric ? rowNum === condNum : rowValue === condValue;
      case '!=':
        return isNumeric ? rowNum !== condNum : rowValue !== condValue;
      case '>':
        return isNumeric ? rowNum > condNum : rowValue > condValue;
      case '<':
        return isNumeric ? rowNum < condNum : rowValue < condValue;
      case '>=':
        return isNumeric ? rowNum >= condNum : rowValue >= condValue;
      case '<=':
        return isNumeric ? rowNum <= condNum : rowValue <= condValue;
      default:
        return false;
    }
  }
}
