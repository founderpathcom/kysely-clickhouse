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


test('insert', async () => {
  await kysely.insertInto('test').values([
    {id: 10, name: 'test', created_at: new Date()}
  ]).execute();
})

test('introspection', async () => {
  const tables = await kysely.introspection.getTables()

  expect(tables).toMatchSnapshot()
})