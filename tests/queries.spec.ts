import { afterAll, beforeAll, expect, test } from 'vitest'
import { sql } from 'kysely'

import { createKysely } from './helpers'

// These tests get a database of their own, so that they can create tables without changing what
// the introspection test sees in the `test` database.
const DATABASE = 'kysely_clickhouse_queries'

interface Event {
  id: number
  name: string
  note: string | null
  day: Date | string
  at: Date | string
  at64: Date | string
  flag: boolean
  big: bigint | string
  tags: string[]
  score: number
}

const admin = createKysely()
// Updates are mutations, which ClickHouse applies in the background unless told to wait.
const db = createKysely<{ events: Event; 'odd-name': { id: number } }>(DATABASE, { mutations_sync: '2' })

beforeAll(async () => {
  await sql`DROP DATABASE IF EXISTS ${sql.id(DATABASE)}`.execute(admin)
  await sql`CREATE DATABASE ${sql.id(DATABASE)}`.execute(admin)
  await sql`
    CREATE TABLE events (
      id Int32,
      name String,
      note Nullable(String),
      day Date,
      at DateTime('America/New_York'),
      at64 DateTime64(3, 'UTC'),
      flag Bool,
      big Int64,
      tags Array(String),
      score Float64 DEFAULT 1.5
    ) ENGINE = MergeTree ORDER BY id
  `.execute(db)
  await sql`CREATE TABLE \`odd-name\` (id Int32) ENGINE = Memory`.execute(db)
})

afterAll(async () => {
  await sql`DROP DATABASE IF EXISTS ${sql.id(DATABASE)}`.execute(admin)
  await db.destroy()
  await admin.destroy()
})

const instant = new Date('2024-04-01T23:30:00.789Z')

test('inserts and reads back every kind of value', async () => {
  const result = await db
    .insertInto('events')
    .values({
      id: 1,
      name: String.raw`O\'Brien ? "quoted" \\`,
      note: null,
      day: '2024-04-01',
      at: instant,
      at64: instant,
      flag: true,
      big: 9007199254740993n,
      tags: ["it's", 'b?'],
      score: -2.5,
    })
    .executeTakeFirstOrThrow()

  expect(result.numInsertedOrUpdatedRows).toBe(1n)

  const row = await db
    .selectFrom('events')
    .select(['name', 'note', 'day', 'flag', 'big', 'tags', 'score'])
    .select(sql<string>`toUnixTimestamp(at)`.as('at'))
    .select(sql<string>`toUnixTimestamp64Milli(at64)`.as('at64'))
    .where('id', '=', 1)
    .executeTakeFirstOrThrow()

  expect(row).toEqual({
    name: String.raw`O\'Brien ? "quoted" \\`,
    note: null,
    day: '2024-04-01',
    flag: true,
    big: '9007199254740993',
    tags: ["it's", 'b?'],
    score: -2.5,
    at: Math.floor(instant.getTime() / 1000),
    at64: String(instant.getTime()),
  })
})

// https://github.com/founderpathcom/kysely-clickhouse/issues/4
test('compares Date parameters with every date type', async () => {
  const find = (where: Parameters<ReturnType<typeof db.selectFrom<'events'>>['where']>[0]) =>
    db.selectFrom('events').select('id').where('id', '=', 1).where(where).execute()

  // A Date column holds a day, a JS Date at midnight UTC is that day.
  expect(await find((eb) => eb('day', '=', new Date('2024-04-01')))).toEqual([{ id: 1 }])
  expect(await find((eb) => eb('day', '<', new Date('2024-04-01')))).toEqual([])

  // The time zone of the column does not change which instant is meant.
  expect(await find((eb) => eb('at', '=', new Date('2024-04-01T23:30:00Z')))).toEqual([{ id: 1 }])
  expect(await find((eb) => eb('at64', '=', instant))).toEqual([{ id: 1 }])
  expect(await find((eb) => eb('at64', '>', instant))).toEqual([])
  expect(
    await find((eb) => eb.between('at64', new Date(instant.getTime() - 1), new Date(instant.getTime() + 1))),
  ).toEqual([{ id: 1 }])
})

