import { DialectAdapterBase, Kysely, MigrationLockOptions } from "kysely"

export class ClickhouseAdapter extends DialectAdapterBase {
  get supportsTransactionalDdl(): boolean {
    return false
  }

  get supportsReturning(): boolean {
    return true
  }

  async acquireMigrationLock(
    _db: Kysely<any>,
    _opt: MigrationLockOptions,
  ): Promise<void> {
    
  }

  async releaseMigrationLock(
    _db: Kysely<any>,
    _opt: MigrationLockOptions,
  ): Promise<void> {
    
  }
}