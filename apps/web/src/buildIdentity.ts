import { buildIdentityLabel, isBuildIdentity } from './updateHandoffReceipt';

const injectedBuildIdentity =
  import.meta.env.VITE_VIDHA_BUILD_ID ?? 'local-development';

if (!isBuildIdentity(injectedBuildIdentity)) {
  throw new Error('Vidha received an invalid application build identity.');
}

export const currentBuildIdentity = injectedBuildIdentity;
export const currentBuildLabel = buildIdentityLabel(currentBuildIdentity);
