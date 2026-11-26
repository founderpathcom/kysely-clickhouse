import { randomUUID } from 'node:crypto'

import type { ClickHouseClient } from '@clickhouse/client'
import type {
  CompiledQuery,
  DatabaseConnection,
  InsertQueryNode,
  OperationNode,
  PrimitiveValueListNode,
  QueryResult,
  ValueListNode,
  ValueNode,
  ValuesNode,
} from 'kysely'

import { createClickhouseClient } from './ClickhouseClient'
import type { ClickhouseDialectConfig } from './ClickhouseDialect'
import { interpolateParameters, quoteIdentifier } from './ClickhouseSql'

// `update `db`.`table` set ...`, as compiled by Kysely.
const QUOTED_IDENTIFIER = '`(?:[^`\\\\]|\\\\.|``)+`'
const UPDATE_STATEMENT = new RegExp(`^update ((?:${QUOTED_IDENTIFIER}\\.)*${QUOTED_IDENTIFIER}) set`, 'i')

// Stands for a column that a row leaves to its default value.
const OMITTED = Symbol('omitted')

type ResponseHeaders = Record<string, string | string[] | undefined>

// A query can fail after ClickHouse has started to send its result. Older versions then answer
// with HTTP 200 and report the error inside the output: as an `exception` key next to the rows
// that were already written, or as a last row in the row formats. That row is told apart from a
// row of data by the space after the colon, which ClickHouse does not write in rows.
const STREAMED_EXCEPTION = '{"exception": "'

function throwIfFailed(response: object): void {
  const { exception } = response as { exception?: unknown }

  if (typeof exception === 'string') {
    throw new Error(exception)
  }
}

function header(headers: ResponseHeaders | undefined, name: string): string | undefined {
  const value = headers?.[name]

  return Array.isArray(value) ? value[0] : value
}

function writtenRows(headers: ResponseHeaders | undefined): bigint | undefined {
  const summary = header(headers, 'x-clickhouse-summary')

  if (summary === undefined) {
    return undefined
  }

  try {
    return BigInt(JSON.parse(summary).written_rows ?? 0)
  } catch {
    return undefined
  }
}

// Makes a value safe to send as JSON, where `JSON.stringify` would throw or quietly write
// something else: a bigint throws, and NaN and the infinities become null. ClickHouse reads a
// quoted number into any numeric column.
function toJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'
  }

  if (Array.isArray(value)) {
    let copy: unknown[] | undefined

    for (let i = 0; i < value.length; i++) {
      if (value[i] === undefined) {
        // JSON would write null, which ClickHouse reads as the default value of the element type.
        throw new TypeError('Cannot insert an array that contains undefined. Use null for a NULL value.')
      }

      const item = toJsonValue(value[i])

      if (item !== value[i]) {
        copy ??= value.slice()
        copy[i] = item
      }
    }

    return copy ?? value
  }

  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    let copy: Record<string, unknown> | undefined

    for (const [key, item] of Object.entries(value)) {
      const converted = toJsonValue(item)

      if (converted !== item) {
        copy ??= { ...value }
        copy[key] = converted
      }
    }

    return copy ?? value
  }

  return value
}

interface InsertRows {
  columns: string[]
  rows: unknown[][]
}

// Returns the rows of an `insert ... values` query when every value is plain data, which lets the
// rows be sent as JSON instead of SQL. Returns undefined when the insert has to run as SQL.
function plainInsertRows(node: InsertQueryNode): InsertRows | undefined {
  if (node.values?.kind !== 'ValuesNode' || node.explain !== undefined || node.columns === undefined) {
    return undefined
  }

  const rows: unknown[][] = []

  for (const row of (node.values as ValuesNode).values) {
    if (row.kind === 'PrimitiveValueListNode') {
      rows.push((row as PrimitiveValueListNode).values.map(toJsonValue))
      continue
    }

    const values: unknown[] = []

    for (const item of (row as ValueListNode).values as ReadonlyArray<OperationNode>) {
      if (item.kind === 'ValueNode') {
        values.push(toJsonValue((item as ValueNode).value))
      } else if (item.kind === 'DefaultInsertValueNode') {
        values.push(OMITTED)
      } else {
        // An expression, such as sql`now()`, can only be evaluated as part of the SQL.
        return undefined
      }
    }

    rows.push(values)
  }

  return { columns: node.columns.map((column) => column.column.name), rows }
}

export class ClickhouseConnection implements DatabaseConnection {
  readonly #config: ClickhouseDialectConfig
  readonly #sessionId = randomUUID()
  #sharedClient: ClickHouseClient | undefined

  /**
   * @param client The client to send the queries with. The driver passes the one client it shares
   * between all of its connections; without it the connection creates its own on first use.
   */
  constructor(config: ClickhouseDialectConfig, client?: ClickHouseClient) {
    this.#config = config
    this.#sharedClient = client
  }

