export const identityRehearsalHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <title>Vidha credential boundary rehearsal</title>
    <link rel="stylesheet" href="/rehearsal/webauthn.css" />
  </head>
  <body>
    <main class="shell">
      <header class="masthead">
        <p class="boundary">Disposable loopback rehearsal · synthetic identity only</p>
        <h1>Prove the credential boundary.</h1>
        <p class="lede">
          This page exercises one local WebAuthn credential, an opaque server
          session, CSRF protection, rotation, and revocation. It does not create
          a real Vidha account or contact anyone.
        </p>
      </header>

      <section class="rehearsal" aria-labelledby="rehearsal-title">
        <div class="continuity-rail" aria-hidden="true">
          <span class="rail-knot rail-knot--one"></span>
          <span class="rail-knot rail-knot--two"></span>
          <span class="rail-knot rail-knot--three"></span>
        </div>

        <div class="sequence">
          <h2 id="rehearsal-title">Three bounded steps</h2>
          <ol>
            <li data-step="bootstrap">
              <span class="step-number">1</span>
              <div>
                <strong>Create a disposable credential</strong>
                <p>Requires the one-time loopback bootstrap capability.</p>
              </div>
            </li>
            <li data-step="authenticate">
              <span class="step-number">2</span>
              <div>
                <strong>Authenticate</strong>
                <p>Issues an HttpOnly session cookie; authenticating again rotates it.</p>
              </div>
            </li>
            <li data-step="revoke">
              <span class="step-number">3</span>
              <div>
                <strong>End the session</strong>
                <p>Requires the in-memory CSRF token and revokes server authority.</p>
              </div>
            </li>
          </ol>
        </div>

        <form class="control-panel" id="rehearsal-form">
          <label for="bootstrap-capability">Bootstrap capability</label>
          <div class="secret-row">
            <input
              id="bootstrap-capability"
              name="bootstrap-capability"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste the disposable fixture capability"
              disabled
            />
            <button type="button" id="bootstrap" disabled>Create credential</button>
          </div>

          <div class="session-actions" aria-label="Session rehearsal actions">
            <button type="button" class="secondary" id="authenticate" disabled>
              Authenticate
            </button>
            <button type="button" class="secondary" id="check-session" disabled>
              Check session
            </button>
            <button type="button" class="quiet" id="revoke-session" disabled>
              End session
            </button>
          </div>

          <output id="status" class="status" aria-live="polite">
            Checking the local rehearsal state…
          </output>

          <section class="recovery-brake" aria-labelledby="recovery-brake-title">
            <p class="brake-label">Recovery boundary · held closed</p>
            <h3 id="recovery-brake-title">No fallback shortcut.</h3>
            <p>
              Lost this disposable credential? There is no in-place reset. End
              this run, let <code>pnpm test:webauthn</code> remove its run-owned
              database, then rerun it to create a fresh disposable fixture. The
              abuse matrix is tested below this interface; this page exposes no
              recovery completion, email or SMS fallback, or Verified Owner
              Channel delivery.
            </p>
          </section>
        </form>
      </section>

      <aside class="non-claim" aria-label="Rehearsal boundary">
        <strong>What this cannot prove</strong>
        <p>
          No real authenticator support, account recovery, public origin, delivery,
          Guardian authority, or Release path is enabled by this fixture.
        </p>
      </aside>
    </main>
    <script src="/rehearsal/webauthn.js" defer></script>
  </body>
</html>`;

export const identityRehearsalCss = `:root {
  color: #10241f;
  background: #e7f0eb;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}

* {
  box-sizing: border-box;
}

body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  background:
    linear-gradient(90deg, rgba(12, 81, 63, 0.06) 1px, transparent 1px) 0 0 / 48px 48px,
    #e7f0eb;
}

button,
input {
  font: inherit;
}

.shell {
  width: min(100% - 32px, 980px);
  margin: 0 auto;
  padding: 64px 0 48px;
}

.masthead {
  max-width: 760px;
}

