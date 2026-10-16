#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME:?HOME is not set}/.pi/agent}"
case "$AGENT_DIR" in
  "~/"*) AGENT_DIR="$HOME/${AGENT_DIR#~/}" ;;
esac
DEST="$AGENT_DIR/extensions/background-compaction"
SETTINGS="$AGENT_DIR/settings.json"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$AGENT_DIR/backups/background-compaction/$STAMP"
MODE="${1:-install}"

if [[ "$MODE" != "install" && "$MODE" != "--uninstall" ]]; then
  echo "Usage: $0 [--uninstall]" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR" "$AGENT_DIR/extensions"
if [[ -f "$SETTINGS" ]]; then
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
const isBackground = (value) => typeof value === "string" && /(?:^|\/)background-compaction\/extension\.mjs$/.test(value);
if (operation === "install") {
  settings.extensions = settings.extensions.filter((value) => !isBackground(value));
  settings.extensions.push(extension);
} else {
  settings.extensions = settings.extensions.filter((value) => !isBackground(value));
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
    mv "$DEST" "$BACKUP_DIR/installed-background-compaction"
  fi
  printf 'Uninstalled background-compaction. Backup: %s\n' "$BACKUP_DIR"
  exit 0
fi

SOURCE_DIR="$SCRIPT_DIR/src"
for file in extension.mjs background-runtime.mjs background-state.mjs rolling-plan.mjs; do
  [[ -f "$SOURCE_DIR/$file" ]] || { echo "Missing source file: $SOURCE_DIR/$file" >&2; exit 1; }
done
STAGE="$AGENT_DIR/extensions/.background-compaction.install-$$"
rm -rf "$STAGE"
mkdir -m 755 "$STAGE"
for file in extension.mjs background-runtime.mjs background-state.mjs rolling-plan.mjs; do
  cp "$SOURCE_DIR/$file" "$STAGE/$file"
done
cp "$SCRIPT_DIR/README.md" "$STAGE/README.md"
chmod 644 "$STAGE"/*

PREVIOUS="$BACKUP_DIR/previous-background-compaction"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  mv "$DEST" "$PREVIOUS"
fi
mv "$STAGE" "$DEST"
if ! update_settings install "$DEST/extension.mjs"; then
  rm -rf "$DEST"
  if [[ -e "$PREVIOUS" || -L "$PREVIOUS" ]]; then mv "$PREVIOUS" "$DEST"; fi
  exit 1
fi
printf 'Installed background-compaction to %s\nSettings: %s\nBackup: %s\n' "$DEST" "$SETTINGS" "$BACKUP_DIR"
