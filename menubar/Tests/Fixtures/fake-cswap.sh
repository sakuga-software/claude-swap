#!/bin/sh
# A fake `cswap` for tests and manual runs of the menu bar. It prints canned
# output in the documented `--json` shapes and never touches a real account.
#
# Environment:
#   FAKE_CSWAP_LOG   if set, each call appends its arguments (and stdin) to this file.
#   FAKE_CSWAP_FAIL  if set to a subcommand name, that subcommand fails.
#   FAKE_CSWAP_AUTO_PERIOD  seconds between two `auto --json` events (default 3).
#
# Usage: CSWAP_BIN=/path/to/fake-cswap.sh .build/debug/CswapMenuBar

set -u

if [ -n "${FAKE_CSWAP_LOG:-}" ]; then
    printf '%s\n' "$*" >>"$FAKE_CSWAP_LOG"
fi

in_hours() { date -u -v+"$1"H +%Y-%m-%dT%H:%M:%S+00:00; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

fail_json() {
    printf '{\n  "schemaVersion": 1,\n  "error": {"type": "AccountNotFoundError", "message": "%s"}\n}\n' "$1"
    exit 1
}

fail_text() {
    printf 'Error: %s\n' "$1" >&2
    exit 1
}

cmd="${1:-}"
[ $# -gt 0 ] && shift

if [ "${FAKE_CSWAP_FAIL:-}" = "$cmd" ]; then
    case "$*" in
        *--json*) fail_json "fake failure of $cmd" ;;
        *) fail_text "fake failure of $cmd" ;;
    esac
fi

case "$cmd" in
list)
    cat <<EOF
{
  "schemaVersion": 1,
  "activeAccountNumber": 1,
  "accounts": [
    {
      "number": 1,
      "email": "alice@example.com",
      "organizationName": "",
      "organizationUuid": "",
      "isOrganization": false,
      "active": true,
      "usageStatus": "ok",
      "usage": {
        "fiveHour": {"pct": 42.0, "resetsAt": "$(in_hours 2)", "countdown": "2h 0m", "clock": "14:00"},
        "sevenDay": {"pct": 18.0, "resetsAt": "$(in_hours 43)", "countdown": "1d 19h", "clock": "Jul 3 09:00", "expectedPct": 74.4, "aheadOfPace": false},
        "spend": {"used": 3.0, "limit": 10.0, "pct": 30.0, "currency": "USD"},
        "scoped": [{"pct": 55.0, "resetsAt": "$(in_hours 43)", "name": "Fable"}]
      },
      "usageFetchedAt": "$(now_iso)",
      "usageAgeSeconds": 12.0,
      "alias": "work"
    },
    {
      "number": 2,
      "email": "bob@example.com",
      "organizationName": "Acme",
      "organizationUuid": "00000000-0000-0000-0000-000000000000",
      "isOrganization": true,
      "active": false,
      "usageStatus": "token_expired",
      "usage": null,
      "lastGoodUsage": {"fiveHour": {"pct": 90.0}, "sevenDay": {"pct": 60.0}},
      "lastGoodFetchedAt": "$(now_iso)",
      "lastGoodAgeSeconds": 600.0,
      "disabled": true
    },
    {
      "number": 3,
      "email": "carol@example.com",
      "organizationName": "",
      "organizationUuid": "",
      "isOrganization": false,
      "active": false,
      "usageStatus": "unavailable",
      "usage": null,
      "usageError": "http-429",
      "someFutureField": {"nested": true}
    }
  ]
}
EOF
    ;;
status)
    cat <<EOF
{
  "schemaVersion": 1,
  "active": {"number": 1, "email": "alice@example.com", "organizationName": "", "organizationUuid": "", "isOrganization": false, "managed": true, "usageStatus": "ok", "usage": null},
  "totalManagedAccounts": 3
}
EOF
    ;;
switch)
    target="${1:-}"
    case "$target" in
        ""|-*) to=3 ;;
        *) to="$target" ;;
    esac
    case "$*" in
        *--strategy*) strategy=$(printf '%s' "$*" | sed -E 's/.*--strategy ([a-z-]+).*/\1/') ;;
        *) strategy="rotate" ;;
    esac
    [ "$target" != "" ] && [ "${target#-}" = "$target" ] && strategy="direct"
    cat <<EOF
{
  "schemaVersion": 1,
  "switched": true,
  "from": {"number": 1, "email": "alice@example.com"},
  "to": {"number": $to, "email": "account$to@example.com"},
  "strategy": "$strategy",
  "reason": "switched",
  "message": "Switched to Account-$to (account$to@example.com)",
  "warnings": []
}
EOF
    ;;
disable|enable)
    printf '%sd Account-%s\n' "$cmd" "${1:-?}"
    ;;
remove|rm)
    printf 'Are you sure you want to permanently remove Account-%s? [y/N] ' "${1:-?}"
    read -r answer || answer=""
    [ -n "${FAKE_CSWAP_LOG:-}" ] && printf 'stdin: %s\n' "$answer" >>"$FAKE_CSWAP_LOG"
    if [ "$answer" = "y" ]; then
        printf 'Removed Account-%s\n' "${1:-?}"
    else
        printf 'Cancelled\n'
    fi
    ;;
add)
    printf 'Added Account-4\n'
    ;;
add-token)
    read -r token || token=""
    [ -n "${FAKE_CSWAP_LOG:-}" ] && printf 'stdin-token-length: %s\n' "${#token}" >>"$FAKE_CSWAP_LOG"
    [ -z "$token" ] && fail_text "Token cannot be empty"
    printf 'Added Account-5\n'
    ;;
config)
    case "${1:-}" in
        get) printf '{\n  "schemaVersion": 1,\n  "key": "%s",\n  "value": 90.0,\n  "isSet": false\n}\n' "${2:-}" ;;
        set) printf '%s = %s\n' "${2:-}" "${3:-}" ;;
        path) printf '%s/.claude-swap-backup/settings.json\n' "$HOME" ;;
        *) fail_text "unsupported fake config action" ;;
    esac
    ;;
auto)
    period="${FAKE_CSWAP_AUTO_PERIOD:-3}"
    trap 'exit 0' TERM INT
    printf '{"schemaVersion": 1, "event": "poll", "ts": "%s", "active": {"number": 1, "email": "alice@example.com"}, "headroomPct": {"1": 58.0, "3": 90.0}, "threshold": 90.0}\n' "$(now_iso)"
    sleep "$period" & wait $!
    printf '{"schemaVersion": 1, "event": "switch", "ts": "%s", "trigger": "proactive", "from": {"number": 1, "email": "alice@example.com"}, "to": {"number": 3, "email": "carol@example.com"}, "warnings": [], "dryRun": false}\n' "$(now_iso)"
    while :; do
        sleep "$period" & wait $!
        printf '{"schemaVersion": 1, "event": "sleep", "ts": "%s", "seconds": %s, "until": "%s"}\n' "$(now_iso)" "$period" "$(now_iso)"
    done
    ;;
*)
    fail_text "fake cswap: unknown command '$cmd'"
    ;;
esac
