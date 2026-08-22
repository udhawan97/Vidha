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

A restore enters `restore_safe` before any application role starts. Read-only inspection and invariant checks are allowed. Metadata writes, scheduled-job claims, outbox dispatch, scanner updates, conversion, and every provider adapter remain disabled until explicit promotion. The intermediate Phase 3B milestone signs and chains synthetic backup manifests and rejects PostgreSQL mutations/claims in restore-safe adapters; a real logical backup, isolated least-privilege restore, invariant report, rollback rejection, and promotion remain Phase 3B closure targets.

## Explicit exclusions

There is no chosen cloud host, public DNS, TLS certificate, production secret store, KMS, object store, notification provider, monitoring provider, image registry, supported self-host platform, high-availability model, RPO, RTO, updater, or deployment. The disposable PostgreSQL 18 service and Compose topology are CI fixtures with synthetic credentials and temporary storage; they are not a production environment.
