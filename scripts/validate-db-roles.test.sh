#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validator="$script_dir/validate-db-roles.sh"

assert_fails() {
  if "$@" >/dev/null 2>&1; then
    printf 'expected command to fail: %s\n' "$*" >&2
    exit 1
  fi
}

POSTGRES_OWNER_USER=thesis_ledger POSTGRES_APP_USER=thesis_ledger_app "$validator" >/dev/null
assert_fails env -u POSTGRES_OWNER_USER POSTGRES_APP_USER=thesis_ledger_app "$validator"
assert_fails env -u POSTGRES_APP_USER POSTGRES_OWNER_USER=thesis_ledger "$validator"
assert_fails env POSTGRES_OWNER_USER= POSTGRES_APP_USER=thesis_ledger_app "$validator"
assert_fails env POSTGRES_OWNER_USER=thesis_ledger POSTGRES_APP_USER= "$validator"
assert_fails env POSTGRES_OWNER_USER=thesis_ledger POSTGRES_APP_USER=thesis_ledger "$validator"

printf 'Database role validation tests passed.\n'
