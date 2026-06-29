export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN';

export interface ColumnDef {
  name: string;
  type: ColumnType;
}

export interface WhereCondition {
  left: string;
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=';
  right: string;
}

export interface WhereClause {
  conditions: WhereCondition[];
}

export interface CreateTableStatement {
  type: 'CREATE_TABLE';
  tableName: string;
  columns: ColumnDef[];
}

export interface InsertStatement {
  type: 'INSERT';
  tableName: string;
  columns: string[];
  values: string[];
}

export interface SelectStatement {
  type: 'SELECT';
  columns: string[];
  tableName: string;
  where?: WhereClause;
}

export interface UpdateStatement {
  type: 'UPDATE';
  tableName: string;
  sets: { column: string; value: string }[];
  where?: WhereClause;
}

export interface DeleteStatement {
  type: 'DELETE';
  tableName: string;
  where?: WhereClause;
}

export interface DropTableStatement {
  type: 'DROP_TABLE';
  tableName: string;
}

export type ParsedStatement =
  | CreateTableStatement
  | InsertStatement
  | SelectStatement
  | UpdateStatement
  | DeleteStatement
  | DropTableStatement;
