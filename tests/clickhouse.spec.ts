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
  
  await q.execute();
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

  await q.execute()
})

test('with temporary table', async () => {
  await kysely.connection().execute(async (db) => { // connection support (temp table)
    await db.schema
      .createTable("test")
      .addColumn("id", "bigint")
      .temporary()
      .execute();
  
    const db2 = db.withTables<{
      test: {
        id: number;
      };
    }>();
  
    await db2.insertInto("test").values({ id: 1 }).execute();

    await db2
      .insertInto("test")
      .expression(
        db2.selectFrom("test").select(({ eb }) => [eb("id", "+", 1).as("id")]) // complex query
      )
      .execute();
    
    const result = await db2.selectFrom("test").selectAll().orderBy('id').execute()
  
    expect(result).toMatchSnapshot()

    await db2.updateTable("test").set({ id: 3 }).where("id", "=", 1).execute();
    
    const result2 = await db2.selectFrom("test").selectAll().orderBy('id').execute()
  
    expect(result2).toMatchSnapshot()
  });

  
})