.boundary {
  margin: 0 0 18px;
  color: #0c513f;
  font-size: 0.74rem;
  font-weight: 750;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  max-width: 690px;
  margin-bottom: 18px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2.65rem, 7vw, 5.6rem);
  font-weight: 500;
  letter-spacing: -0.055em;
  line-height: 0.92;
}

.lede {
  max-width: 690px;
  color: #36564d;
  font-size: 1.08rem;
  line-height: 1.65;
}

.rehearsal {
  position: relative;
  display: grid;
  grid-template-columns: minmax(250px, 0.78fr) minmax(360px, 1.22fr);
  gap: 0;
  margin-top: 52px;
  overflow: hidden;
  border: 1px solid rgba(16, 36, 31, 0.16);
  border-radius: 26px;
  background: #fbfdfc;
  box-shadow: 0 28px 80px rgba(22, 60, 50, 0.13);
}

.continuity-rail {
  position: absolute;
  z-index: 2;
  top: 48px;
  bottom: 48px;
  left: 43px;
  width: 2px;
  background: #76a896;
}

.rail-knot {
  position: absolute;
  left: 50%;
  width: 13px;
  height: 13px;
  border: 3px solid #fbfdfc;
  border-radius: 50%;
  background: #0c513f;
  box-shadow: 0 0 0 1px #0c513f;
  transform: translate(-50%, -50%);
}

.rail-knot--one { top: 19%; }
.rail-knot--two { top: 50%; }
.rail-knot--three { top: 81%; }

.sequence {
  padding: 44px 38px 44px 72px;
  color: #f4faf7;
  background: #0d3d32;
}

.sequence h2 {
  margin-bottom: 28px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.62rem;
  font-weight: 500;
}

