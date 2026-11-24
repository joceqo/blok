import type { Database } from './index.ts';

type TxDb = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * One transaction boundary — used wherever Go runs several statements under one lock.
 */
export async function withTransaction<T>(db: Database, run: (tx: TxDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => run(tx));
}