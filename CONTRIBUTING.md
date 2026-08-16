# Contributing to Viraha

Viraha handles sensitive material and irreversible disclosure. Contributions are welcome, but safety and precise language take precedence over feature count.

## Before opening a change

1. Read `AGENTS.md`, `CONTEXT.md`, the ADRs, product brief, and threat model.
2. Search existing issues and explain the user problem before proposing an implementation.
3. Use canonical terms from `CONTEXT.md`; do not introduce “death detection,” “beneficiary,” or “will” language casually.
4. For a product decision, discuss the trade-off before changing code. Add an ADR only when the decision meets the repository's ADR threshold.
5. Keep personal information, real contacts, private documents, tokens, provider credentials, and production delivery endpoints out of issues, fixtures, screenshots, and logs.

## Pull requests

A focused pull request should include:

- the failure mode or user outcome being addressed;
- the affected domain invariant and evidence that it remains true;
- tests for success, exact time boundaries, retries, and relevant failure paths;
- public-documentation changes when visible behavior or trust boundaries change;
- screenshots only from disposable demo data after a runnable app exists;
- no unrelated formatting, dependency, or generated-file churn.

Until implementation exists, documentation changes can run:

```sh
./scripts/check-docs.sh
```

Fable will replace this with the full clean-checkout gate during implementation. Do not weaken a failing check to make a release pass.

## Commit and release boundaries

Maintainers decide release scope. A merged feature is not automatically shipped. Version 1 requires every item in `docs/release/V1_RELEASE_GATES.md`, an evidence-led `refresh-docs` pass, and the required council review.

## Security reports

Do not open a public issue for a vulnerability or a scenario that could expose a real Envelope. Follow [SECURITY.md](SECURITY.md).
