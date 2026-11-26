import {
  DatabaseIntrospector,
  Dialect,
  Driver,
  Kysely,
  QueryCompiler
} from 'kysely';

import { ClickhouseDriver } from './ClickhouseDriver';
import { ClickhouseIntrospector } from './ClickhouseIntrospector';
import type { ClickHouseClientConfigOptions } from '@clickhouse/client';
import { ClickhouseAdapter } from './ClickhouseAdapter';
import { ClickhouseQueryCompiler } from './ClickhouseQueryCompiler';

export interface ClickhouseDialectConfig {
  options?: ClickHouseClientConfigOptions;
}

export class ClickhouseDialect implements Dialect {
  #config: ClickhouseDialectConfig;

  constructor(config?: ClickhouseDialectConfig) {
    this.#config = config ?? {};
  }

  createAdapter() {
    return new ClickhouseAdapter();
  }

  createDriver(): Driver {
    return new ClickhouseDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new ClickhouseQueryCompiler();
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new ClickhouseIntrospector(db);
  }
}
