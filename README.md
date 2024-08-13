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

