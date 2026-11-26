import type { ClickHouseClient } from '@clickhouse/client'
import type { DatabaseConnection, Driver } from 'kysely'

import { createClickhouseClient } from './ClickhouseClient'
import { ClickhouseConnection } from './ClickhouseConnection'
import type { ClickhouseDialectConfig } from './ClickhouseDialect'

export class ClickhouseDriver implements Driver {
  readonly #config: ClickhouseDialectConfig
  // One client, and with it one pool of sockets, for every connection of this driver.
  #client: ClickHouseClient | undefined

  constructor(config: ClickhouseDialectConfig) {
    this.#config = config
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    this.#client ??= createClickhouseClient(this.#config)

    // A connection is its own ClickHouse session, which is what scopes temporary tables.
    return new ClickhouseConnection(this.#config, this.#client)
  }

  async beginTransaction(conn: ClickhouseConnection): Promise<void> {
    return await conn.beginTransaction()
  }

  async commitTransaction(conn: ClickhouseConnection): Promise<void> {
    return await conn.commitTransaction()
  }

  async rollbackTransaction(conn: ClickhouseConnection): Promise<void> {
    return await conn.rollbackTransaction()
  }

  async releaseConnection(_conn: ClickhouseConnection): Promise<void> {}

  async destroy(): Promise<void> {
    const client = this.#client
    this.#client = undefined

    await client?.close()
  }
}
