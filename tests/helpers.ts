import type { ClickHouseSettings } from '@clickhouse/client'
import { Kysely } from 'kysely'

import { ClickhouseDialect } from '../src'

// The server from docker-compose.yaml. Set CLICKHOUSE_PORT (or CLICKHOUSE_URL) when port 8123 is
// already taken on your machine.
export const clickhouseOptions = {
  url: process.env.CLICKHOUSE_URL ?? `http://localhost:${process.env.CLICKHOUSE_PORT ?? 8123}`,
  username: 'clickhouse',
  password: 'clickhouse',
  database: 'test',
}

export function createKysely<DB = any>(
  database = clickhouseOptions.database,
  clickhouse_settings: ClickHouseSettings = {},
): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new ClickhouseDialect({
      options: {
        ...clickhouseOptions,
        database,
        clickhouse_settings: {
          // ClickHouse 25.8 stopped quoting 64-bit integers in JSON by default. Asking for the
          // quotes keeps the results the same on every server version, and exact above 2^53.
          output_format_json_quote_64bit_integers: 1,
          ...clickhouse_settings,
        },
      },
    }),
  })
}
