#!/usr/bin/env bash
# Phase 2.T — capture the trail of executed TBs (last few thousand) to
# identify the busy loop the app is stuck on after dropping the
# Phase 2.N/2.O bypass. Filter to in_asm only and grab the last 200 PCs.
cd /root
rm -f /root/qkrn_in_asm.log /root/qkrn_long.log
/root/qemu-p4-build/qemu-system-riscv32 \
  -M esp32p4 \
  -kernel /root/blink.elf \
  -drive file=/root/blink.merged.bin,if=mtd,format=raw \
  -nographic \
  -d in_asm -D /root/qkrn_in_asm.log \
  > /root/qkrn_long.log 2>&1 &
QPID=$!
sleep 6
kill -15 $QPID 2>/dev/null
wait 2>/dev/null
echo "=== STDOUT (tail) ==="
tail -10 /root/qkrn_long.log
echo "=== Last 200 PCs ==="
grep -oE '0x[0-9a-fA-F]+' /root/qkrn_in_asm.log | tail -200 | sort -u | tail -40
echo "=== Most-frequent PCs in last 5K lines ==="
tail -5000 /root/qkrn_in_asm.log | grep -oE '^0x[0-9a-fA-F]+' | sort | uniq -c | sort -rn | head -10
