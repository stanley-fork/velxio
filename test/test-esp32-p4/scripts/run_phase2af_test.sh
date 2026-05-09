#!/usr/bin/env bash
# Phase 2.AF live test — runs the demo blob and reports per-channel event counts.
set -u

QEMU=${QEMU_BIN:-$HOME/qemu-p4-build/qemu-system-riscv32}
KERNEL=${KERNEL_ELF:-/mnt/c/Desarrollo/velxio/test/test-esp32-p4/sketches/blink/build/esp32.esp32.esp32p4/blink.ino.elf}
LOG=/tmp/velxio-gpio.jsonl
DURATION=${DURATION:-10}

rm -f "$LOG"
echo "[+] Running QEMU for ${DURATION}s with kernel: $KERNEL"
VELXIO_GPIO_LOG="$LOG" timeout "$DURATION" "$QEMU" \
    -M esp32p4 -nographic -monitor none -kernel "$KERNEL" 2>&1 | tail -8
echo
echo "=== JSON event totals ==="
echo "Total lines: $(wc -l <"$LOG")"
for k in '"event":"ledc"' '"event":"adc"' '"event":"start"' '"ch":0' '"ch":1' '"ch":2' '"pin"'; do
    printf "  %-22s %d\n" "$k:" "$(grep -c -F -- "$k" "$LOG")"
done
echo
echo "=== Sample LEDC events (first 6) ==="
grep -F '"event":"ledc"' "$LOG" | head -6
echo
echo "=== Sample CH0+CH1+CH2 trio (first match where all three appear) ==="
awk '/"event":"ledc"/ && /"ch":0/ {ch0=$0; getline a; getline b; print ch0; print a; print b; exit}' "$LOG"
