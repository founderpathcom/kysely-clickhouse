import {
  CompiledQuery,
  DatabaseConnection,
  QueryResult
} from 'kysely';

import { createClient } from '@clickhouse/client'
import { ClickhouseDialectConfig } from '.';
import { NodeClickHouseClient } from '@clickhouse/client/dist/client';


export class ClickhouseConnection implements DatabaseConnection {
  #client: NodeClickHouseClient

  constructor(config: ClickhouseDialectConfig) {
    this.#client = createClient({
      ...config.options,
      clickhouse_settings: {
        ...config.options?.clickhouse_settings,
        date_time_input_format: 'best_effort',
      }
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

    if (compiledQuery.query.kind === 'InsertQueryNode') {

      const values = [
        compiledQuery.query.columns?.map(c => c.column.name) ?? [],
        // @ts-expect-error: fix types
        ...compiledQuery.query.values?.values.map(v => v.values) ?? [],
      ]

      const resultSet = await this.#client.insert({
        table: compiledQuery.query.into.table.identifier.name,
        format: 'JSONCompactEachRowWithNames',
        values,
        clickhouse_settings: {
          date_time_input_format: 'best_effort',
        },
      })

      return {
        rows: [],
        numAffectedRows: BigInt(resultSet.summary?.written_rows ?? 0),
        numChangedRows: BigInt(resultSet.summary?.written_rows ?? 0),
      }
    }

    if (compiledQuery.query.kind === 'UpdateQueryNode' || compiledQuery.query.kind === 'SelectQueryNode') {
      const query = this.prepareQuery(compiledQuery)

      const resultSet = await this.#client.query({
        query,
      })
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