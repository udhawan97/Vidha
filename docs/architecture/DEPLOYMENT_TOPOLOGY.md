# Bounded deployment topology

**Status:** Accepted topology contract with a disposable digest-pinned Compose fixture, not a hosted or supported self-host deployment.

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

In the disposable Compose fixture, PostgreSQL and worker traffic stays on an internal data network. The API alone also joins a separate edge network whose only published port is bound to host loopback for health/readiness evidence. This is not a public endpoint or a production network design.

## Restore behavior

A restore enters `restore_safe` before any application role starts. Read-only inspection and invariant checks are allowed. Metadata writes, scheduled-job claims, outbox dispatch, scanner updates, conversion, and every provider adapter remain disabled until explicit promotion. Closure-slice-2 source now rehearses a digest-pinned custom logical dump, wrapped-key archive encryption, signed generation chain, external inventory, a dedicated non-superuser restore into an isolated tmpfs database, portable-state and migration invariants, read-only promotion denial, and one immutable explicit-promotion digest. Exact-commit CI acceptance is still required. The providers are disposable in-memory fixtures and the archive is bounded in memory; this is not external key custody, a durable backup service, persistent-volume recovery, or RPO/RTO evidence.

## Explicit exclusions

There is no chosen cloud host, public DNS, TLS certificate, production secret store, KMS, object store, notification provider, monitoring provider, image registry, supported self-host platform, high-availability model, RPO, RTO, updater, or deployment. The disposable PostgreSQL 18 service and Compose topology are CI fixtures with synthetic credentials and temporary storage; they are not a production environment.
