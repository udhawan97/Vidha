# Start with a pure domain package and a React/Vite PWA

Phase 1 uses a TypeScript monorepo with a dependency-light `packages/domain` module and a React/Vite client in `apps/web`. The domain owns injected-time, idempotent Check-in transitions through Concern; the client uses only synthetic, in-memory data and a prompted service-worker update flow. Worker, authentication, persistence, cryptography, provider, Guardian-authority, and Release choices remain deferred until their contracts and failure modes are resolved.
