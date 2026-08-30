const BUILD_IDENTITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u;

export function isBuildIdentity(value: unknown): value is string {
  return typeof value === 'string' && BUILD_IDENTITY_PATTERN.test(value);
}

export function buildIdentityLabel(identity: string): string {
  return identity.length > 12 ? identity.slice(0, 12) : identity;
}

const injectedBuildIdentity =
  import.meta.env.VITE_VIDHA_BUILD_ID ?? 'local-development';

if (!isBuildIdentity(injectedBuildIdentity)) {
  throw new Error('Vidha received an invalid application build identity.');
}

export const currentBuildIdentity = injectedBuildIdentity;
export const currentBuildLabel = buildIdentityLabel(currentBuildIdentity);
