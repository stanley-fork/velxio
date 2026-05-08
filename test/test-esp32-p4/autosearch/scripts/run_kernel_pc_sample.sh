#!/usr/bin/env bash
# Phase 2.T — sample the PC from QEMU monitor every 200ms while the app
# runs with the Phase 2.N/2.O bypass patches dropped. The goal is to
# identify the stuck loop after Phase 2.S (CLIC) unblocked the IRQ path.
cd /root
rm -f /tmp/qmon.in /tmp/qmon.out /tmp/qkrn_long.log
mkfifo /tmp/qmon.in
/root/qemu-p4-build/qemu-system-riscv32 \
  -M esp32p4 \
  -kernel /root/blink.elf \
  -drive file=/root/blink.merged.bin,if=mtd,format=raw \
  -nographic \
  -monitor unix:/tmp/qmon.sock,server,nowait \
  -d unimp,guest_errors -D /root/qkrn_unimp.log \
  > /tmp/qkrn_long.log 2>&1 &
QPID=$!
sleep 4
# Sample CPU state
for i in 1 2 3 4 5; do
  echo "info registers" | socat - UNIX-CONNECT:/tmp/qmon.sock 2>/dev/null \
    | grep -E "(pc=|x[0-9])" | head -3
  echo "--- sample $i ---"
  sleep 1
done
kill -15 $QPID 2>/dev/null
wait 2>/dev/null
echo "=== STDOUT ==="
tail -30 /tmp/qkrn_long.log
echo "=== UNIMP/GUEST_ERRORS (last 80) ==="
tail -80 /root/qkrn_unimp.log 2>/dev/null
