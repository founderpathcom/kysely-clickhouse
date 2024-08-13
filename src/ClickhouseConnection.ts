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
    this.#client = createClient(config.options)
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
    const query = this.prepareQuery(compiledQuery)

    const resultSet = await this.#client.query({
      query,
      format: 'JSONEachRow',
    })
    const rows: O[] = await resultSet.json()

    return {
      rows
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