#!/usr/bin/env bash
# Run QEMU with monitor enabled, dump memory at 0x4FF65000 via -dump-vmstate trick
cd /root
/root/qemu-p4-build/qemu-system-riscv32 \
  -M esp32p4 \
  -kernel /root/blink.elf \
  -drive file=/root/blink.merged.bin,if=mtd,format=raw \
  -nographic \
  -monitor unix:/tmp/qmon.sock,server,nowait > /root/qdump.log 2>&1 &
QPID=$!
sleep 2

# Use socat to send monitor commands
echo "xp /16wx 0x4FF65000" | socat - UNIX-CONNECT:/tmp/qmon.sock 2>&1 | head -25
echo "---"
echo "xp /4wx 0x4FF06FF6" | socat - UNIX-CONNECT:/tmp/qmon.sock 2>&1 | head -10

kill -15 $QPID 2>/dev/null
wait 2>/dev/null
