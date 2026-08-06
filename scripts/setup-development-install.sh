#!/usr/bin/env bash
# Set up the unpacked CDT Bridge development extension for this local browser profile.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-development-install.sh [options]

Sets up native-messaging registration for the stable development extension ID
embedded in extension/manifest.json. Then load extension/ as an unpacked
extension from chrome://extensions (or the equivalent browser page).

Options:
  --browser <chrome|chromium|edge|all>  Browser registrations to create (default: all)
  --dry-run                             Print the derived ID without registering the host
  --new-development-key                 Intentionally create a new local development key and
                                        replace manifest.json's public key before registration
  -h, --help                            Show this help

Do not use --new-development-key for a normal install. The committed public
key gives every checkout the same development extension ID. Rotating it
requires updating every target extension that trusts this controller ID.
EOF
}

browser="all"
dry_run=false
new_development_key=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --browser)
      browser="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --new-development-key)
      new_development_key=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$browser" in
  chrome|chromium|edge|all) ;;
  *)
    echo "Unsupported browser: $browser. Expected chrome, chromium, edge, or all." >&2
    exit 1
    ;;
esac

for command in node base64; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command must be available on PATH." >&2
    exit 1
  fi
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
manifest_path="$repo_root/extension/manifest.json"
key_path="$repo_root/development-controller.pem"
reload_config_path="$repo_root/native-host/development-reload.config.json"
register_script="$repo_root/scripts/register-native-host.sh"

if [[ ! -f "$manifest_path" ]]; then
  echo "Extension manifest was not found: $manifest_path" >&2
  exit 1
fi

if [[ "$new_development_key" == true ]]; then
  if [[ -e "$key_path" ]]; then
    echo "Refusing to overwrite existing development key: $key_path" >&2
    exit 1
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl must be available to create a development key." >&2
    exit 1
  fi

  umask 077
  openssl genrsa -out "$key_path" 2048
  public_key="$(openssl rsa -in "$key_path" -pubout -outform DER 2>/dev/null | base64 -w 0)"
  MANIFEST_PATH="$manifest_path" PUBLIC_KEY="$public_key" node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";

const manifestPath = process.env.MANIFEST_PATH;
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.key = process.env.PUBLIC_KEY;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
  echo "Created local development key at $key_path and updated extension/manifest.json."
fi

extension_id="$(MANIFEST_PATH="$manifest_path" node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(process.env.MANIFEST_PATH, "utf8"));
if (typeof manifest.key !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.key)) {
  throw new Error("extension/manifest.json must contain a base64-encoded development public key");
}
const publicKey = Buffer.from(manifest.key, "base64");
if (publicKey.length === 0) {
  throw new Error("extension/manifest.json contains an empty development public key");
}
const extensionId = createHash("sha256")
  .update(publicKey)
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16)));
console.log(extensionId);
NODE
)"

echo "CDT Bridge development extension ID: $extension_id"

if [[ "$dry_run" == true ]]; then
  echo "Dry run: native host was not registered."
  exit 0
fi

if [[ ! -x "$register_script" ]]; then
  echo "Native-host registration script is missing or not executable: $register_script" >&2
  exit 1
fi

"$register_script" --extension-id "$extension_id" --browser "$browser"

if [[ ! -e "$reload_config_path" ]]; then
  RELOAD_CONFIG_PATH="$reload_config_path" node --input-type=module <<'NODE'
import { writeFile } from "node:fs/promises";

await writeFile(
  process.env.RELOAD_CONFIG_PATH,
  `${JSON.stringify({ port: 9230, requireToken: false }, null, 2)}\n`,
  { mode: 0o600, flag: "wx" }
);
NODE
  echo "Created local unauthenticated development reload configuration: $reload_config_path"
else
  echo "Using existing local development reload configuration: $reload_config_path"
fi

cat <<EOF

Native host registration is complete. Load (or reload) this directory as an
unpacked extension in the selected browser:
  $repo_root/extension
EOF
