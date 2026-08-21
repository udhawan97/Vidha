# Bounded deployment topology

**Status:** Accepted topology contract, not an implemented deployment.

```text
browser
   |
api role  ---- identity / notification / object-storage adapters
   |
PostgreSQL  <---- worker role ---- scanner / converter adapters
   ^                 |
   |                 +---- synthetic sink only in disposable evidence
read-only watchdog
```

The `api` and `worker` roles run the same versioned application image with separate entry points and least-privilege credentials. PostgreSQL is the transaction and lease authority. The API role cannot dispatch provider work; the worker cannot invent lifecycle transitions. Scanner and converter processes do not receive application, database, provider, or key-custody credentials. A watchdog can observe content-free health and alert externally but cannot Check in, advance a Plan, or dispatch a task.

## Restore behavior

A restore enters `restore_safe` before any application role starts. Read-only inspection and invariant checks are allowed. Metadata writes, scheduled-job claims, outbox dispatch, scanner updates, conversion, and every provider adapter remain disabled until explicit promotion. Backup authenticity, anti-rollback generation, isolated least-privilege restore, and promotion are Phase 3B evidence targets, not Phase 3 claims.

## Explicit exclusions

There is no chosen cloud host, public DNS, TLS certificate, production secret store, KMS, object store, notification provider, monitoring provider, image registry, supported self-host platform, high-availability model, RPO, RTO, updater, or deployment. PGlite supplies PostgreSQL-shaped local contract coverage only and is not a substitute for a disposable PostgreSQL server rehearsal.
