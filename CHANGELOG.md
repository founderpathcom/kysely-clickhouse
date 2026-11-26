# Changelog

## 2.0.0 - 2026-11-26

This release fixes several SQL injection bugs. Every earlier version is affected, so upgrading is recommended even if none of the breaking changes below apply to you.

### Breaking changes

- **`undefined` parameters throw.** They used to be sent as the text `'undefined'`. Use `null` for a `NULL` value.
- **`null` and booleans are sent as `NULL`, `true` and `false`.** They used to be sent as the strings `'null'`, `'true'` and `'false'`.
- **Array parameters are sent as ClickHouse arrays** (`[1, 2]`) instead of a JSON string. An array written to a `String` column through `update` is now stored as `['x','y']`, not `["x","y"]`.
- **`Date` parameters are sent as `toDateTime64('…', 3, 'UTC')`** instead of a JSON string that ClickHouse could not parse.
- **A `?` in raw SQL that is not a placeholder throws.** ClickHouse's `a ? b : c` operator cannot be told apart from a placeholder; use `if(a, b, c)`.
- **A parameter inside a comment, a heredoc or a quoted token of a `sql` template throws.** A value written there is not read as a literal.
- **Inserting into a column that the table does not have fails.** ClickHouse used to drop the values of that column without an error.
- **Inserting an array that contains `undefined` throws.** The element used to be stored as the default value of its type.
- **`options.clickhouse_settings` takes precedence over the dialect's defaults.** `date_time_input_format` used to be forced to `best_effort`.
- **All queries share one ClickHouse client**, which `db.destroy()` closes. Each query used to create a client of its own, and none of them were closed. The shared client does not limit the number of sockets unless `options.max_open_connections` is set.
- **`ClickhouseConnection`** takes the shared client as an optional second constructor argument, and `prepareQuery` lost its unused type parameter.

### Security

- A `?` inside a string literal, a quoted identifier or a comment was replaced by the next parameter. Inside a string literal this put the parameter's value outside of the quotes, where it ran as SQL.
- A negative number after a minus sign (`a - ?`) produced `--`, which commented out the rest of the query, for example a tenant filter.
- Backslashes in identifiers and in `sql.lit()` values were not escaped. A name or value ending in a backslash escaped its closing quote.
- Backslashes in string parameters were not escaped, so a value such as `\'` closed its literal ([#8](https://github.com/founderpathcom/kysely-clickhouse/pull/8), not released until now).
- The keys of a JSON path were written into the SQL as they are on Kysely versions before 0.28.17. They are now escaped by the dialect on every Kysely version.
- A parameter inside a `//` comment, a nested block comment, a heredoc or typographic quotes was substituted, although ClickHouse does not read a value there as a literal.
- On ClickHouse 24, a `$` in a value could close a heredoc that the surrounding SQL had opened. Dollar signs in values and identifiers are now written as `\x24`.
- The table name of an insert was not quoted.

### Fixed

- Raw queries (``sql`select …`.execute(db)``) return their rows instead of an empty result ([#7](https://github.com/founderpathcom/kysely-clickhouse/issues/7)).
- `Date` objects can be used as parameters and compared with `Date`, `DateTime` and `DateTime64` columns, whatever the time zone of the server ([#4](https://github.com/founderpathcom/kysely-clickhouse/issues/4)).
- A `limit` or any other parameter that is `undefined` fails with a clear error instead of `LIMIT 'undefined'` ([#5](https://github.com/founderpathcom/kysely-clickhouse/issues/5)).
- `bigint` parameters and `bigint` values in inserts no longer throw.
- `NaN` and the infinities are inserted as they are instead of as the column's default value.
- A select that fails after ClickHouse has started to send rows throws. On ClickHouse 24 it used to return the rows received so far as a complete result.
- Inserting rows with different sets of columns, or rows that contain expressions such as ``sql`now()` ``, works. Kysely's internal query nodes used to be sent as the data.
- `insert … select` accepts parameters of any type. Numbers used to be bound as `UInt32`, which rejected negative and fractional values.
- Updates no longer leave their response unread, which kept a socket busy for each update.
- `.stream()` yields rows. It used to yield the client's internal row objects.
- `introspection.getSchemas()` returns the schema names instead of `undefined`.
- `introspection.getTables()` returns the tables on Kysely 0.29, where it returned nothing.
- Updates of tables whose names need quoting (`my-table`) are turned into `ALTER TABLE … UPDATE`.

### Added

- `ClickhouseQueryCompiler` and `ClickhouseAdapter` are exported.
- `numAffectedRows` is reported for `insert … select` and for raw statements.
- The port of the test server can be set with `CLICKHOUSE_PORT`.

### Changed

- The types of `@clickhouse/client` are imported from its main entry point instead of its `dist` directory.
- The test server no longer publishes the native protocol port (9000).

## 1.7.0 - 2025-04-15

- Support temporary tables: each connection is its own ClickHouse session.
- Turn `update` queries into `ALTER TABLE … UPDATE`.

## 1.6.2 - 2025-04-15

- Support `insert … select` and inserts whose values are a values node.

Earlier versions are described by the commit history.
