import {
  CompiledQuery,
  DatabaseConnection,
  QueryResult
} from 'kysely';

import { createClient } from '@clickhouse/client'
import { ClickhouseDialectConfig } from '.';
import { NodeClickHouseClient } from '@clickhouse/client/dist/client';
import { randomUUID } from 'node:crypto';

export class ClickhouseConnection implements DatabaseConnection {
  #client: NodeClickHouseClient

  constructor(config: ClickhouseDialectConfig) {
    this.#client = createClient({
      ...config.options,
      clickhouse_settings: {
        ...config.options?.clickhouse_settings,
        date_time_input_format: 'best_effort',
      },
      session_id: randomUUID(),
    })
  }

  prepareQuery<O>(compiledQuery: CompiledQuery): string {
    let i = 0
    const compiledSql = compiledQuery.sql.replace(/\?/g, () => {
      const param = compiledQuery.parameters[i++]

      if (typeof param === 'number') {
        return `${param}`
      }

      // should never happen
      if (typeof param !== 'string') {
        return `'${JSON.stringify(param)}'`
      }

      return `'${param.replace(/'/gm, `\\'`).replace(/\\"/g, '\\\\"')}'`
    })

    return compiledSql
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const queryKind = compiledQuery.query.kind

    if (queryKind === 'InsertQueryNode' || queryKind === 'UpdateQueryNode' || queryKind === 'SelectQueryNode') {
      const query = this.prepareQuery(compiledQuery)

      const resultSet = await this.#client.query({
        query,
        clickhouse_settings: {
          ...(queryKind === 'InsertQueryNode' && {
            date_time_input_format: "best_effort",
          }),
        },
      })

      if (queryKind === 'InsertQueryNode') {
        const summary = resultSet.response_headers["x-clickhouse-summary"]
        const summaryObject = JSON.parse(
          (Array.isArray(summary) ? summary[0] : summary) ?? '{}'
        )

        return {
          rows: [],
          numAffectedRows: BigInt(summaryObject.written_rows ?? 0),
          numChangedRows: BigInt(summaryObject.written_rows ?? 0),
        }
      }

      const response = await resultSet.json()

      return {
        rows: response.data as O[],
      }
    }

    await this.#client.command({
      query: this.prepareQuery(compiledQuery),
      clickhouse_settings: {
        wait_end_of_query: 1,
      },
    })

    return {
      rows: [],
    }

  }

  async beginTransaction() {
    throw new Error('Transactions are not supported.');
  }

  async commitTransaction() {
    throw new Error('Transactions are not supported.');
  }

  async rollbackTransaction() {
    throw new Error('Transactions are not supported.');
  }

  async *streamQuery<O>(compiledQuery: CompiledQuery, chunkSize: number): AsyncIterableIterator<QueryResult<O>> {
    const query = this.prepareQuery(compiledQuery)

    const resultSet = await this.#client.query({
      query,
      format: 'JSONEachRow',
    })

    const stream = resultSet.stream()

    for await (const row of stream) {
      yield {
        rows: [row as O],
      }
    }
  }
}