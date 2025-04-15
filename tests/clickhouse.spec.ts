import { expect, test } from 'vitest'

import {  ClickhouseDialect } from '../src'
import { Kysely } from 'kysely';

const kysely = new Kysely<any>({
  dialect: new ClickhouseDialect({
    options: {
      url: 'http://localhost:8123',
      username: 'founderpath',
      password: 'founderpath',
      database: 'founderpath',
    }
  })
})


// @todo: make test environment work
test('introspection', async () => {
  const tables = await kysely.introspection.getTables()

  expect(tables).toMatchSnapshot()
})

test('insert', async () => {
  const result = await kysely.insertInto('company_metrics').values([{
    company_id: 1,
    date: '2025-04-15',
    mrr: 100,
  },
    {
    company_id: 2,
    date: '2025-04-15',
    mrr: 200,
  }]).execute();

  expect(result).toMatchSnapshot()
})

test('update', async () => {
  const result = await kysely.updateTable('company_metrics').set({
    mrr: 300
  }).where('company_id', '=', 1).where('date', '=', '2025-04-15').execute();

  expect(result).toMatchSnapshot()
})