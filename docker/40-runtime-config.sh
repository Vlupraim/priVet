#!/bin/sh
set -eu

TEMPLATE_PATH="/usr/share/nginx/html/assets/js/runtime-config.template.js"
TARGET_PATH="/usr/share/nginx/html/assets/js/runtime-config.js"

: "${API_BASE_URL:=https://whisper-skynet.bourbaki-lab.duckdns.org}"
export API_BASE_URL

if [ -f "$TEMPLATE_PATH" ]; then
  envsubst '${API_BASE_URL}' < "$TEMPLATE_PATH" > "$TARGET_PATH"
fi