test('passes null, booleans, bigints and arrays as parameters', async () => {
  const count = async (where: Parameters<ReturnType<typeof db.selectFrom<'events'>>['where']>[0]) => {
    const rows = await db.selectFrom('events').select('id').where('id', '=', 1).where(where).execute()

    return rows.length
  }

  expect(await count((eb) => eb('flag', '=', true))).toBe(1)
  expect(await count((eb) => eb('flag', '=', false))).toBe(0)
  expect(await count((eb) => eb('big', '=', 9007199254740993n))).toBe(1)
  expect(await count((eb) => eb('big', '=', 9007199254740992n))).toBe(0)
  expect(await count((eb) => eb('score', '<', -1))).toBe(1)
  expect(await count((eb) => eb('name', 'in', ['nope', String.raw`O\'Brien ? "quoted" \\`]))).toBe(1)
  expect(await count(sql<boolean>`hasAll(tags, ${["it's"]})`)).toBe(1)
  expect(await count(sql<boolean>`ifNull(note, ${null}) IS NULL`)).toBe(1)
  // Subtracting a negative parameter must not turn into a `--` comment.
  expect(await count(sql<boolean>`id -${-1} = 2`)).toBe(1)
})

// https://github.com/founderpathcom/kysely-clickhouse/issues/5
test('limit and offset', async () => {
  const query = db.selectFrom('events').select('id').orderBy('id', 'desc')

  expect(await query.limit(200).execute()).toEqual([{ id: 1 }])
  expect(await query.limit(200).offset(1).execute()).toEqual([])
  expect(await query.limit(200n as unknown as number).execute()).toEqual([{ id: 1 }])
})

// https://github.com/founderpathcom/kysely-clickhouse/issues/7
test('raw queries return their rows', async () => {
  const selected = await sql<{ one: number; text: string }>`SELECT 1 AS one, ${"it's"} AS text`.execute(db)
  expect(selected.rows).toEqual([{ one: 1, text: "it's" }])

  const withCte = await sql`WITH 2 AS two SELECT two, name FROM events WHERE id = ${1}`.execute(db)
  expect(withCte.rows).toEqual([{ two: 2, name: String.raw`O\'Brien ? "quoted" \\` }])

  const shown = await sql<{ name: string }>`SHOW TABLES`.execute(db)
  expect(shown.rows.map((row) => row.name).sort()).toEqual(['events', 'odd-name'])

  const empty = await sql`SELECT 1 AS one WHERE 0`.execute(db)
  expect(empty.rows).toEqual([])
})

test('raw statements without a result return no rows', async () => {
  const created = await sql`CREATE TABLE raw_statement (id Int32) ENGINE = Memory`.execute(db)
  expect(created.rows).toEqual([])

  const inserted = await sql`INSERT INTO raw_statement SELECT number FROM numbers(${3})`.execute(db)
  expect(inserted.rows).toEqual([])
  expect(inserted.numAffectedRows).toBe(3n)

  // A query that chooses its own format is not parsed.
  const formatted = await sql`SELECT id FROM raw_statement FORMAT CSV`.execute(db)
  expect(formatted.rows).toEqual([])

  await sql`DROP TABLE raw_statement`.execute(db)
})

test('a failing raw query throws', async () => {
  await expect(sql`SELECT * FROM does_not_exist`.execute(db)).rejects.toThrow('does_not_exist')
})

test('inserts rows that leave out columns', async () => {
  await db
    .insertInto('events')
    .values([
      { id: 10, name: 'ten', at: instant, at64: instant, score: 7 },
      { id: 11, name: 'eleven', day: '2024-05-05', tags: ['x'] },
    ] as any)
    .execute()

  const rows = await db
    .selectFrom('events')
    .select(['id', 'name', 'day', 'tags', 'score'])
    .where('id', 'in', [10, 11])
    .orderBy('id')
    .execute()

  expect(rows).toEqual([
    { id: 10, name: 'ten', day: '1970-01-01', tags: [], score: 7 },
    { id: 11, name: 'eleven', day: '2024-05-05', tags: ['x'], score: 1.5 },
  ])
})

test('inserts rows that contain expressions', async () => {
  await db
    .insertInto('events')
    .values({ id: 20, name: sql<string>`upper(${"o'neil"})`, big: -5n, tags: ['a', 'b'], score: -1 } as any)
    .execute()

  const row = await db
    .selectFrom('events')
    .select(['name', 'big', 'tags', 'score'])
    .where('id', '=', 20)
    .executeTakeFirstOrThrow()

  expect(row).toEqual({ name: "O'NEIL", big: '-5', tags: ['a', 'b'], score: -1 })
})

