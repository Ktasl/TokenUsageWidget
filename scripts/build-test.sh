#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Local ad-hoc signing only; do not use release credentials or notarization.
export APPLE_SIGNING_IDENTITY=-
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# The config itself supplies the matching frontend edition during beforeBuildCommand.
# Never creates updater archives or installs/launches the resulting App.
bun run tauri build --debug --bundles app --config src-tauri/tauri.test.conf.json -- --locked
