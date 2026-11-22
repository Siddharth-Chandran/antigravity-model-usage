#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="model-usage"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_ROOT="${HOME}/.gemini/config/plugins"
TARGET_DIR="${TARGET_ROOT}/${PLUGIN_NAME}"
MODE="${1:---copy}"

mkdir -p "${TARGET_ROOT}"

if [[ "${MODE}" == "--symlink" ]]; then
  rm -rf "${TARGET_DIR}"
  ln -s "${SRC_DIR}" "${TARGET_DIR}"
  echo "Installed ${PLUGIN_NAME} (symlinked) -> ${TARGET_DIR}"
else
  if [[ -L "${TARGET_DIR}" ]]; then
    rm -f "${TARGET_DIR}"
  fi
  mkdir -p "${TARGET_DIR}"
  cp -Rf "${SRC_DIR}/plugin.json" \
         "${SRC_DIR}/README.md" \
         "${SRC_DIR}/assets" \
         "${SRC_DIR}/skills" \
         "${SRC_DIR}/sidecars" \
         "${TARGET_DIR}/"
  echo "Installed ${PLUGIN_NAME} to ${TARGET_DIR}"
fi
