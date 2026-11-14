#!/bin/sh
exec node "$(dirname "$0")/infra.mjs" sync-code "$@"
