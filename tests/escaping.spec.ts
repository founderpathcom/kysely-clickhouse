import { expect, test } from 'vitest'
import { Kysely, sql } from 'kysely'

import { ClickhouseConnection, ClickhouseDialect } from '../src'

// prepareQuery only builds SQL text, so these tests need no ClickHouse server.
const kysely = new Kysely<any>({
  dialect: new ClickhouseDialect({ options: { url: 'http://localhost:8123' } }),
})
const connection = new ClickhouseConnection({ options: { url: 'http://localhost:8123' } })

test.each([
  { value: "O'Brien", literal: String.raw`'O\'Brien'` },
  // A backslash before a quote closed the literal when only quotes were escaped.
  { value: String.raw`O\'Brien`, literal: String.raw`'O\\\'Brien'` },
  { value: String.raw`C:\temp\\`, literal: String.raw`'C:\\temp\\\\'` },
  { value: String.raw`{"a":"x\"y"}`, literal: String.raw`'{"a":"x\\"y"}'` },
  // A `?` inside a value is not read as another placeholder.
  { value: 'why? 100%', literal: `'why? 100%'` },
])('inlines $value as $literal', ({ value, literal }) => {
  const query = kysely.selectFrom('customers').select('id').where('name', '=', value)

  expect(connection.prepareQuery(query.compile())).toBe(
    `select \`id\` from \`customers\` where \`name\` = ${literal}`,
  )
})

test('escapes the parameters of a raw query', () => {
  const query = sql`ALTER TABLE customers DELETE WHERE id = ${String.raw`x\' OR 1 = 1 --`}`

  expect(connection.prepareQuery(query.compile(kysely))).toBe(
    String.raw`ALTER TABLE customers DELETE WHERE id = 'x\\\' OR 1 = 1 --'`,
  )
})

test('keeps numbers bare and other values as quoted JSON', () => {
  const query = sql`SELECT ${42}, ${null}, ${true}`

  expect(connection.prepareQuery(query.compile(kysely))).toBe(`SELECT 42, 'null', 'true'`)
})
