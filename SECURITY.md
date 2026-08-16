# Security policy

Viraha is pre-alpha and has no hosted production service or released version. Security design reports are still valuable; reports involving exploitable vulnerabilities must remain private.

## Reporting privately

Private vulnerability reporting is enabled on the canonical GitHub repository. Use its **Report a vulnerability** flow only when that button is visible under **Security → Advisories**. If the button is unavailable, no verified private channel exists for that reporter: submit only the dedicated **Request private security contact** issue form, which permits no vulnerability details, and wait for a verified private route. Never include real documents, contact details, credentials, or production data. Use a minimal synthetic reproduction only after the private route exists.

Include:

- affected revision and environment;
- the violated safety property or trust boundary;
- reproducible steps using disposable data;
- likely impact, especially any false Check-in, policy bypass, unauthorized decrypt, or unintended Release path;
- suggested mitigation if known.

## Response expectations

The maintainer will acknowledge a complete report through the private advisory, reproduce it when possible, and coordinate remediation and disclosure. No response-time or bounty promise exists before v1; that limitation will be revisited before a hosted service launches.

## Supported versions

No version is supported yet. This section will list supported release lines after v1 exists.

## High-priority areas

- Check-in and Release authorization bypass
- time, concurrency, retry, and idempotency failures
- Guardian or Recipient role confusion
- Standard or Sealed Mode key exposure
- break-glass access that is unaudited or bypassable
- import sandbox escape, SSRF, macro execution, archive bomb, or content-type confusion
- notification content leakage
- backup or restore behavior that can send live notices
- build, dependency, or release-chain compromise
