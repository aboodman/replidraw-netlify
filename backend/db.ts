// Low-level config and utilities for Postgres.

import { Pool, QueryResult } from "pg";

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false,
        },
      }
    : undefined
);

// the pool will emit an error on behalf of any idle clients
// it contains if a backend error or network partition happens
pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

pool.on("connect", (client) => {
  client.query(
    "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE"
  );
});

export async function withExecutor<R>(
  f: (executor: Executor) => R
): Promise<R> {
  const client = await pool.connect();

  const executor = async (sql: string, params?: any[]) => {
    try {
      return await client.query(sql, params);
    } catch (e) {
      throw new Error(
        `Error executing SQL: ${sql}: ${((e as unknown) as any).toString()}`
      );
    }
  };

  try {
    return await f(executor);
  } finally {
    client.release();
  }
}

export type Executor = (sql: string, params?: any[]) => Promise<QueryResult>;
export type TransactionBodyFn<R> = (executor: Executor) => Promise<R>;

/**
 * Invokes a supplied function within an RDS transaction.
 * @param body Function to invoke. If this throws, the transaction will be rolled
 * back. The thrown error will be re-thrown.
 */
export async function transact<R>(body: TransactionBodyFn<R>) {
  return await withExecutor(async (executor) => {
    return await transactWithExecutor(executor, body);
  });
}

async function transactWithExecutor<R>(
  executor: Executor,
  body: TransactionBodyFn<R>
) {
  await executor("begin");
  try {
    const r = await body(executor);
    await executor("commit");
    return r;
  } catch (e) {
    await executor("rollback");
    throw e;
  }
}

export async function createDatabase() {
  await transact(async (executor) => {
    // TODO: Proper versioning for schema.
    await executor("drop table if exists client cascade");
    await executor("drop table if exists object cascade");

    await executor(`create table client (
      id varchar(100) primary key not null,
      lastmutationid int not null)`);

    // On normalization:
    //
    // For simplicity of demo purposes, and because we don't really need any
    // advanced backend features, we model backend storage as a kv store. This
    // allows us to share code more easily and reduces the amount of schema
    // management goop.
    //
    // There's no particular reason that you couldn't use a fully-normalized
    // relational model on the backend if you want (or need to for legacy)
    // reasons. Just more work!
    //
    //
    // On cookies:
    //
    // To maximize concurrency we don't want any write locks shared across
    // clients. The canonical way to do this in a Replicache backends is to
    // return a cookie which is a pointer into some server-side storage which
    // contains information about what data was returned last time. This trades
    // a small amount of highly contended write load at push time for a larger
    // amount of uncontended read and write load at read-time.
    //
    // However, for this application it's even easier to just use a timestamp.
    // There is some tiny chance of skew and losing data (e.g., if the server's
    // time changes). However in that case we'll lose a moouse move update or
    // something and just pick it up again next time it changes.
    //
    // There are many different strategies for calculating changed rows and the
    // details are very dependent on what you are building. Contact us if you'd
    // like help: https://replicache.dev/#contact.
    await executor(`create table object (
      k varchar(100) not null,
      v text not null,
      documentid varchar(100) not null,
      deleted bool not null default false,
      lastmodified timestamp(6) not null,
      unique (documentid, k)
      )`);

    await executor(`create index on object (documentid)`);
    await executor(`create index on object (deleted)`);
    await executor(`create index on object (lastmodified)`);
  });
}
