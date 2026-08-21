# Persistence portability comparison

**Status:** The common Plan-store interface and disposable parity harness are implemented. ADR 0010 selects PostgreSQL as the production metadata and durable-work target, but no PostgreSQL server adapter, migration deployment, backup, or operations evidence exists yet.

## Evidence used

- SQLite documents multiple readers but only one simultaneous writer, and distinguishes deferred, immediate, and exclusive transactions: [SQLite transaction documentation](https://sqlite.org/lang_transaction.html).
- SQLite provides an online backup API and `VACUUM INTO` as live-copy mechanisms: [SQLite backup documentation](https://sqlite.org/backup.html).
- PostgreSQL documents Read Committed, Repeatable Read, and Serializable behavior and requires whole-transaction retry after serialization failures: [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).
- PostgreSQL unique constraints create unique indexes, while null behavior and partial uniqueness require deliberate schema choices: [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html).
- PostgreSQL logical backup uses `pg_dump`, with restore behavior and operations remaining deployment responsibilities: [PostgreSQL SQL dump](https://www.postgresql.org/docs/current/backup-dump.html).
- PGlite runs a Postgres build in-process and exposes interactive transactions, making it a useful local compatibility adapter rather than proof of hosted PostgreSQL operations: [PGlite overview](https://pglite.dev/docs/) and [PGlite API](https://pglite.dev/docs/api).
- The current Node SQLite interface is synchronous and can open in-memory or file-backed databases: [Node SQLite documentation](https://nodejs.org/api/sqlite.html).

## Compared models

| Concern                  | SQLite-compatible model                                                                                       | PostgreSQL model exercised through PGlite                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Transaction shape        | `BEGIN IMMEDIATE` serializes the Plan read/decide/write sequence on one connection                            | `transaction` plus `SELECT … FOR UPDATE` serializes each Plan command                                               |
| Semantic uniqueness      | Composite primary key on `(plan_id, command_key)`, a bound command fingerprint, and unique Plan audit ordinal | Equivalent primary and unique constraints; conflicting fingerprint reuse fails closed                               |
| Concurrent writer model  | One writer; callers must handle busy/operational retry when multiple production connections are added         | Real PostgreSQL can run concurrent writers but serializable/lock conflicts require whole-transaction retry          |
| Local/self-host leverage | Single-file operation is attractive for small self-hosts                                                      | Operational server, connection pool, roles, upgrades, and backups are heavier but align with multi-instance hosting |
| Backup direction         | Online backup or `VACUUM INTO`; logical Vidha snapshot is test-only                                           | `pg_dump`/`pg_restore` or provider-native backups; logical Vidha snapshot is test-only                              |
| Current proof            | Node SQLite in memory under the shared contract suite                                                         | PGlite in memory under the shared contract suite; this is not a real-server load, failover, or operations test      |

## Implemented common interface

Both SQL adapters and the browser's in-memory adapter support:

1. initialize and read one synthetic Plan;
2. atomically load, authorize, decide, record an opaque command identifier and semantic fingerprint, replace state, and append new audit events;
3. return the already-committed state without re-running a matching duplicate decision, while rejecting a reused identifier with different semantics;
4. export one transactionally consistent versioned logical snapshot that contains no caller-supplied command keys, then validate and restore it; and
5. open restored data in restore-safe mode, which permits inspection but rejects state-changing transactions.

The shared pre-alpha schema baseline is migration version 1, Plan state JSON, unique processed commands with semantic fingerprints, and append-only ordered audit events. SQL syntax is adapter-specific; behavioral parity is the contract. This remains a disposable-data baseline, not evidence of an upgrade path from a deployed schema.

## Target accepted; production evidence withheld

ADR 0010 accepts PostgreSQL as Vidha's production database target; the earlier adapter decision is no longer open. The target is not implementation evidence: Vidha still lacks an executable server topology, migration and rollback rehearsal, encrypted backup rehearsal, multi-process contention evidence, capacity model, and real restore drill. The current logical snapshot contains disposable synthetic metadata and is not an encrypted v1 backup format.
