import { StorageBackend, WhereCondition } from '../storage/types.js';
import { ColumnDef, ColumnType, ParsedStatement } from '../sql/types.js';

export interface QueryResult {
  columns: { name: string; type: ColumnType }[];
  rows: any[][];
  command: string;
  rowCount: number;
}

export class QueryEngine {
  private storage: StorageBackend;

  constructor(storage: StorageBackend) {
    this.storage = storage;
  }

  async execute(statement: ParsedStatement): Promise<QueryResult> {
    switch (statement.type) {
      case 'CREATE_TABLE':
        return this.executeCreateTable(statement);
      case 'INSERT':
        return this.executeInsert(statement);
      case 'SELECT':
        return this.executeSelect(statement);
      case 'UPDATE':
        return this.executeUpdate(statement);
      case 'DELETE':
        return this.executeDelete(statement);
      case 'DROP_TABLE':
        return this.executeDropTable(statement);
    }
  }

  private async executeCreateTable(stmt: any): Promise<QueryResult> {
    const tableName = stmt.tableName;
    const columns: ColumnDef[] = stmt.columns;

    await this.storage.createTable(tableName, columns);

    return {
      columns: [],
      rows: [],
      command: 'CREATE TABLE',
      rowCount: 0,
    };
  }

  private async executeInsert(stmt: any): Promise<QueryResult> {
    const tableName = stmt.tableName;
    const tableInfo = await this.storage.getTableInfo(tableName);
    if (!tableInfo) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    const insertCols = stmt.columns.length > 0 ? stmt.columns : tableInfo.columns.map((c: ColumnDef) => c.name);
    const insertVals = stmt.values;

    // Build the row as a column-name -> value map
    const row: Record<string, string> = {};
    for (let i = 0; i < insertCols.length; i++) {
      const colName = insertCols[i];
      const colDef = tableInfo.columns.find((c: ColumnDef) => c.name === colName);
      if (!colDef) {
        throw new Error(`Column "${colName}" does not exist in table "${tableName}"`);
      }
      const val = i < insertVals.length ? insertVals[i] : '';
      row[colName] = this.coerceValue(val, colDef.type);
    }

    // Fill default (empty) values for columns not in the insert list
    for (const col of tableInfo.columns) {
      if (!(col.name in row)) {
        row[col.name] = '';
      }
    }

    await this.storage.insertRow(tableName, row);

    return {
      columns: [],
      rows: [],
      command: 'INSERT 0 1',
      rowCount: 1,
    };
  }

  private async executeSelect(stmt: any): Promise<QueryResult> {
    const tableName = stmt.tableName;
    const tableInfo = await this.storage.getTableInfo(tableName);
    if (!tableInfo) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    const whereConditions: WhereCondition[] | undefined = stmt.where?.conditions;

    const rows = await this.storage.selectRows(tableName, whereConditions);

    const columns = stmt.columns.includes('*')
      ? tableInfo.columns
      : tableInfo.columns.filter((c: ColumnDef) => stmt.columns.includes(c.name));

    if (columns.length === 0 && !stmt.columns.includes('*')) {
      // If none of the requested columns exist, check if any match
      const cols = stmt.columns.filter((c: string) =>
        tableInfo.columns.some((td: ColumnDef) => td.name === c)
      );
      if (cols.length === 0) {
        throw new Error(`None of the requested columns exist in table "${tableName}"`);
      }
    }

    // If specific columns requested, filter
    const selectedCols = stmt.columns.includes('*')
      ? tableInfo.columns
      : tableInfo.columns.filter((c: ColumnDef) => stmt.columns.includes(c.name));

    // Map rows to columnar format
    const dataRows = rows.map(row => {
      return selectedCols.map((col: ColumnDef) => {
        const val = row[col.name];
        return val !== undefined ? this.formatValue(val, col.type) : null;
      });
    });

    return {
      columns: selectedCols.map((c: ColumnDef) => ({ name: c.name, type: c.type })),
      rows: dataRows,
      command: 'SELECT',
      rowCount: dataRows.length,
    };
  }

  private async executeUpdate(stmt: any): Promise<QueryResult> {
    const tableName = stmt.tableName;
    const tableInfo = await this.storage.getTableInfo(tableName);
    if (!tableInfo) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    const sets: Record<string, string> = {};
    for (const s of stmt.sets) {
      const colDef = tableInfo.columns.find((c: ColumnDef) => c.name === s.column);
      if (!colDef) {
        throw new Error(`Column "${s.column}" does not exist in table "${tableName}"`);
      }
      sets[s.column] = this.coerceValue(s.value, colDef.type);
    }

    const whereConditions: WhereCondition[] | undefined = stmt.where?.conditions;
    const updated = await this.storage.updateRows(tableName, sets, whereConditions);

    return {
      columns: [],
      rows: [],
      command: 'UPDATE',
      rowCount: updated,
    };
  }

  private async executeDelete(stmt: any): Promise<QueryResult> {
    const tableName = stmt.tableName;
    const tableInfo = await this.storage.getTableInfo(tableName);
    if (!tableInfo) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    const whereConditions: WhereCondition[] | undefined = stmt.where?.conditions;
    const deleted = await this.storage.deleteRows(tableName, whereConditions);

    return {
      columns: [],
      rows: [],
      command: 'DELETE',
      rowCount: deleted,
    };
  }

  private async executeDropTable(stmt: any): Promise<QueryResult> {
    await this.storage.dropTable(stmt.tableName);

    return {
      columns: [],
      rows: [],
      command: 'DROP TABLE',
      rowCount: 0,
    };
  }

  private coerceValue(value: string, type: ColumnType): string {
    switch (type) {
      case 'INTEGER': {
        const n = parseInt(value, 10);
        return isNaN(n) ? '0' : String(n);
      }
      case 'REAL': {
        const n = parseFloat(value);
        return isNaN(n) ? '0' : String(n);
      }
      case 'BOOLEAN': {
        const lower = value.toLowerCase();
        if (['true', '1', 'yes'].includes(lower)) return 'true';
        if (['false', '0', 'no'].includes(lower)) return 'false';
        return 'false';
      }
      case 'TEXT':
      default:
        return value;
    }
  }

  private formatValue(value: string, type: ColumnType): string {
    return value;
  }
}
