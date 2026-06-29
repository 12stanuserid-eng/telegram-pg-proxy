import {
  ParsedStatement,
  ColumnDef,
  ColumnType,
  WhereClause,
  WhereCondition,
} from './types.js';

type TokenType =
  | 'KEYWORD'
  | 'IDENTIFIER'
  | 'STRING'
  | 'NUMBER'
  | 'OPERATOR'
  | 'PUNCTUATION'
  | 'EOF';

interface Token {
  type: TokenType;
  value: string;
}

const KEYWORDS = new Set([
  'CREATE', 'TABLE', 'DROP', 'INSERT', 'INTO', 'VALUES',
  'SELECT', 'FROM', 'WHERE', 'UPDATE', 'SET', 'DELETE',
  'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE',
  'TEXT', 'INTEGER', 'INT', 'REAL', 'BOOLEAN', 'BOOL',
  'PRIMARY', 'KEY', 'DEFAULT',
]);

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    // Whitespace
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }

    // Single-line comment
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }

    // Multi-line comment
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // String literal
    if (sql[i] === "'") {
      let value = '';
      i++; // skip opening quote
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            // Escaped quote
            value += "'";
            i += 2;
            continue;
          }
          i++; // skip closing quote
          break;
        }
        value += sql[i];
        i++;
      }
      tokens.push({ type: 'STRING', value });
      continue;
    }

    // Number
    if (/[0-9]/.test(sql[i]) || (sql[i] === '-' && i + 1 < sql.length && /[0-9]/.test(sql[i + 1]) && tokens.length > 0 && tokens[tokens.length - 1].type === 'OPERATOR')) {
      // Actually, negative numbers need context. Let's handle positive numbers here
      // and handle negative numbers during parsing.
      if (sql[i] === '-' && tokens.length > 0 && tokens[tokens.length - 1].type === 'OPERATOR') {
        // This is a negative number, handled during tokenization of the operator
      }
      let num = '';
      // Handle positive numbers
      if (/[0-9]/.test(sql[i])) {
        while (i < sql.length && (/[0-9.]/.test(sql[i]))) {
          num += sql[i];
          i++;
        }
        // Make sure it's not just a dot
        if (num !== '.' && num !== '') {
          tokens.push({ type: 'NUMBER', value: num });
          continue;
        }
      }
    }

    // Handle negative numbers - check if '-' is followed by a digit
    if (sql[i] === '-' && i + 1 < sql.length && /[0-9]/.test(sql[i + 1])) {
      // Check if previous token is an operator or start of expression
      const prev = tokens[tokens.length - 1];
      if (!prev || prev.type === 'OPERATOR' || prev.type === 'PUNCTUATION' || prev.type === 'KEYWORD') {
        let num = '-';
        i++;
        while (i < sql.length && (/[0-9.]/.test(sql[i]))) {
          num += sql[i];
          i++;
        }
        if (num !== '-') {
          tokens.push({ type: 'NUMBER', value: num });
          continue;
        }
      }
    }

    // Multi-char operators: !=, >=, <=
    if ((sql[i] === '!' && sql[i + 1] === '=') ||
        (sql[i] === '>' && sql[i + 1] === '=') ||
        (sql[i] === '<' && sql[i + 1] === '=')) {
      tokens.push({ type: 'OPERATOR', value: sql[i] + sql[i + 1] });
      i += 2;
      continue;
    }

    // Single-char operators
    if ('=<>!'.includes(sql[i])) {
      tokens.push({ type: 'OPERATOR', value: sql[i] });
      i++;
      continue;
    }

    // Punctuation
    if ('(),;*'.includes(sql[i])) {
      tokens.push({ type: 'PUNCTUATION', value: sql[i] });
      i++;
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(sql[i]) || sql[i] === '"') {
      let word = '';
      if (sql[i] === '"') {
        // Quoted identifier
        i++;
        while (i < sql.length && sql[i] !== '"') {
          if (sql[i] === '\\') {
            i++;
            if (i < sql.length) {
              word += sql[i];
              i++;
            }
          } else {
            word += sql[i];
            i++;
          }
        }
        i++; // skip closing quote
        tokens.push({ type: 'IDENTIFIER', value: word });
      } else {
        while (i < sql.length && /[a-zA-Z0-9_]/.test(sql[i])) {
          word += sql[i];
          i++;
        }
        const upper = word.toUpperCase();
        if (KEYWORDS.has(upper)) {
          tokens.push({ type: 'KEYWORD', value: upper });
        } else {
          tokens.push({ type: 'IDENTIFIER', value: word });
        }
      }
      continue;
    }

    // Skip unknown characters
    i++;
  }

  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

class ParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParserError';
  }
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] || { type: 'EOF', value: '' };
  }

  private advance(): Token {
    const token = this.tokens[this.pos] || { type: 'EOF', value: '' };
    this.pos++;
    return token;
  }

  private expect(type: TokenType, value?: string): Token {
    const token = this.advance();
    if (token.type !== type || (value !== undefined && token.value.toUpperCase() !== value.toUpperCase())) {
      throw new ParserError(
        `Expected ${value ? `${type}(${value})` : type}, got ${token.type}(${token.value})`
      );
    }
    return token;
  }

  private match(type: TokenType, value?: string): boolean {
    const token = this.peek();
    if (token.type === type && (value === undefined || token.value.toUpperCase() === value.toUpperCase())) {
      this.advance();
      return true;
    }
    return false;
  }

  parseCreateTable(): ParsedStatement {
    this.expect('KEYWORD', 'CREATE');
    this.expect('KEYWORD', 'TABLE');
    const tableName = this.expect('IDENTIFIER').value;
    this.expect('PUNCTUATION', '(');
    const columns: ColumnDef[] = [];
    do {
      const colName = this.expect('IDENTIFIER').value;
      const typeToken = this.advance();
      if (typeToken.type !== 'KEYWORD') {
        throw new ParserError(`Expected column type after ${colName}, got ${typeToken.value}`);
      }
      let colType: ColumnType;
      switch (typeToken.value.toUpperCase()) {
        case 'TEXT':
          colType = 'TEXT';
          break;
        case 'INTEGER':
        case 'INT':
          colType = 'INTEGER';
          break;
        case 'REAL':
        case 'FLOAT':
        case 'DOUBLE':
          colType = 'REAL';
          break;
        case 'BOOLEAN':
        case 'BOOL':
          colType = 'BOOLEAN';
          break;
        default:
          throw new ParserError(`Unknown column type: ${typeToken.value}`);
      }
      columns.push({ name: colName, type: colType });

      // Skip optional constraints (PRIMARY KEY, NOT NULL, DEFAULT, etc.)
      while (this.peek().type === 'KEYWORD' &&
             ![')', ','].includes(this.peek().value) &&
             this.peek().value !== 'CREATE') {
        if (this.match('KEYWORD', 'PRIMARY')) { this.match('KEYWORD', 'KEY'); continue; }
        if (this.match('KEYWORD', 'NOT')) { this.match('KEYWORD', 'NULL'); continue; }
        if (this.match('KEYWORD', 'NULL')) { continue; }
        if (this.match('KEYWORD', 'DEFAULT')) {
          // Skip default value (identifier, string, or number)
          this.advance();
          continue;
        }
        if (this.match('KEYWORD', 'REFERENCES')) {
          this.expect('IDENTIFIER');
          this.match('PUNCTUATION', '(');
          if (!this.match('PUNCTUATION', ')')) {
            this.expect('IDENTIFIER');
            this.expect('PUNCTUATION', ')');
          }
          continue;
        }
        break;
      }
    } while (this.match('PUNCTUATION', ','));
    this.expect('PUNCTUATION', ')');
    return { type: 'CREATE_TABLE', tableName, columns };
  }

  parseInsert(): ParsedStatement {
    this.expect('KEYWORD', 'INSERT');
    this.expect('KEYWORD', 'INTO');
    const tableName = this.expect('IDENTIFIER').value;

    let columns: string[] = [];
    if (this.match('PUNCTUATION', '(')) {
      columns.push(this.expect('IDENTIFIER').value);
      while (this.match('PUNCTUATION', ',')) {
        columns.push(this.expect('IDENTIFIER').value);
      }
      this.expect('PUNCTUATION', ')');
    }

    this.expect('KEYWORD', 'VALUES');
    this.expect('PUNCTUATION', '(');
    const values: string[] = [];
    values.push(this.parseValue());
    while (this.match('PUNCTUATION', ',')) {
      values.push(this.parseValue());
    }
    this.expect('PUNCTUATION', ')');

    return { type: 'INSERT', tableName, columns, values };
  }

  parseSelect(): ParsedStatement {
    this.expect('KEYWORD', 'SELECT');

    const columns: string[] = [];
    if (this.match('PUNCTUATION', '*')) {
      columns.push('*');
    } else {
      columns.push(this.parseIdentifierOrWildcard());
      while (this.match('PUNCTUATION', ',')) {
        columns.push(this.parseIdentifierOrWildcard());
      }
    }

    this.expect('KEYWORD', 'FROM');
    const tableName = this.expect('IDENTIFIER').value;

    let where: WhereClause | undefined;
    if (this.match('KEYWORD', 'WHERE')) {
      where = this.parseWhereClause();
    }

    return { type: 'SELECT', columns, tableName, where };
  }

  parseUpdate(): ParsedStatement {
    this.expect('KEYWORD', 'UPDATE');
    const tableName = this.expect('IDENTIFIER').value;
    this.expect('KEYWORD', 'SET');

    const sets: { column: string; value: string }[] = [];
    do {
      const col = this.expect('IDENTIFIER').value;
      this.expect('OPERATOR', '=');
      const val = this.parseValue();
      sets.push({ column: col, value: val });
    } while (this.match('PUNCTUATION', ','));

    let where: WhereClause | undefined;
    if (this.match('KEYWORD', 'WHERE')) {
      where = this.parseWhereClause();
    }

    return { type: 'UPDATE', tableName, sets, where };
  }

  parseDelete(): ParsedStatement {
    this.expect('KEYWORD', 'DELETE');
    this.expect('KEYWORD', 'FROM');
    const tableName = this.expect('IDENTIFIER').value;

    let where: WhereClause | undefined;
    if (this.match('KEYWORD', 'WHERE')) {
      where = this.parseWhereClause();
    }

    return { type: 'DELETE', tableName, where };
  }

  parseDropTable(): ParsedStatement {
    this.expect('KEYWORD', 'DROP');
    this.expect('KEYWORD', 'TABLE');
    const tableName = this.expect('IDENTIFIER').value;
    return { type: 'DROP_TABLE', tableName };
  }

  private parseWhereClause(): WhereClause {
    const conditions: WhereCondition[] = [];
    do {
      const left = this.expect('IDENTIFIER').value;
      const operator = this.parseOperator();
      const right = this.parseValue();
      conditions.push({ left, operator, right });
    } while (this.match('KEYWORD', 'AND'));
    return { conditions };
  }

  private parseOperator(): WhereCondition['operator'] {
    const token = this.advance();
    if (token.type !== 'OPERATOR') {
      throw new ParserError(`Expected operator, got ${token.type}(${token.value})`);
    }
    const validOps = ['=', '!=', '>', '<', '>=', '<='];
    if (!validOps.includes(token.value)) {
      throw new ParserError(`Invalid operator: ${token.value}`);
    }
    return token.value as WhereCondition['operator'];
  }

  private parseValue(): string {
    const token = this.peek();
    if (token.type === 'STRING') {
      this.advance();
      return token.value;
    }
    if (token.type === 'NUMBER') {
      this.advance();
      return token.value;
    }
    if (token.type === 'KEYWORD' && (token.value === 'TRUE' || token.value === 'FALSE' || token.value === 'NULL')) {
      this.advance();
      return token.value === 'NULL' ? '' : token.value;
    }
    // Fallback: treat as identifier (for column references in VALUES, etc.)
    return this.expect('IDENTIFIER').value;
  }

  private parseIdentifierOrWildcard(): string {
    const token = this.peek();
    if (token.type === 'PUNCTUATION' && token.value === '*') {
      this.advance();
      return '*';
    }
    return this.expect('IDENTIFIER').value;
  }
}

function parseStatement(tokens: Token[]): ParsedStatement {
  const firstToken = tokens[0];
  if (firstToken.type !== 'KEYWORD') {
    throw new ParserError(`Expected SQL keyword at start, got ${firstToken.value}`);
  }

  const parser = new Parser(tokens);
  switch (firstToken.value.toUpperCase()) {
    case 'CREATE':
      return parser.parseCreateTable();
    case 'INSERT':
      return parser.parseInsert();
    case 'SELECT':
      return parser.parseSelect();
    case 'UPDATE':
      return parser.parseUpdate();
    case 'DELETE':
      return parser.parseDelete();
    case 'DROP':
      return parser.parseDropTable();
    default:
      throw new ParserError(`Unsupported statement type: ${firstToken.value}`);
  }
}

export function parseSQL(sql: string): ParsedStatement {
  const tokens = tokenize(sql);
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0].type === 'EOF')) {
    throw new ParserError('Empty SQL statement');
  }
  return parseStatement(tokens);
}
