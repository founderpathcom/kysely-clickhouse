import { MysqlQueryCompiler } from 'kysely'

import { escapeIdentifier, escapeStringLiteral, formatValue } from './ClickhouseSql'

const PLAIN_JSON_PATH_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const JSON_PATH_ARRAY_LOCATION = /^(?:\d+|last|#-\d+)$/

/**
 * ClickHouse SQL is close enough to MySQL for the MySQL compiler to do most of the work, but the
 * two disagree on escaping: ClickHouse reads a backslash as an escape character inside string
 * literals and inside backtick-quoted identifiers.
 */
export class ClickhouseQueryCompiler extends MysqlQueryCompiler {
  protected override sanitizeIdentifier(identifier: string): string {
    return escapeIdentifier(identifier)
  }

  // Used by newer Kysely versions for every string literal written into the SQL. Older versions
  // do not have this hook, which is why it is not marked as an override.
  protected sanitizeStringLiteral(value: string): string {
    return escapeStringLiteral(value)
  }

  // Values that Kysely writes into the SQL itself instead of binding, such as `sql.lit()`.
  protected override appendImmediateValue(value: unknown): void {
    this.append(formatValue(value))
  }

  // A JSON path is written as a string literal: '$.key[0]'. Kysely before 0.28.17 wrote the keys
  // into it as they are, so a key could close the literal, or add steps to the path.
  protected override visitJSONPathLeg(node: { type: string; value: string | number }): void {
    const value = String(node.value)

    if (node.type === 'ArrayLocation') {
      if (!JSON_PATH_ARRAY_LOCATION.test(value)) {
        throw new Error(`Invalid JSON path array location: ${value}`)
      }

      this.append(`[${value}]`)
    } else {
      const key = PLAIN_JSON_PATH_KEY.test(value) ? value : `"${value.replace(/[\\"]/g, '\\$&')}"`

      this.append(`.${escapeStringLiteral(key)}`)
    }
  }
}
