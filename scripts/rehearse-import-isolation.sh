#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
runner_temp=${RUNNER_TEMP:-}
if [[ -z "$runner_temp" || ! -d "$runner_temp" ]]; then
  echo 'RUNNER_TEMP must identify the disposable CI workspace.' >&2
  exit 1
fi
if [[ $(id -u) -eq 0 ]]; then
  echo 'The import-isolation rehearsal must run as a non-root host user.' >&2
  exit 1
fi
for command_name in jq podman sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing rootless isolation dependency: $command_name" >&2
    exit 1
  fi
done

fixture_root=$(mktemp -d "$runner_temp/vidha-import-isolation.XXXXXX")
run_id="import-$(printf '%s' "${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}" | sha256sum | cut -c1-16)"
clamd_name="$run_id-scanner-runtime"
test_log="$fixture_root/isolation-test.log"

export XDG_RUNTIME_DIR="$fixture_root/xdg-runtime"
export XDG_DATA_HOME="$fixture_root/xdg-data"
export XDG_CONFIG_HOME="$fixture_root/xdg-config"
export CONTAINERS_STORAGE_CONF="$fixture_root/storage.conf"
mkdir -p \
  "$XDG_RUNTIME_DIR" \
  "$XDG_DATA_HOME" \
  "$XDG_CONFIG_HOME" \
  "$fixture_root/containers-runroot" \
  "$fixture_root/containers-graphroot"
chmod 700 "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"

cleanup() {
  podman rm --force --ignore "$clamd_name" >/dev/null 2>&1 || true
  chmod -R u+w "$fixture_root" >/dev/null 2>&1 || true
  case "$fixture_root" in
    "$runner_temp"/vidha-import-isolation.*)
      rm -rf -- "$fixture_root"
      ;;
    *)
      echo 'Refusing to remove an unexpected fixture root.' >&2
      return 1
      ;;
  esac
}
trap cleanup EXIT

cat >"$CONTAINERS_STORAGE_CONF" <<EOF
[storage]
driver = "overlay"
runroot = "$fixture_root/containers-runroot"
graphroot = "$fixture_root/containers-graphroot"

[storage.options.overlay]
mount_program = "/usr/bin/fuse-overlayfs"
EOF

if [[ $(podman info --format '{{.Host.Security.Rootless}}') != true ]]; then
  echo 'Podman did not prove rootless mode.' >&2
  exit 1
fi

toolchain="$repository_root/infra/toolchain.lock.json"
sbom="$repository_root/infra/import-isolation/sbom.spdx.json"
node_reference=$(jq -r '.nodeImage.reference + "@" + .nodeImage.digest' "$toolchain")
clamav_reference=$(jq -r '.clamav | "clamav/clamav:" + .version + "@" + .imageDigest' "$toolchain")
file_sha=$(jq -r '.file.sourceSha256' "$toolchain")
pandoc_sha=$(jq -r '.pandoc.linuxAmd64Sha256' "$toolchain")

jq -e \
  --arg node "$node_reference" \
  --arg clamav "$clamav_reference" \
  --arg file_sha "$file_sha" \
  --arg pandoc_sha "$pandoc_sha" \
  '
    .spdxVersion == "SPDX-2.3" and
    any(.packages[]; .downloadLocation == ("docker://" + $node)) and
    any(.packages[]; .downloadLocation == ("docker://" + $clamav)) and
    any(.packages[]; any(.checksums[]?; .checksumValue == $file_sha)) and
    any(.packages[]; any(.checksums[]?; .checksumValue == $pandoc_sha)) and
    all(.packages[]; .licenseDeclared != "NOASSERTION")
  ' "$sbom" >/dev/null

podman pull "$node_reference" >/dev/null
podman pull "$clamav_reference" >/dev/null
node_image_id=$(podman image inspect "$node_reference" --format '{{.Id}}')
clamav_image_id=$(podman image inspect "$clamav_reference" --format '{{.Id}}')

signature_directory="$fixture_root/signatures"
socket_directory="$fixture_root/socket"
config_directory="$fixture_root/config"
job_directory="$fixture_root/jobs"
mkdir -p "$signature_directory" "$socket_directory" "$config_directory" "$job_directory"
chmod 777 "$signature_directory" "$socket_directory"

