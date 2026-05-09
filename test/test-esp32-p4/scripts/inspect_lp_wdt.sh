#!/usr/bin/env bash
LOG=${LOG:-/tmp/velxio-gpio.jsonl}
echo "=== rtc_wdt + super_wdt events ==="
grep -E '"rtc_wdt"|"super_wdt"' "$LOG"
echo
echo "=== all event types ==="
grep -oE '"event":"[a-z_]+"' "$LOG" | sort | uniq -c
echo
echo "=== total ==="
wc -l < "$LOG"
