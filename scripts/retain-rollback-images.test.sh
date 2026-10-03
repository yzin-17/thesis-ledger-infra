#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/retain-rollback-images.sh"

id_a="sha256:$(printf 'a%.0s' {1..64})"
id_b="sha256:$(printf 'b%.0s' {1..64})"
id_other="sha256:$(printf 'c%.0s' {1..64})"
compose_args=(compose_mock)
tag_dsa=""
tag_server=""
tag_worker=""
tag_calls=0
missing_service=""
fail_compose=false
bad_image=false
fail_tag=false
inspect_error=false
worker_image_id="$id_b"

compose_mock() {
  [[ "$1" == ps && "$2" == -q ]]
  if [[ "$fail_compose" == true ]]; then
    printf 'compose unavailable\n' >&2
    return 1
  fi
  if [[ "$3" != "$missing_service" ]]; then
    printf 'container-%s\n' "$3"
  fi
}

docker() {
  if [[ "$1" == inspect && "$2" == --format ]]; then
    [[ "$4" == container-* ]]
    if [[ "$bad_image" == true ]]; then
      printf 'invalid\n'
    elif [[ "$4" == container-dsa ]]; then
      printf '%s\n' "$id_a"
    elif [[ "$4" == container-backtest-worker ]]; then
      printf '%s\n' "$worker_image_id"
    else
      printf '%s\n' "$id_b"
    fi
    return
  fi
  if [[ "$1" == image && "$2" == inspect ]]; then
    if [[ "$inspect_error" == true ]]; then
      printf 'daemon unavailable\n' >&2
      return 1
    fi
    case "$5" in
      daily-stock-analysis:rollback-*) [[ -n "$tag_dsa" ]] || { printf 'Error: No such image: %s\n' "$5" >&2; return 1; }; printf '%s\n' "$tag_dsa" ;;
      thesis-ledger:rollback-*) if [[ "$5" == "thesis-ledger:rollback-${id_other#sha256:}" ]]; then
        [[ -n "$tag_worker" ]] || { printf 'Error: No such image: %s\n' "$5" >&2; return 1; }
        printf '%s\n' "$tag_worker"
      else
        [[ -n "$tag_server" ]] || { printf 'Error: No such image: %s\n' "$5" >&2; return 1; }
        printf '%s\n' "$tag_server"
      fi ;;
      *) return 1 ;;
    esac
    return
  fi
  if [[ "$1" == tag ]]; then
    [[ "$fail_tag" == false ]] || return 1
    case "$3" in
      daily-stock-analysis:rollback-*) tag_dsa="$2" ;;
      thesis-ledger:rollback-*) if [[ "$3" == "thesis-ledger:rollback-${id_other#sha256:}" ]]; then
        tag_worker="$2"
      else
        tag_server="$2"
      fi ;;
      *) return 1 ;;
    esac
    ((tag_calls += 1))
    return
  fi
  return 1
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

retain_rollback_images dsa thesis-ledger >/dev/null
[[ "$tag_dsa" == "$id_a" ]] || fail 'DSA image'
[[ "$tag_server" == "$id_b" ]] || fail 'Server image'
[[ "$tag_calls" == 2 ]] || fail 'two selected services'

retain_rollback_images dsa thesis-ledger >/dev/null
[[ "$tag_calls" == 2 ]] || fail 'idempotent retention'

tag_dsa="$id_other"
if retain_rollback_images dsa >/dev/null 2>&1; then fail 'conflicting tag accepted'; fi
[[ "$tag_calls" == 2 ]] || fail 'conflict changed a tag'
tag_dsa="$id_a"

missing_service=dsa
retain_rollback_images dsa >/dev/null
[[ "$tag_calls" == 2 ]] || fail 'missing service created a tag'
missing_service=""

fail_compose=true
if retain_rollback_images dsa >/dev/null 2>&1; then fail 'compose query failure accepted'; fi
[[ "$tag_calls" == 2 ]] || fail 'compose query failure changed a tag'
fail_compose=false

bad_image=true
if retain_rollback_images dsa >/dev/null 2>&1; then fail 'invalid image identity accepted'; fi
bad_image=false

inspect_error=true
if retain_rollback_images dsa >/dev/null 2>&1; then fail 'inspect failure accepted'; fi
inspect_error=false

tag_dsa=""
fail_tag=true
if retain_rollback_images dsa >/dev/null 2>&1; then fail 'tag failure accepted'; fi
[[ "$tag_calls" == 2 ]] || fail 'tag failure changed a tag'

fail_tag=false
worker_image_id="$id_other"
retain_rollback_images thesis-ledger >/dev/null
[[ "$tag_worker" == "$id_other" && "$tag_calls" == 3 ]] || fail 'distinct Worker image not retained'

printf 'retain-rollback-images: 9 scenarios passed\n'
