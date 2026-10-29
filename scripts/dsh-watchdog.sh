#!/bin/sh
# DSH RC watchdog (macOS, run by launchd every 2 minutes and at login).
# Keeps the office Harness reachable from home: if DeepSeek Harness is not
# running, relaunch it. Never kills a running Harness, so it cannot interrupt
# a session. Touch ~/.dsh-rc/watchdog.off to pause it (e.g. you quit on purpose).
STATE="${DSHRC_HOME:-$HOME/.dsh-rc}"
LOG="$STATE/watchdog.log"
[ -e "$STATE/watchdog.off" ] && exit 0
if ! pgrep -f "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" >/dev/null 2>&1; then
  printf '%s relaunching DeepSeek Harness\n' "$(date -u +%FT%TZ)" >> "$LOG"
  open -a "DeepSeek Harness" >> "$LOG" 2>&1
fi
# Trim the log so it never grows unbounded.
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 200000 ] && tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
