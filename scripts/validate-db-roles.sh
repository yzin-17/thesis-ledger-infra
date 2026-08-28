#!/usr/bin/env sh
set -eu

if [ -z "${POSTGRES_OWNER_USER:-}" ]; then
  printf 'POSTGRES_OWNER_USER is required and must not be empty.\n' >&2
  exit 1
fi

if [ -z "${POSTGRES_APP_USER:-}" ]; then
  printf 'POSTGRES_APP_USER is required and must not be empty.\n' >&2
  exit 1
fi

if [ "$POSTGRES_OWNER_USER" = "$POSTGRES_APP_USER" ]; then
  printf 'POSTGRES_APP_USER must differ from POSTGRES_OWNER_USER.\n' >&2
  exit 1
fi

printf 'Database owner and application roles are valid and distinct.\n'
