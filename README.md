# @founderpath/kysely-clickhouse

[Kysely](https://github.com/koskimas/kysely) adapter for [Clickhouse](https://clickhouse.com).

```bash
npm i @clickhouse/client @founderpath/kysely-clickhouse
```

This project was largely adapted from [kysely-planetscale](https://github.com/depot/kysely-planetscale). It's a barebone version, there's a lot of improvements that can be done here. 

## Usage

Pass your Clickhouse connection options into the dialect in order to configure the Kysely client. Follow [these docs](https://www.npmjs.com/package/@clickhouse/client) for instructions on how to do so.

```typescript
import { Kysely } from 'kysely';
import { ClickhouseDialect } from '@founderpath/kysely-clickhouse';

interface SomeTable {
  key: string;
  value: string;
}

interface Database {
  some_datasets.some_table: SomeTable
}

const db = new Kysely<Database>({ dialect: new ClickhouseDialect() });
```

## How values are sent

ClickHouse has no prepared statements over HTTP, so the dialect writes every parameter into the SQL as an escaped literal:

| JavaScript | ClickHouse |
| --- | --- |
| `string` | `'text'`, with quotes and backslashes escaped |
| `number`, `bigint` | number literal |
| `boolean` | `true` / `false` |
| `null` | `NULL` |
| `Date` | `toDateTime64('2024-04-01 12:34:56.789', 3, 'UTC')` |
| array | `[...]` |
| other objects | their JSON, as a string |

`undefined` is rejected with an error instead of being sent. A parameter cannot be placed inside a comment or a quoted token of a `sql` template.

A `?` written directly in raw SQL is read as a placeholder, so ClickHouse's `a ? b : c` operator cannot be used in `sql` templates. Use `if(a, b, c)`.

### Dates

A `Date` used as a parameter (`where`, `set`, `sql` templates) is the same instant whatever the time zone of the server or the column, and can be compared with `Date`, `DateTime` and `DateTime64` columns.

Rows passed to `insertInto().values()` are sent as JSON, where a `Date` becomes an ISO 8601 string. `DateTime` and `DateTime64` columns accept it because the dialect sets `date_time_input_format` to `best_effort`. `Date` and `Date32` columns do not: ClickHouse only reads `YYYY-MM-DD` there, so pass a string for those.

### Settings

`options.clickhouse_settings` is applied to every query, and takes precedence over the `date_time_input_format` default above:

```typescript
new ClickhouseDialect({
  options: {
    url: 'http://localhost:8123',
    clickhouse_settings: {
      // ClickHouse 25.8 and later return 64-bit integers as JSON numbers, which lose precision
      // above 2^53 in JavaScript. This returns them as strings, as older versions do.
      output_format_json_quote_64bit_integers: 1,
    },
  },
})
```

All queries of a `Kysely` instance share one ClickHouse client, which is closed by `db.destroy()`. The number of sockets it opens is not limited unless you set `options.max_open_connections`.

## Development

The tests need a ClickHouse server:

```bash
pnpm test:up
pnpm test
```

Set `CLICKHOUSE_PORT` for both commands if port 8123 is already in use.
