import { createClient } from '@clickhouse/client'
import type { ClickHouseClient } from '@clickhouse/client'

import type { ClickhouseDialectConfig } from './ClickhouseDialect'

export function createClickhouseClient(config: ClickhouseDialectConfig): ClickHouseClient {
  return createClient({
    // The client is shared by every query, so its default of 10 sockets would be a limit on the
    // whole application: ten result streams that are still being read would hold back every
    // other query.
    max_open_connections: Number.POSITIVE_INFINITY,
    ...config.options,
    clickhouse_settings: {
      // Lets ClickHouse read the ISO 8601 strings that `Date` objects are sent as on insert.
      date_time_input_format: 'best_effort',
      ...config.options?.clickhouse_settings,
    },
    // Each connection passes its own session with every request.
    session_id: undefined,
  })
}