.sequence ol {
  display: grid;
  gap: 30px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sequence li {
  display: grid;
  grid-template-columns: 32px 1fr;
  gap: 14px;
  align-items: start;
  opacity: 0.64;
  transition: opacity 160ms ease;
}

.sequence li[data-state="current"],
.sequence li[data-state="complete"] {
  opacity: 1;
}

.step-number {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid rgba(244, 250, 247, 0.48);
  border-radius: 50%;
  font-size: 0.78rem;
  font-weight: 750;
}

.sequence strong {
  display: block;
  margin: 4px 0 7px;
  font-size: 0.97rem;
}

.sequence p {
  margin-bottom: 0;
  color: #bcd4cb;
  font-size: 0.84rem;
  line-height: 1.5;
}

.control-panel {
  padding: 52px 48px;
}

.control-panel > label {
  display: block;
  margin-bottom: 10px;
  color: #264a40;
  font-size: 0.78rem;
  font-weight: 750;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.secret-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
}

input {
  min-width: 0;
  padding: 14px 15px;
  border: 1px solid #a9c1b8;
  border-radius: 12px;
  color: #10241f;
  background: #f7faf8;
}

button {
  min-height: 48px;
  padding: 12px 17px;
  border: 1px solid #0c513f;
  border-radius: 999px;
  color: #ffffff;
  background: #0c513f;
  font-weight: 720;
  cursor: pointer;
}

button.secondary {
  color: #0c513f;
  background: transparent;
}

button.quiet {
  border-color: transparent;
  color: #6c342f;
  background: transparent;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

button:not(:disabled):hover {
  transform: translateY(-1px);
}

button:focus-visible,
input:focus-visible {
  outline: 3px solid #e5ae55;
  outline-offset: 3px;
}

.session-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid #d8e4df;
}

.status {
  display: block;
  min-height: 74px;
  margin-top: 28px;
  padding: 18px 20px;
  border-left: 4px solid #76a896;
  border-radius: 0 12px 12px 0;
  color: #264a40;
  background: #edf5f1;
  line-height: 1.5;
}

.status[data-kind="error"] {
  border-left-color: #a04439;
  color: #6c342f;
  background: #fbefed;
}

.recovery-brake {
  position: relative;
  margin-top: 26px;
  padding: 22px 22px 22px 58px;
  overflow: hidden;
  border: 1px solid #dfc58e;
  border-radius: 16px;
  background: #fffaf0;
}

.recovery-brake::before {
  position: absolute;
  top: -18px;
  bottom: -18px;
  left: 25px;
  width: 8px;
  border: 2px solid #fffaf0;
  border-radius: 999px;
  background: #d6922f;
  box-shadow: 0 0 0 1px #b8751f;
  content: "";
  transform: rotate(12deg);
}

.recovery-brake h3 {
  margin: 0 0 7px;
  color: #4d3215;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.18rem;
  font-weight: 600;
}

.recovery-brake p:last-child {
  margin: 0;
  color: #6c5438;
  font-size: 0.84rem;
  line-height: 1.55;
}

.brake-label {
  margin: 0 0 8px;
  color: #8a571d;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.non-claim {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 18px;
  max-width: 760px;
  margin: 24px 0 0 auto;
  padding: 18px 20px;
  color: #49655d;
  font-size: 0.84rem;
  line-height: 1.55;
}

.non-claim strong {
  color: #10241f;
  white-space: nowrap;
}

.non-claim p {
  margin-bottom: 0;
}

@media (max-width: 760px) {
  .shell {
    width: min(100% - 20px, 620px);
    padding-top: 34px;
  }

  h1 {
    font-size: clamp(2.55rem, 15vw, 4.4rem);
  }

  .rehearsal {
    grid-template-columns: 1fr;
    margin-top: 34px;
    border-radius: 20px;
  }

  .continuity-rail {
    top: 38px;
    bottom: auto;
    left: 42px;
    height: 218px;
  }

  .sequence {
    padding: 34px 28px 34px 70px;
  }

  .sequence ol {
    gap: 22px;
  }

  .control-panel {
    padding: 34px 24px;
  }

  .secret-row {
    grid-template-columns: 1fr;
  }

  .non-claim {
    grid-template-columns: 1fr;
    gap: 5px;
    padding-inline: 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}`;

export const identityRehearsalJavascript = `'use strict';

const OWNER_ID = 'owner_' + 'a'.repeat(64);
const capability = document.querySelector('#bootstrap-capability');
const bootstrap = document.querySelector('#bootstrap');
const authenticate = document.querySelector('#authenticate');
const checkSession = document.querySelector('#check-session');
const revokeSession = document.querySelector('#revoke-session');
const status = document.querySelector('#status');
let csrfToken = null;
let credentialReady = false;
let hydrated = false;

bootstrap.addEventListener('click', async () => {
  await run('Creating a disposable credential…', async () => {
    if (!capability.value) throw new Error('Enter the disposable bootstrap capability.');
    const started = await post('/v1/identity/webauthn/bootstrap/options', {
      bootstrapCapability: capability.value,
      ownerId: OWNER_ID,
    });
    const credential = await navigator.credentials.create({
      publicKey: creationOptions(started.options),
    });
    if (!(credential instanceof PublicKeyCredential)) {
      throw new Error('The browser did not return a WebAuthn credential.');
    }
    await post('/v1/identity/webauthn/bootstrap/verify', {
      ceremonyId: started.ceremonyId,
      response: credentialResponse(credential),
    });
    capability.value = '';
    credentialReady = true;
    setStep('bootstrap', 'complete');
    setStep('authenticate', 'current');
    return 'Credential ready. Authenticate to issue an opaque server session.';
  });
});

authenticate.addEventListener('click', async () => {
  await run('Waiting for verified user presence…', async () => {
    const started = await post('/v1/identity/webauthn/authentication/options', {
      ownerId: OWNER_ID,
    });
    const assertion = await navigator.credentials.get({
      publicKey: requestOptions(started.options),
    });
    if (!(assertion instanceof PublicKeyCredential)) {
      throw new Error('The browser did not return a WebAuthn assertion.');
    }
    const result = await post('/v1/identity/webauthn/authentication/verify', {
      ceremonyId: started.ceremonyId,
      response: credentialResponse(assertion),
    });
    csrfToken = result.csrfToken;
    checkSession.disabled = false;
    revokeSession.disabled = false;
    setStep('authenticate', 'complete');
    setStep('revoke', 'current');
    return 'Session active. Authenticate again to rotate it, or end it explicitly.';
  });
});

checkSession.addEventListener('click', async () => {
  await run('Checking server authority…', async () => {
    const result = await get('/v1/identity/session');
    csrfToken = result.csrfToken;
    return 'Session is active and expires at ' + new Date(result.expiresAt).toISOString() + '.';
  });
});

revokeSession.addEventListener('click', async () => {
  await run('Revoking server authority…', async () => {
    if (!csrfToken) throw new Error('Check or authenticate the session first.');
    await post('/v1/identity/session/revoke', {}, csrfToken);
    csrfToken = null;
    checkSession.disabled = true;
    revokeSession.disabled = true;
    setStep('revoke', 'complete');
    return 'Session ended. The HttpOnly cookie no longer carries authority.';
  });
});

async function run(pending, operation) {
  setStatus(pending);
  setBusy(true);
  try {
    setStatus(await operation());
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'The bounded action failed.', true);
  } finally {
    setBusy(false);
  }
}

async function post(path, body, csrf) {
  const headers = { 'content-type': 'application/json' };
  if (csrf) headers['x-vidha-csrf'] = csrf;
  const response = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  return await decode(response);
}

async function get(path) {
  return await decode(await fetch(path, { credentials: 'same-origin' }));
}

async function decode(response) {
  const value = await response.json();
  if (!response.ok) {
    throw new Error('Boundary rejected the action: ' + (value.status || 'request_failed') + '.');
  }
  return value;
}

function creationOptions(options) {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    user: { ...options.user, id: fromBase64Url(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item) => ({
      ...item,
      id: fromBase64Url(item.id),
    })),
  };
}

