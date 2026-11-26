import { expect, test } from 'vitest'
import { Kysely, sql } from 'kysely'

import { ClickhouseConnection, ClickhouseDialect } from '../src'

// prepareQuery only builds SQL text, so these tests need no ClickHouse server.
const kysely = new Kysely<any>({
  dialect: new ClickhouseDialect({ options: { url: 'http://localhost:8123' } }),
})
const connection = new ClickhouseConnection({ options: { url: 'http://localhost:8123' } })

function prepare(query: { compile(db?: any): any }): string {
  return connection.prepareQuery(query.compile(kysely))
}

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

  expect(prepare(query)).toBe(`select \`id\` from \`customers\` where \`name\` = ${literal}`)
})

test('escapes the parameters of a raw query', () => {
  const query = sql`ALTER TABLE customers DELETE WHERE id = ${String.raw`x\' OR 1 = 1 --`}`

  expect(prepare(query)).toBe(String.raw`ALTER TABLE customers DELETE WHERE id = 'x\\\' OR 1 = 1 --'`)
})

test.each([
  { value: 42, literal: '42' },
  { value: 1.5, literal: '1.5' },
  { value: 1e21, literal: '1e+21' },
  { value: Number.NaN, literal: 'nan' },
  { value: Number.POSITIVE_INFINITY, literal: 'inf' },
  { value: Number.NEGATIVE_INFINITY, literal: '(-inf)' },
  { value: 9007199254740993n, literal: '9007199254740993' },
  { value: -9007199254740993n, literal: '(-9007199254740993)' },
  { value: true, literal: 'true' },
  { value: false, literal: 'false' },
  { value: null, literal: 'NULL' },
  { value: new Date('2024-04-01T12:34:56.789Z'), literal: `toDateTime64('2024-04-01 12:34:56.789', 3, 'UTC')` },
  { value: [1, -2, 3], literal: '[1, (-2), 3]' },
  { value: ["it's", String.raw`a\b`], literal: String.raw`['it\'s', 'a\\b']` },
  { value: { a: "x'y", b: 1n }, literal: String.raw`'{"a":"x\'y","b":"1"}'` },
])('formats $value as $literal', ({ value, literal }) => {
  expect(prepare(sql`SELECT ${value}`)).toBe(`SELECT ${literal}`)
})

test('rejects values that have no literal form', () => {
  expect(() => prepare(sql`SELECT ${new Date('nope')}`)).toThrow('invalid Date')
  expect(() => prepare(sql`SELECT ${Symbol('nope')}`)).toThrow('type symbol')
})

// https://github.com/founderpathcom/kysely-clickhouse/issues/5
test('rejects an undefined parameter instead of sending it as text', () => {
  const query = kysely.selectFrom('my_table').select('created_on').limit(undefined as unknown as number)

  expect(() => prepare(query)).toThrow('Cannot use undefined as a query parameter. Use null for a NULL value.')
})

// `a - ?` with a bare -5 would read `a --5`, and `--` starts a comment: the rest of the line,
// here the tenant filter, would be dropped from the query.
test('a negative number cannot start a comment', () => {
  const query = kysely
    .selectFrom('accounts')
    .select('id')
    .where(sql<boolean>`balance -${-5} > 0`)
    .where('tenant_id', '=', 'acme')

  expect(prepare(query)).toBe("select `id` from `accounts` where balance -(-5) > 0 and `tenant_id` = 'acme'")
})

test('only replaces placeholders, not every question mark', () => {
  const query = sql`
    SELECT 'what?', \`is?\`, "really?", 'it''s ?', 'esc\\' ?', ${'first'} -- why?
    # isn't it?
    /* how? */ FROM t WHERE a = ${'second'}
  `

  expect(prepare(query)).toBe(`
    SELECT 'what?', \`is?\`, "really?", 'it''s ?', 'esc\\' ?', 'first' -- why?
    # isn't it?
    /* how? */ FROM t WHERE a = 'second'
  `)
})

// Replacing the `?` inside the literal used to put the next parameter between two closed quotes,
// where it was read as SQL: `'is it'' OR 1 = 1 OR ''' AND name = 'undefined'`.
test('a question mark in a string literal does not unquote the next parameter', () => {
  const query = kysely
    .selectFrom('customers')
    .select('id')
    .where('question', '=', sql.lit('is it?'))
    .where('name', '=', ' OR 1 = 1 OR ')

  expect(prepare(query)).toBe(
    "select `id` from `customers` where `question` = 'is it?' and `name` = ' OR 1 = 1 OR '",
  )
})

