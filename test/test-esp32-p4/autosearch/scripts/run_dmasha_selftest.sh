#!/usr/bin/env bash
# Phase 2.DM — run the DMA-mode SHA-256 self-test.
set -u
ROM=/mnt/c/Desarrollo/velxio/third-party/esp-rom-elfs/esp32p4_rev0_rom.elf
FW=/mnt/c/Desarrollo/velxio/test/test-esp32-p4/sketches/blink/build/esp32.esp32.esp32p4/blink.ino.merged.bin
QEMU="$HOME/qemu-p4-build/qemu-system-riscv32"
export VELXIO_GPIO_LOG=/tmp/dmasha_events.jsonl
rm -f /tmp/dmasha_events.jsonl /tmp/dmasha_stderr.txt

timeout 5 "$QEMU" -M esp32p4 -bios "$ROM" \
  -drive file="$FW",if=mtd,format=raw -nographic \
  >/tmp/dmasha_stdout.txt 2>/tmp/dmasha_stderr.txt

echo "=== DMA-SHA self-test ==="
grep -iE "DMA-SHA|sha\].*DMA" /tmp/dmasha_stderr.txt | head
echo "=== SHA op around DMA (digest prefix) ==="
grep -iE "esp32p4.sha\] op#.*mode=2.*START" /tmp/dmasha_stderr.txt | tail -3
echo "=== regression (AXI-DMA + AHB-DMA still pass) ==="
grep -iE "esp32p4.(axi_dma|ahb_dma)\] self-test A" /tmp/dmasha_stderr.txt | head -2