function requestOptions(options) {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((item) => ({
      ...item,
      id: fromBase64Url(item.id),
    })),
  };
}

function credentialResponse(credential) {
  const response = credential.response;
  const common = {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  if (response instanceof AuthenticatorAttestationResponse) {
    return {
      ...common,
      response: {
        attestationObject: toBase64Url(response.attestationObject),
        clientDataJSON: toBase64Url(response.clientDataJSON),
        transports: response.getTransports(),
      },
    };
  }
  return {
    ...common,
    response: {
      authenticatorData: toBase64Url(response.authenticatorData),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
    },
  };
}

function fromBase64Url(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.kind = error ? 'error' : 'status';
}

function setBusy(busy) {
  capability.disabled = busy || !hydrated || credentialReady;
  bootstrap.disabled = busy || !hydrated || credentialReady;
  authenticate.disabled = busy || !hydrated || !credentialReady;
  checkSession.disabled = busy || !hydrated || !csrfToken;
  revokeSession.disabled = busy || !hydrated || !csrfToken;
}

function setStep(name, state) {
  document.querySelector('[data-step="' + name + '"]').dataset.state = state;
}

async function hydrate() {
  if (!('PublicKeyCredential' in window)) {
    credentialReady = false;
    setBusy(true);
    setStatus('This browser does not expose WebAuthn. Use a supported local browser for this rehearsal.', true);
    return;
  }
  try {
    const rehearsal = await get('/rehearsal/webauthn/status');
    credentialReady = rehearsal.credentialReady === true;
    if (rehearsal.sessionActive === true) {
      const session = await get('/v1/identity/session');
      csrfToken = session.csrfToken;
      setStep('bootstrap', 'complete');
      setStep('authenticate', 'complete');
      setStep('revoke', 'current');
      setStatus('Session restored from its HttpOnly cookie. Check it or end it explicitly.');
    } else if (credentialReady) {
      setStep('bootstrap', 'complete');
      setStep('authenticate', 'current');
      setStatus('Credential ready. Authenticate to issue an opaque server session.');
    } else {
      setStep('bootstrap', 'current');
      setStatus('Paste the disposable capability to create the first credential.');
    }
    hydrated = true;
  } catch {
    hydrated = false;
    setStatus('The rehearsal state could not be loaded. All actions remain disabled.', true);
  } finally {
    setBusy(false);
  }
}

void hydrate();`;
