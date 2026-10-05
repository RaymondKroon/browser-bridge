#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/unregister-native-host.sh [--browser <chrome|chromium|edge|all>]
EOF
}

browser="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
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

case "${browser}" in
  chrome|chromium|edge|all)
    ;;
  *)
    echo "Unsupported browser: ${browser}. Expected chrome, chromium, edge, or all." >&2
    exit 1
    ;;
esac

unregister_manifest() {
  local manifest_dir="$1"
  local manifest_path="${manifest_dir}/com.browser_bridge.json"

  if [[ -f "${manifest_path}" ]]; then
    rm -f "${manifest_path}"
  fi

  echo "Unregistered ${manifest_path}"
}

if [[ "${browser}" == "chrome" || "${browser}" == "all" ]]; then
  unregister_manifest "${HOME}/.config/google-chrome/NativeMessagingHosts"
fi

if [[ "${browser}" == "chromium" || "${browser}" == "all" ]]; then
  unregister_manifest "${HOME}/.config/chromium/NativeMessagingHosts"
fi

if [[ "${browser}" == "edge" || "${browser}" == "all" ]]; then
  unregister_manifest "${HOME}/.config/microsoft-edge/NativeMessagingHosts"
fi