test('fails when placeholders and parameters do not line up', () => {
  // ClickHouse's ternary operator cannot be told apart from a placeholder.
  expect(() => prepare(sql`SELECT ${1} > 0 ? 'yes' : 'no'`)).toThrow(
    'The query has 2 "?" placeholder(s) but 1 parameter(s).',
  )
  expect(() =>
    connection.prepareQuery({ ...sql`SELECT ${1}`.compile(kysely), parameters: [1, 2] }),
  ).toThrow('The query has 1 "?" placeholder(s) but 2 parameter(s).')
})

test('escapes backslashes in identifiers and literals', () => {
  const query = kysely
    .selectFrom('t')
    .select([sql.ref('we`ird\\').as('a\\'), sql.lit("it's\\").as('b')])

  expect(prepare(query)).toBe(
    String.raw`select ` + '`we``ird\\\\` as `a\\\\`, ' + String.raw`'it\'s\\' as ` + '`b` from `t`',
  )
})

test('turns an update into a mutation', () => {
  const query = kysely.updateTable('my-db.my-table').set({ note: null, seen: true }).where('id', '=', 1)

  expect(prepare(query)).toBe(
    'alter table `my-db`.`my-table` update `note` = NULL, `seen` = true where `id` = 1',
  )
})

// ClickHouse 24 looks for the closing tag of a heredoc without regard for quotes, so a `$` in a
// value could otherwise close a heredoc that the SQL around it opened.
test('writes dollar signs as an escape sequence', () => {
  const query = kysely.selectFrom('t').select(sql.ref('id').as('pri$e')).where('name', '=', '$$ or 1 = 1 $$')

  expect(prepare(query)).toBe(
    'select `id` as `pri\\x24e` from `t` where `name` = ' + String.raw`'\x24\x24 or 1 = 1 \x24\x24'`,
  )
})

// A value written inside one of these tokens is not read as a literal: a line break in it ends
// the comment, a `$$` ends the heredoc, and what follows is read as SQL.
test.each([
  { name: 'a -- comment', query: sql`SELECT 1 -- trace ${'x'}` },
  { name: 'a // comment', query: sql`SELECT 1 // trace ${'x'}` },
  { name: 'a # comment', query: sql`SELECT 1 # trace ${'x'}` },
  { name: 'a block comment', query: sql`SELECT 1 /* trace ${'x'} */` },
  { name: 'a nested block comment', query: sql`SELECT 1 /* a /* b */ ${'x'} */` },
  { name: 'a heredoc', query: sql`SELECT $$${'x'}$$` },
  { name: 'a tagged heredoc', query: sql`SELECT $tag$ ${'x'} $tag$` },
  { name: 'a string literal', query: sql`SELECT '${'x'}'` },
  { name: 'a typographic string literal', query: sql`SELECT ‘${'x'}’` },
  { name: 'a typographic identifier', query: sql`SELECT 1 AS “${'x'}”` },
])('refuses a parameter inside $name', ({ query }) => {
  expect(() => prepare(query)).toThrow('The query has 0 "?" placeholder(s) but 1 parameter(s).')
})

test('leaves question marks in comments, heredocs and typographic quotes alone', () => {
  const query = sql`
    SELECT ${1}, $$a?$$, $t$b?$t$, ‘c?’, 1 AS “d?”, pri$e // e?
    /* f? /* g? */ h? */ FROM t WHERE x = ${2}
  `

  expect(prepare(query)).toBe(`
    SELECT 1, $$a?$$, $t$b?$t$, ‘c?’, 1 AS “d?”, pri$e // e?
    /* f? /* g? */ h? */ FROM t WHERE x = 2
  `)
})

// Kysely before 0.28.17 wrote the keys of a JSON path into the SQL as they are.
test('escapes the keys of a JSON path', () => {
  const path = (key: string) =>
    prepare(
      kysely
        .selectFrom('t')
        .select((eb) => eb.fn('JSON_VALUE', [eb.ref('doc'), eb.jsonPath().key(key).at(0)]).as('v')),
    )

  expect(path('plain_key1')).toBe("select JSON_VALUE(`doc`, '$.plain_key1[0]') as `v` from `t`")
  expect(path(`a') as v, (select 1) as leaked -- `)).toBe(
    'select JSON_VALUE(`doc`, ' + String.raw`'$."a\') as v, (select 1) as leaked -- "[0]')` + ' as `v` from `t`',
  )
  expect(path(String.raw`a.b"c\d`)).toBe(
    'select JSON_VALUE(`doc`, ' + String.raw`'$."a.b\\"c\\\\d"[0]')` + ' as `v` from `t`',
  )
  expect(() =>
    prepare(kysely.selectFrom('t').select((eb) => eb.ref('doc', '->$').at("0]') --" as any).as('v'))),
    // Newer Kysely versions refuse the index themselves, with their own message.
  ).toThrow(/Invalid JSON path array location|Unexpected index value/)
})