podman run \
  --name "$run_id-signature-updater" \
  --rm \
  --pull=never \
  --label "vidha.import.run=$run_id" \
  --label 'vidha.import.role=signature-updater' \
  --network=none \
  --dns=none \
  --read-only \
  --read-only-tmpfs=false \
  --cap-drop=all \
  --security-opt=no-new-privileges \
  --pids-limit=32 \
  --memory=256m \
  --cpus=1 \
  --userns=keep-id \
  --mount "type=bind,source=$signature_directory,destination=/vidha-signatures,rw=true" \
  --entrypoint=/bin/sh \
  "$clamav_reference" \
  -eu -c '
    copied=0
    for source in /var/lib/clamav/*.cvd /var/lib/clamav/*.cld /var/lib/clamav/*.cdb /var/lib/clamav/*.hdb /var/lib/clamav/*.ldb /var/lib/clamav/*.mdb /var/lib/clamav/*.ndb; do
      if [ -f "$source" ]; then
        cp "$source" /vidha-signatures/
        copied=1
      fi
    done
    test "$copied" -eq 1
  '

(
  cd "$signature_directory"
  find . -maxdepth 1 -type f -print0 | sort -z | xargs -0 sha256sum
) >"$fixture_root/signature-manifest.txt"
signature_set_identity="sha256-$(sha256sum "$fixture_root/signature-manifest.txt" | cut -d' ' -f1)"
chmod -R a-w "$signature_directory"

cat >"$config_directory/clamd.conf" <<'EOF'
Foreground yes
LogFile /dev/null
LogFileMaxSize 0
LocalSocket /vidha-socket/clamd.sock
LocalSocketMode 666
FixStaleSocket yes
DatabaseDirectory /vidha-signatures
TemporaryDirectory /tmp
User clamav
StreamMaxLength 1M
MaxScanSize 1M
MaxFileSize 1M
MaxRecursion 2
MaxFiles 64
ExitOnOOM yes
EOF
chmod 444 "$config_directory/clamd.conf"

podman run \
  --detach \
  --name "$clamd_name" \
  --pull=never \
  --label "vidha.import.run=$run_id" \
  --label 'vidha.import.role=scanner-runtime' \
  --network=none \
  --dns=none \
  --read-only \
  --read-only-tmpfs=false \
  --cap-drop=all \
  --security-opt=no-new-privileges \
  --pids-limit=64 \
  --memory=768m \
  --cpus=1 \
  --user=clamav \
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864 \
  --mount "type=bind,source=$signature_directory,destination=/vidha-signatures,ro=true" \
  --mount "type=bind,source=$socket_directory,destination=/vidha-socket,rw=true" \
  --mount "type=bind,source=$config_directory,destination=/vidha-config,ro=true" \
  --entrypoint=clamd \
  "$clamav_reference" \
  --config-file=/vidha-config/clamd.conf >/dev/null

for attempt in $(seq 1 90); do
  if [[ -S "$socket_directory/clamd.sock" ]]; then
    break
  fi
  if [[ "$attempt" -eq 90 ]]; then
    podman logs "$clamd_name" >&2
    exit 1
  fi
  sleep 1
done

if podman exec "$clamd_name" sh -c 'touch /vidha-signatures/runtime-mutation'; then
  echo 'The scanner runtime unexpectedly mutated the immutable signature set.' >&2
  exit 1
fi

VIDHA_REQUIRE_ROOTLESS_ISOLATION=1 \
VIDHA_ROOTLESS_OCI_RUNTIME=$(command -v podman) \
VIDHA_ROOTLESS_OCI_IMAGE="$node_reference" \
VIDHA_ROOTLESS_OCI_RUN_ID="$run_id" \
VIDHA_SCANNER_TOOLS_ROOT=${VIDHA_SCANNER_TOOLS_ROOT:?} \
VIDHA_FILE_BIN=${VIDHA_FILE_BIN:?} \
VIDHA_PANDOC_BIN=${VIDHA_PANDOC_BIN:?} \
VIDHA_CLAMD_SOCKET="$socket_directory/clamd.sock" \
VIDHA_SIGNATURE_SET_IDENTITY="$signature_set_identity" \
VIDHA_IMPORT_FIXTURE_TEMP="$job_directory" \
VIDHA_OCI_STORAGE_CONF="$CONTAINERS_STORAGE_CONF" \
VIDHA_OCI_XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
VIDHA_OCI_XDG_DATA_HOME="$XDG_DATA_HOME" \
VIDHA_OCI_XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
VIDHA_SYNTHETIC_PARENT_CREDENTIAL='synthetic-private-content-canary' \
TMPDIR="$job_directory" \
pnpm --filter @vidha/documents test:isolation 2>&1 | tee "$test_log"

if grep --fixed-strings 'synthetic-private-content-canary' "$test_log"; then
  echo 'The isolation gate leaked fixture content into its log.' >&2
  exit 1
fi
if ! grep --fixed-strings '{"event":"import_isolation_failure","phase":"conversion","code":"unsupported_output"}' "$test_log" >/dev/null; then
  echo 'The isolation gate did not emit its allowlisted content-free failure event.' >&2
  exit 1
fi

podman rm --force "$clamd_name" >/dev/null
remaining=$(podman ps --all --filter "label=vidha.import.run=$run_id" --format '{{.Names}}')
if [[ -n "$remaining" ]]; then
  echo 'The import-isolation gate left run-owned containers behind.' >&2
  printf '%s\n' "$remaining" >&2
  exit 1
fi
if [[ -n $(find "$job_directory" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  echo 'The import-isolation gate left job scratch data behind.' >&2
  exit 1
fi

jq -nc \
  --arg runId "$run_id" \
  --arg podmanVersion "$(podman version --format '{{.Client.Version}}')" \
  --arg nodeImage "$node_reference" \
  --arg nodeImageId "$node_image_id" \
  --arg clamavImage "$clamav_reference" \
  --arg clamavImageId "$clamav_image_id" \
  --arg signatureSetIdentity "$signature_set_identity" \
  '{
    event: "rootless_import_isolation_rehearsed",
    runId: $runId,
    rootless: true,
    podmanVersion: $podmanVersion,
    images: {
      process: {reference: $nodeImage, imageId: $nodeImageId},
      scanner: {reference: $clamavImage, imageId: $clamavImageId}
    },
    signatureSet: {
      updaterIdentity: "signature-updater",
      runtimeIdentity: "scanner-runtime",
      immutableIdentity: $signatureSetIdentity
    },
    evidence: [
      "mismatch",
      "polyglot",
      "archive_bomb",
      "ssrf",
      "timeout",
      "output_flood",
      "malformed_ast",
      "symlink",
      "credential_denial",
      "network_denial",
      "cleanup",
      "content_free_log"
    ]
  }'
