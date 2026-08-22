export interface PlatformMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const PLATFORM_SCHEMA_VERSION = 1;

export const platformMigrations: readonly PlatformMigration[] = [
  {
    version: 1,
    name: 'phase_3b_foundation',
    sql: `
      CREATE TABLE runtime_configuration (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        environment_id TEXT NOT NULL CHECK (environment_id ~ '^environment_[a-f0-9]{64}$'),
        installation_id TEXT NOT NULL CHECK (installation_id ~ '^installation_[a-f0-9]{64}$'),
        mode TEXT NOT NULL CHECK (mode IN ('live', 'restore_safe')),
        promoted_at BIGINT NULL
      );

      CREATE TABLE owner_identity_states (
        owner_id TEXT PRIMARY KEY CHECK (owner_id ~ '^owner_[a-f0-9]{64}$'),
        security_revision INTEGER NOT NULL CHECK (security_revision > 0),
        state_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );

      CREATE TABLE plan_schema (
        version INTEGER PRIMARY KEY
      );
      INSERT INTO plan_schema(version) VALUES (1);
      CREATE TABLE plans (
        plan_id TEXT PRIMARY KEY CHECK (plan_id ~ '^[a-z][a-z0-9_-]{7,63}$'),
        state_json JSONB NOT NULL
      );
      CREATE TABLE processed_commands (
        plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
        command_key TEXT NOT NULL,
        command_fingerprint TEXT NOT NULL,
        processed_at BIGINT NOT NULL,
        PRIMARY KEY (plan_id, command_key)
      );
      CREATE TABLE audit_events (
        plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at BIGINT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (plan_id, event_id),
        UNIQUE (plan_id, ordinal)
      );

      CREATE TABLE webauthn_ceremonies (
        ceremony_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('bootstrap_register', 'register', 'authenticate', 'reauthenticate')),
        challenge_digest TEXT NOT NULL CHECK (challenge_digest ~ '^[a-f0-9]{64}$'),
        configuration_revision INTEGER NOT NULL CHECK (configuration_revision > 0),
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        consumed_at BIGINT NULL
      );

      CREATE TABLE webauthn_credentials (
        credential_id TEXT PRIMARY KEY CHECK (credential_id ~ '^credential_[a-f0-9]{64}$'),
        webauthn_credential_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        public_key BYTEA NOT NULL,
        counter BIGINT NOT NULL CHECK (counter >= 0),
        transports_json JSONB NULL,
        created_at BIGINT NOT NULL,
        revoked_at BIGINT NULL
      );
      CREATE INDEX webauthn_credentials_owner_idx ON webauthn_credentials(owner_id);

      CREATE TABLE webauthn_assertion_proofs (
        proof_digest TEXT PRIMARY KEY CHECK (proof_digest ~ '^[a-f0-9]{64}$'),
        owner_id TEXT NOT NULL,
        credential_id TEXT NOT NULL REFERENCES webauthn_credentials(credential_id),
        purpose TEXT NOT NULL CHECK (purpose IN ('authenticate', 'reauthenticate')),
        authenticated_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE TABLE recovery_proof_attempts (
        attempt_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        saved_code_digest TEXT NOT NULL CHECK (saved_code_digest ~ '^[a-f0-9]{64}$'),
        issued_channel_digest TEXT NOT NULL CHECK (issued_channel_digest ~ '^[a-f0-9]{64}$'),
        expires_at BIGINT NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
        locked_until BIGINT NULL,
        consumed_at BIGINT NULL
      );

      CREATE TABLE encrypted_metadata (
        record_id TEXT PRIMARY KEY CHECK (record_id ~ '^metadata_[a-f0-9]{64}$'),
        state_json JSONB NOT NULL,
        retain_until BIGINT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE safety_jobs (
        job_id TEXT PRIMARY KEY CHECK (job_id ~ '^job_[a-f0-9]{64}$'),
        kind TEXT NOT NULL CHECK (kind IN ('advance_plan_stage', 'synthetic_notice')),
        semantic_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'dead_letter')),
        available_at BIGINT NOT NULL,
        lease_id TEXT NULL,
        lease_owner TEXT NULL,
        lease_expires_at TIMESTAMPTZ NULL,
        claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
        state_json JSONB NOT NULL,
        CHECK (state_json->>'jobId' = job_id),
        CHECK (state_json->>'kind' = kind),
        CHECK (state_json->>'commandKey' = semantic_key),
        CHECK (state_json->>'status' = status),
        CHECK ((state_json->>'availableAt')::bigint = available_at),
        CHECK ((state_json->>'leaseVersion')::integer = claim_generation),
        CHECK ((state_json->>'leaseId') IS NOT DISTINCT FROM lease_id),
        CHECK ((state_json->>'leaseOwner') IS NOT DISTINCT FROM lease_owner),
        CHECK (
          (lease_expires_at IS NULL) =
            (state_json->>'leaseExpiresAt' IS NULL)
          AND (
            lease_expires_at IS NULL
            OR floor(extract(epoch FROM lease_expires_at) * 1000)::bigint =
              (state_json->>'leaseExpiresAt')::bigint
          )
        ),
        UNIQUE (semantic_key)
      );
      CREATE INDEX safety_jobs_due_idx ON safety_jobs(status, available_at, job_id);

      CREATE FUNCTION reject_safety_job_intent_rewrite() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      BEGIN
        IF NEW.job_id IS DISTINCT FROM OLD.job_id
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.semantic_key IS DISTINCT FROM OLD.semantic_key
          OR (
            NEW.state_json - ARRAY[
              'status', 'attempts', 'availableAt', 'leaseId', 'leaseOwner',
              'leaseExpiresAt', 'leaseVersion', 'completedAt', 'lastFailureCode'
            ]
          ) IS DISTINCT FROM (
            OLD.state_json - ARRAY[
              'status', 'attempts', 'availableAt', 'leaseId', 'leaseOwner',
              'leaseExpiresAt', 'leaseVersion', 'completedAt', 'lastFailureCode'
            ]
          )
        THEN
          RAISE EXCEPTION 'safety job intent is immutable';
        END IF;
        RETURN NEW;
      END
      $guard$;
      CREATE TRIGGER safety_job_intent_immutable
      BEFORE UPDATE ON safety_jobs
      FOR EACH ROW EXECUTE FUNCTION reject_safety_job_intent_rewrite();

      CREATE TABLE synthetic_sink_receipts (
        job_id TEXT PRIMARY KEY REFERENCES safety_jobs(job_id),
        payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );

      DO $roles$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vidha_api') THEN
          GRANT SELECT ON vidha_migrations, runtime_configuration, plan_schema TO vidha_api;
          GRANT SELECT, INSERT, UPDATE ON
            owner_identity_states, webauthn_ceremonies, webauthn_credentials,
            recovery_proof_attempts, plans
          TO vidha_api;
          GRANT SELECT, INSERT ON processed_commands, audit_events, safety_jobs TO vidha_api;
          GRANT SELECT, INSERT, DELETE ON webauthn_assertion_proofs TO vidha_api;
          GRANT SELECT, INSERT, UPDATE, DELETE ON encrypted_metadata TO vidha_api;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vidha_worker') THEN
          GRANT SELECT ON vidha_migrations, runtime_configuration TO vidha_worker;
          GRANT SELECT ON safety_jobs TO vidha_worker;
          GRANT UPDATE(
            status, available_at, lease_id, lease_owner, lease_expires_at,
            claim_generation, state_json
          ) ON safety_jobs TO vidha_worker;
          GRANT SELECT, INSERT ON synthetic_sink_receipts TO vidha_worker;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vidha_restore') THEN
          GRANT SELECT ON ALL TABLES IN SCHEMA public TO vidha_restore;
        END IF;
      END
      $roles$;
    `,
  },
];
