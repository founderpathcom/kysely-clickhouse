import {
  DatabaseIntrospector,
  Dialect,
  Driver,
  Kysely,
  MysqlQueryCompiler,
  QueryCompiler
} from 'kysely';

import { ClickhouseDriver } from './ClickhouseDriver';
import { ClickhouseIntrospector } from './ClickhouseIntrospector';
import type { NodeClickHouseClientConfigOptions } from '@clickhouse/client/dist/config';
import { ClickhouseAdapter } from './ClickhouseAdapter';

export interface ClickhouseDialectConfig {
  options?: NodeClickHouseClientConfigOptions;
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
    return new MysqlQueryCompiler();
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new ClickhouseIntrospector(db);
  }
}



