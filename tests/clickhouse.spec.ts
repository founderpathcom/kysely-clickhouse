import { expect, test } from 'vitest'

import {  ClickhouseDialect } from '../src'
import { Kysely } from 'kysely';
import { sql } from 'kysely';

const kysely = new Kysely<any>({
  dialect: new ClickhouseDialect({
    options: {
      url: 'http://localhost:8123',
      username: 'clickhouse',
      password: 'clickhouse',
      database: 'test',
    }
  })
})


// @todo: make test environment work
test('introspection', async () => {
  const tables = await kysely.introspection.getTables()

  expect(tables).toMatchSnapshot()
})

test('insert', async () => {
  const q = kysely.insertInto('company_metrics').values([{
    company_id: 1,
    date: '2025-04-15',
    mrr: 100,
  },
  {
    company_id: 2,
    date: '2025-04-15',
    mrr: 200,
    }]);
  
  const compiled = q.compile();
  expect(compiled).toMatchSnapshot()
  
  // await q.execute();
})

test('complicated insert', async () => {
  const q = kysely
  .insertInto('company_metrics')
  .columns(['company_id', 'date', 'mrr'])
  .expression(
    kysely.selectFrom('company_metrics').select([sql`3`.as('company_id'), 'date', sql`mrr + 300`.as('mrr')]),
  )

  const compiled = q.compile();

  expect(compiled).toMatchSnapshot()

  // await q.execute()
})