test('inserts from a select with parameters of any type', async () => {
  const result = await db
    .insertInto('events')
    .columns(['id', 'name', 'score', 'at64'])
    .expression(
      db
        .selectFrom('events')
        .select([sql<number>`id + ${29}`.as('id'), sql.val('copy').as('name'), sql.val(-0.5).as('score'), sql.val(instant).as('at64')])
        // Not `id`: in ClickHouse that would be the `id` alias of the select.
        .where('flag', '=', true),
    )
    .executeTakeFirstOrThrow()

  expect(result.numInsertedOrUpdatedRows).toBe(1n)

  const row = await db
    .selectFrom('events')
    .select(['name', 'score'])
    .select(sql<string>`toUnixTimestamp64Milli(at64)`.as('at64'))
    .where('id', '=', 30)
    .executeTakeFirstOrThrow()

  expect(row).toEqual({ name: 'copy', score: -0.5, at64: String(instant.getTime()) })
})

test('quotes the table name of an insert', async () => {
  await db.insertInto('odd-name').values([{ id: 1 }, { id: 2 }]).execute()
  await db.withSchema(DATABASE).insertInto('odd-name').values({ id: 3 }).execute()

  expect(await db.selectFrom('odd-name').select('id').orderBy('id').execute()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
})

test('updates and deletes', async () => {
  await db
    .updateTable('events')
    .set({ note: String.raw`back\slash'`, flag: false, at64: new Date('2025-01-02T03:04:05.678Z') })
    .where('id', '=', 10)
    .execute()

  const updated = await db
    .selectFrom('events')
    .select(['note', 'flag'])
    .select(sql<string>`toUnixTimestamp64Milli(at64)`.as('at64'))
    .where('id', '=', 10)
    .executeTakeFirstOrThrow()

  expect(updated).toEqual({ note: String.raw`back\slash'`, flag: false, at64: String(Date.parse('2025-01-02T03:04:05.678Z')) })

  await db.updateTable('events').set({ note: null }).where('id', '=', 10).execute()
  await db.deleteFrom('events').where('id', '=', 11).execute()

  const rows = await db.selectFrom('events').select(['id', 'note']).where('id', 'in', [10, 11]).execute()

  expect(rows).toEqual([{ id: 10, note: null }])
})

// Updates used to leave their response unread, which kept the socket busy. With the client's
// default of 10 sockets, the 11th query then waited forever.
test('many updates in a row do not exhaust the sockets', async () => {
  for (let i = 0; i < 25; i++) {
    await db.updateTable('events').set({ score: i }).where('id', '=', 10).execute()
  }

  const row = await db.selectFrom('events').select('score').where('id', '=', 10).executeTakeFirstOrThrow()

  expect(row.score).toBe(24)
})

test('streams rows as objects', async () => {
  const ids: number[] = []

  for await (const row of db.selectFrom('events').select('id').where('id', '<', 25).orderBy('id').stream()) {
    ids.push(row.id)
  }

  expect(ids).toEqual([1, 10, 20])

  // Stopping early releases the connection.
  for (let i = 0; i < 15; i++) {
    for await (const row of db.selectFrom('events').select('id').orderBy('id').stream()) {
      expect(row).toEqual({ id: 1 })
      break
    }
  }
})

test('identifiers with backticks and backslashes round-trip', async () => {
  const alias = 'we`ird\\ ?'
  const row = await db
    .selectFrom('events')
    .select(sql.ref('id').as(alias))
    .where('id', '=', 1)
    .executeTakeFirstOrThrow()

  expect(row).toEqual({ [alias]: 1 })
})

test('dollar signs round-trip in values and identifiers', async () => {
  const value = "$$ $a$ ' $"
  const row = await db.selectNoFrom([sql.val(value).as('pri$e'), sql.lit(value).as('$$')]).executeTakeFirstOrThrow()

  expect(row).toEqual({ pri$e: value, $$: value })
})

// ClickHouse 24 reads `$a as v from (select 1 as $` as the opening tag of a heredoc, and accepts
// the closing tag from inside a string literal. Without the escaping of `$`, this value closed
// the heredoc and its `union all` ran as SQL.
test('a value cannot close a heredoc', async () => {
  const value =
    '$a as v from (select 1 as $ as v union all select name from system.databases where name like char(115,121,115,37) -- '
  const result = await sql`select $a as v from (select 1 as $a) where 'x' = ${value}`.execute(db)

  expect(result.rows).toEqual([])
})

test('a JSON path key cannot leave its literal', async () => {
  const doc = JSON.stringify({ a: 'ok', 'x y': { 'b"c': 'deep' } })
  const value = (...keys: string[]) =>
    db
      .selectFrom(sql<{ doc: string }>`(SELECT ${doc} AS doc)`.as('t'))
      .select((eb) => {
        const path = keys.reduce((builder: any, key) => builder.key(key), eb.jsonPath())

        return eb.fn<string>('JSON_VALUE', [eb.ref('doc'), path]).as('v')
      })
      .executeTakeFirstOrThrow()

  expect(await value('a')).toEqual({ v: 'ok' })
  expect(await value('x y', 'b"c')).toEqual({ v: 'deep' })
  expect(await value("a') as v, (select 'leaked') as leaked from (select '{}' as doc) -- ")).toEqual({ v: '' })
})

test('inserting into a column that does not exist fails', async () => {
  await expect(
    db.insertInto('events').values({ id: 40, nosuchcolumn: 'lost' } as any).execute(),
  ).rejects.toThrow('nosuchcolumn')
  await expect(
    db.insertInto('events').values([{ id: 41, nosuchcolumn: 'lost' }, { id: 42, name: 'x' }] as any).execute(),
  ).rejects.toThrow('nosuchcolumn')

  expect(await db.selectFrom('events').select('id').where('id', 'in', [40, 41, 42]).execute()).toEqual([])
})

test('inserts NaN and the infinities as they are', async () => {
  await db
    .insertInto('events')
    .values([
      { id: 50, name: 'nan', score: Number.NaN },
      { id: 51, name: 'inf', score: Number.POSITIVE_INFINITY },
      { id: 52, name: '-inf', score: Number.NEGATIVE_INFINITY },
    ] as any)
    .execute()

  const rows = await db
    .selectFrom('events')
    .select(['name', sql<string>`toString(score)`.as('score')])
    .where('id', 'in', [50, 51, 52])
    .orderBy('id')
    .execute()

  expect(rows).toEqual([
    { name: 'nan', score: 'nan' },
    { name: 'inf', score: 'inf' },
    { name: '-inf', score: '-inf' },
  ])
})

test('refuses to insert an array that contains undefined', async () => {
  await expect(
    db.insertInto('events').values({ id: 60, name: 'x', tags: ['a', undefined, 'c'] } as any).execute(),
  ).rejects.toThrow('contains undefined')
})

// ClickHouse 24 answers a query that fails halfway with HTTP 200 and the rows it had already
// written. Returning those as the result would be a truncated result that looks complete.
test('a query that fails after its first rows throws', async () => {
  const failing = db
    .selectFrom(sql<{ number: string }>`numbers(5000000)`.as('n'))
    .select(['number', sql<number>`throwIf(number = 3000000)`.as('t')])

  const countStreamedRows = async () => {
    let count = 0
    for await (const _row of failing.stream()) {
      count += 1
    }
    return count
  }

  await expect(failing.execute()).rejects.toThrow()
  await expect(countStreamedRows()).rejects.toThrow()
  await expect(sql`SELECT number, throwIf(number = 3000000) FROM numbers(5000000)`.execute(db)).rejects.toThrow()
})

// Every query goes through one client. With the client's own default of 10 sockets, ten result
// streams that are still being read held back every other query until one of them timed out.
test('open streams do not hold back other queries', async () => {
  const streams = Array.from({ length: 12 }, () =>
    db.selectFrom(sql<{ number: string }>`numbers(50000000)`.as('n')).select('number').stream()[Symbol.asyncIterator](),
  )

  try {
    await Promise.all(streams.map((stream) => stream.next()))

    const started = Date.now()
    expect(await db.selectFrom('events').select('id').where('id', '=', 1).execute()).toEqual([{ id: 1 }])
    expect(Date.now() - started).toBeLessThan(5000)
  } finally {
    await Promise.all(streams.map((stream) => stream.return?.()))
  }
})

test('lists the schemas', async () => {
  const schemas = await db.introspection.getSchemas()

  expect(schemas.map((schema) => schema.name)).toContain(DATABASE)
})

test('nullable columns are introspected as nullable', async () => {
  const tables = await db.introspection.getTables()
  const events = tables.find((table) => table.name === 'events')

  expect(events?.columns.find((column) => column.name === 'note')).toMatchObject({ dataType: 'String', isNullable: true })
  expect(events?.columns.find((column) => column.name === 'name')).toMatchObject({ dataType: 'String', isNullable: false })
})

test('destroying the instance closes the client', async () => {
  const other = createKysely(DATABASE)

  expect((await sql`SELECT 1 AS one`.execute(other)).rows).toEqual([{ one: 1 }])
  await other.destroy()
  await expect(sql`SELECT 1 AS one`.execute(other)).rejects.toThrow()
})
