#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME:?HOME is not set}/.pi/agent}"
case "$AGENT_DIR" in
  "~/"*) AGENT_DIR="$HOME/${AGENT_DIR#~/}" ;;
esac
DEST="$AGENT_DIR/extensions/dashboard"
LEGACY="$AGENT_DIR/extensions/dashboard.js"
SETTINGS="$AGENT_DIR/settings.json"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="$AGENT_DIR/backups/dashboard/$STAMP"
MODE="${1:-install}"

if [[ "$MODE" != "install" && "$MODE" != "--uninstall" ]]; then
  echo "Usage: $0 [--uninstall]" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR" "$AGENT_DIR/extensions"
SETTINGS_EXISTED=0
if [[ -f "$SETTINGS" ]]; then
  SETTINGS_EXISTED=1
  cp -p "$SETTINGS" "$BACKUP_DIR/settings.json"
fi

update_settings() {
  local operation="$1"
  local extension_path="$2"
  SETTINGS_PATH="$SETTINGS" EXTENSION_PATH="$extension_path" OPERATION="$operation" node --input-type=module <<'NODE'
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
const path = process.env.SETTINGS_PATH;
const extension = process.env.EXTENSION_PATH;
const operation = process.env.OPERATION;
const original = existsSync(path) ? readFileSync(path, "utf8") : "{\n  \"extensions\": []\n}\n";
const settings = JSON.parse(original);
settings.extensions ??= [];
const isDashboard = (value) => typeof value === "string" && /(?:^|\/)extensions\/dashboard(?:\/extension\.mjs|\.js)$/.test(value);
if (operation === "install") {
  settings.extensions = settings.extensions.filter((value) => !isDashboard(value));
  settings.extensions.push(extension);
} else {
  settings.extensions = settings.extensions.filter((value) => !isDashboard(value));
}
const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
const temp = `${path}.tmp-${process.pid}`;
writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
chmodSync(temp, mode);
renameSync(temp, path);
NODE
}

if [[ "$MODE" == "--uninstall" ]]; then
  update_settings uninstall "$DEST/extension.mjs"
  if [[ -e "$DEST" || -L "$DEST" ]]; then
    mv "$DEST" "$BACKUP_DIR/installed-dashboard"
  fi
  printf 'Uninstalled dashboard. Backup: %s\n' "$BACKUP_DIR"
  exit 0
fi

SOURCE_DIR="$SCRIPT_DIR/src"
for file in extension.mjs session-stats.mjs history-store.mjs stats-tabs.mjs; do
  [[ -f "$SOURCE_DIR/$file" ]] || { echo "Missing source file: $SOURCE_DIR/$file" >&2; exit 1; }
done
[[ -f "$SCRIPT_DIR/README.md" ]] || { echo "Missing README: $SCRIPT_DIR/README.md" >&2; exit 1; }
STAGE="$AGENT_DIR/extensions/.dashboard.install-$$"
trap 'rm -rf "$STAGE"' EXIT
rm -rf "$STAGE"
mkdir -m 755 "$STAGE"
for file in extension.mjs session-stats.mjs history-store.mjs stats-tabs.mjs; do
  cp "$SOURCE_DIR/$file" "$STAGE/$file"
done
cp "$SCRIPT_DIR/README.md" "$STAGE/README.md"
chmod 644 "$STAGE"/*

PREVIOUS="$BACKUP_DIR/previous-dashboard"
LEGACY_BACKUP="$BACKUP_DIR/legacy-dashboard.js"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  mv "$DEST" "$PREVIOUS"
fi
if [[ -e "$LEGACY" || -L "$LEGACY" ]]; then
  mv "$LEGACY" "$LEGACY_BACKUP"
fi
mv "$STAGE" "$DEST"
if ! update_settings install "$DEST/extension.mjs"; then
  rm -rf "$DEST"
  if [[ -e "$PREVIOUS" || -L "$PREVIOUS" ]]; then mv "$PREVIOUS" "$DEST"; fi
  if [[ -e "$LEGACY_BACKUP" || -L "$LEGACY_BACKUP" ]]; then mv "$LEGACY_BACKUP" "$LEGACY"; fi
  if [[ "$SETTINGS_EXISTED" == "1" ]]; then
    cp -p "$BACKUP_DIR/settings.json" "$SETTINGS"
  else
    rm -f "$SETTINGS"
  fi
  exit 1
fi
printf 'Installed dashboard to %s\nSettings: %s\nBackup: %s\n' "$DEST" "$SETTINGS" "$BACKUP_DIR"
