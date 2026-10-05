#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/register-native-host.sh --extension-id <extension-id> [--browser <chrome|chromium|edge|all>]
EOF
}

extension_id=""
browser="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      extension_id="${2:-}"
      shift 2
      ;;
    --browser)
      browser="${2:-}"
      shift 2
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

if [[ -z "${extension_id}" ]]; then
  echo "--extension-id is required." >&2
  usage >&2
  exit 1
fi

if [[ ! "${extension_id}" =~ ^[a-p]{32}$ ]]; then
  echo "Extension IDs should be 32 lowercase characters in the a-p range." >&2
  exit 1
fi

case "${browser}" in
  chrome|chromium|edge|all)
    ;;
  *)
    echo "Unsupported browser: ${browser}. Expected chrome, chromium, edge, or all." >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "node must be available on PATH." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
launcher_path="${repo_root}/native-host/launch-host.sh"

if [[ ! -x "${launcher_path}" ]]; then
  echo "Native host launcher is missing or not executable: ${launcher_path}" >&2
  exit 1
fi

manifest_json() {
  cat <<EOF
{
  "name": "com.browser_bridge",
  "description": "Browser Bridge Native Messaging Host",
  "path": "${launcher_path}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${extension_id}/"
  ]
}
EOF
}

register_manifest() {
  local manifest_dir="$1"
  local manifest_path="${manifest_dir}/com.browser_bridge.json"

  mkdir -p "${manifest_dir}"
  manifest_json > "${manifest_path}"
  chmod 644 "${manifest_path}"
  echo "Registered ${manifest_path}"
}

if [[ "${browser}" == "chrome" || "${browser}" == "all" ]]; then
  register_manifest "${HOME}/.config/google-chrome/NativeMessagingHosts"
fi

if [[ "${browser}" == "chromium" || "${browser}" == "all" ]]; then
  register_manifest "${HOME}/.config/chromium/NativeMessagingHosts"
fi

if [[ "${browser}" == "edge" || "${browser}" == "all" ]]; then
  register_manifest "${HOME}/.config/microsoft-edge/NativeMessagingHosts"
fi
