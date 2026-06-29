import { ColumnDef } from '../sql/types.js';

export interface RowData {
  messageId: number;
  values: Record<string, string>;
}

export interface TableInfo {
  name: string;
  columns: ColumnDef[];
  schemaMessageId: number;
  rows: RowData[];
}

export interface StorageState {
  tables: Record<string, TableInfo>;
  catalogMessageId?: number;
}

export interface StorageBackend {
  init(): Promise<void>;
  createTable(name: string, columns: ColumnDef[]): Promise<void>;
  dropTable(name: string): Promise<void>;
  insertRow(tableName: string, values: Record<string, string>): Promise<void>;
  selectRows(tableName: string, where?: WhereCondition[]): Promise<Record<string, string>[]>;
  updateRows(tableName: string, sets: Record<string, string>, where?: WhereCondition[]): Promise<number>;
  deleteRows(tableName: string, where?: WhereCondition[]): Promise<number>;
  getTableInfo(name: string): Promise<TableInfo | undefined>;
}

export interface WhereCondition {
  left: string;
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=';
  right: string;
}