  get #client(): ClickHouseClient {
    this.#sharedClient ??= createClickhouseClient(this.#config)

    return this.#sharedClient
  }

  prepareQuery(compiledQuery: CompiledQuery): string {
    // ClickHouse updates rows through a mutation: ALTER TABLE ... UPDATE.
    const sql = compiledQuery.sql.replace(UPDATE_STATEMENT, 'alter table $1 update')

    return interpolateParameters(sql, compiledQuery.parameters)
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const node = compiledQuery.query

    if (node.kind === 'InsertQueryNode') {
      const insert = plainInsertRows(node)

      if (insert) {
        return this.#insertRows(node, insert)
      }
    }

    const query = this.prepareQuery(compiledQuery)

    if (node.kind === 'SelectQueryNode') {
      const resultSet = await this.#client.query({ query, session_id: this.#sessionId })
      const response = await resultSet.json<O>()

      throwIfFailed(response)

      return { rows: response.data }
    }

    if (node.kind === 'RawNode') {
      return this.#executeRaw(query)
    }

    const result = await this.#client.command({
      query,
      session_id: this.#sessionId,
      clickhouse_settings: { wait_end_of_query: 1 },
    })
    const numAffectedRows = writtenRows(result.response_headers)

    return { rows: [], numAffectedRows, numChangedRows: numAffectedRows }
  }

  async #insertRows<O>(node: InsertQueryNode, { columns, rows }: InsertRows): Promise<QueryResult<O>> {
    const into = node.into?.table
    const table = [into?.schema?.name, into?.identifier.name ?? '']
      .filter((name): name is string => name !== undefined)
      .map(quoteIdentifier)
      .join('.')

    // JSONEachRow takes one object per row, and a column that is missing from the object gets its
    // default value. Rows that have every column are sent in the more compact format.
    const hasOmittedValues = rows.some((row) => row.includes(OMITTED))
    const values: ReadonlyArray<unknown> = hasOmittedValues
      ? rows.map((row) =>
          Object.fromEntries(columns.flatMap((column, i) => (row[i] === OMITTED ? [] : [[column, row[i]]]))),
        )
      : [columns, ...rows]

    const [firstColumn, ...otherColumns] = columns.map(quoteIdentifier)

    const resultSet = await this.#client.insert({
      table,
      values,
      format: hasOmittedValues ? 'JSONEachRow' : 'JSONCompactEachRowWithNames',
      // Without the list of columns, ClickHouse skips a column that the table does not have and
      // drops its values without an error.
      columns: firstColumn === undefined ? undefined : [firstColumn, ...otherColumns],
      session_id: this.#sessionId,
    })

    const numAffectedRows = BigInt(resultSet.summary?.written_rows ?? 0)

    return { rows: [], numAffectedRows, numChangedRows: numAffectedRows }
  }

  // A raw query can be anything, so ClickHouse is asked to answer in JSON if the statement has a
  // result at all. Its response header says whether it did.
  async #executeRaw<O>(query: string): Promise<QueryResult<O>> {
    const result = await this.#client.exec({
      query,
      session_id: this.#sessionId,
      clickhouse_settings: { default_format: 'JSON', wait_end_of_query: 1 },
    })

    // The response has to be read to the end for the socket to be released.
    const chunks: Buffer[] = []
    for await (const chunk of result.stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }

    const headers: ResponseHeaders | undefined = result.response_headers
    const numAffectedRows = writtenRows(headers)

    // A statement without a result, or a query with its own FORMAT clause.
    if (header(headers, 'x-clickhouse-format') !== 'JSON') {
      return { rows: [], numAffectedRows, numChangedRows: numAffectedRows }
    }

    const response: { data: O[] } = JSON.parse(Buffer.concat(chunks).toString('utf8'))

    throwIfFailed(response)

    return { rows: response.data }
  }

  async beginTransaction() {
    throw new Error('Transactions are not supported.')
  }

  async commitTransaction() {
    throw new Error('Transactions are not supported.')
  }

  async rollbackTransaction() {
    throw new Error('Transactions are not supported.')
  }

  async *streamQuery<O>(compiledQuery: CompiledQuery, _chunkSize?: number): AsyncIterableIterator<QueryResult<O>> {
    const resultSet = await this.#client.query({
      query: this.prepareQuery(compiledQuery),
      session_id: this.#sessionId,
      format: 'JSONEachRow',
    })

    try {
      // The stream yields the rows in batches, as they arrive.
      for await (const rows of resultSet.stream()) {
        yield {
          rows: rows.map((row: { text: string; json(): unknown }) => {
            if (row.text.startsWith(STREAMED_EXCEPTION)) {
              throw new Error((row.json() as { exception: string }).exception)
            }

            return row.json() as O
          }),
        }
      }
    } finally {
      // Releases the socket when the consumer stops before the end of the result.
      resultSet.close()
    }
  }
}
