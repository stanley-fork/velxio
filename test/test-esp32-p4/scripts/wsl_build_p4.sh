#!/usr/bin/env bash
# Build the qemu-lcgamboa fork with the ESP32-P4 skeleton inside WSL Ubuntu 24.04.
# Run from Windows: wsl -d Ubuntu-24.04 -- bash /mnt/c/Desarrollo/velxio/test/test-esp32-p4/scripts/wsl_build_p4.sh
#
# Or directly inside WSL: bash wsl_build_p4.sh
#
# This script expects sudo access (the apt install step is unavoidable).
set -euo pipefail

REPO=/mnt/c/Desarrollo/velxio/third-party/qemu-lcgamboa
BUILD_DIR=${BUILD_DIR:-$HOME/qemu-p4-build}  # was /tmp — cleaned by tmpfiles between runs

if ! command -v gcc >/dev/null || ! command -v meson >/dev/null || ! command -v ninja >/dev/null; then
    echo "[+] Installing build dependencies (sudo required)..."
    sudo apt-get update -y -qq
    sudo apt-get install -y -qq \
        build-essential ninja-build meson pkg-config \
        libglib2.0-dev libpixman-1-dev libslirp-dev libgcrypt20-dev \
        libsdl2-dev libgtk-3-dev libusb-1.0-0-dev \
        python3-venv python3-pip python3-distlib
fi

echo "[+] Source: $REPO"
echo "[+] Build:  $BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$REPO"

if [ ! -f "$BUILD_DIR/build.ninja" ]; then
    echo "[+] Configuring (riscv32-softmmu only, debug)..."
    cd "$BUILD_DIR"
    "$REPO/configure" \
        --target-list=riscv32-softmmu \
        --enable-debug \
        --disable-werror \
        --disable-docs --disable-gtk --disable-vnc --disable-sdl \
        --disable-tools --disable-guest-agent
fi

cd "$BUILD_DIR"
echo "[+] Building qemu-system-riscv32 (this is the slow step, ~10–30 min on first build)..."
ninja qemu-system-riscv32

echo
echo "[+] Build OK. Listing the new machine:"
./qemu-system-riscv32 -M help | grep -iE "esp32|^Supported" || true
echo
echo "[+] Smoke test — invoke the machine without firmware (should print our log line):"
timeout 5 ./qemu-system-riscv32 -M esp32p4 -nographic -monitor none 2>&1 | head -20 || true
echo "[+] Done. Binary at: $BUILD_DIR/qemu-system-riscv32"
