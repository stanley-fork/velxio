# ESP32-P4 QEMU build environment — gotchas and recovery recipes

This file documents the build-infra issues that bit Phase 2.AF and how to
recover. Future Claude sessions: read this before retrying a build.

## Symptom 1 — `ui/meson.build:172: Subproject exists but has no meson.build file.`

### Lo que NO funcionó

- Running `wsl_build_p4.sh` directly with a clean `$BUILD_DIR`. Meson tries
  to use `subprojects/keycodemapdb/` and finds the directory exists but is
  empty (cloned via Windows where git submodules weren't recursively
  initialised).
- `meson subprojects download keycodemapdb` reports "Already downloaded"
  but nothing actually appears in the directory.

### Lo que SE INVESTIGÓ

- `subprojects/keycodemapdb/` exists as an empty directory on disk.
- `subprojects/keycodemapdb.wrap` defines a `[wrap-git]` source with
  `url = https://gitlab.com/qemu-project/keycodemapdb.git`.
- The wrap mechanism didn't actually clone because the directory existed
  (meson treats existing dir as "already done").

### Lo que SÍ funcionó

```bash
cd /mnt/c/Desarrollo/velxio/third-party/qemu-lcgamboa/subprojects
rm -rf keycodemapdb
git clone --depth=1 https://gitlab.com/qemu-project/keycodemapdb.git keycodemapdb
```

After this the meson configure step proceeds.

## Symptom 2 — `fatal error: standard-headers/linux/virtio_config.h: No such file or directory`

Hits during compilation of `subprojects/libvhost-user/libvhost-user.c.o`
and `subprojects/libvduse/libvduse.c.o`.

### Lo que SE INVESTIGÓ

The QEMU subprojects `libvhost-user/` and `libvduse/` use **symbolic
links** into the parent QEMU tree to share headers. On a Linux clone
those are real symlinks. **On a Windows checkout (NTFS without
Developer Mode + git core.symlinks=true)** they end up as 30-byte
text files containing the link target as text, e.g.:

```
$ cat subprojects/libvhost-user/include/atomic.h
../../../include/qemu/atomic.h
```

GCC follows the path `subprojects/libvhost-user/standard-headers/linux/virtio_config.h`
and finds nothing because the parent dir is a *file* (containing
`../../../include/standard-headers/linux`), not a directory.

Affected paths (7 total):
- `subprojects/libvhost-user/include/atomic.h`     (file → file)
- `subprojects/libvhost-user/include/compiler.h`   (file → file)
- `subprojects/libvduse/include/atomic.h`          (file → file)
- `subprojects/libvduse/include/compiler.h`        (file → file)
- `subprojects/libvhost-user/standard-headers/linux` (file → dir)
- `subprojects/libvduse/linux-headers/linux`         (file → dir)
- `subprojects/libvduse/standard-headers/linux`      (file → dir)

### Lo que SÍ funcionó

Replace the broken text-as-symlink files with real copies:

```bash
QR=/mnt/c/Desarrollo/velxio/third-party/qemu-lcgamboa
SUB=$QR/subprojects

rm "$SUB/libvhost-user/include/atomic.h" "$SUB/libvhost-user/include/compiler.h" \
   "$SUB/libvduse/include/atomic.h" "$SUB/libvduse/include/compiler.h" \
   "$SUB/libvhost-user/standard-headers/linux" \
   "$SUB/libvduse/linux-headers/linux" \
   "$SUB/libvduse/standard-headers/linux"

cp "$QR/include/qemu/atomic.h"    "$SUB/libvhost-user/include/atomic.h"
cp "$QR/include/qemu/compiler.h"  "$SUB/libvhost-user/include/compiler.h"
cp "$QR/include/qemu/atomic.h"    "$SUB/libvduse/include/atomic.h"
cp "$QR/include/qemu/compiler.h"  "$SUB/libvduse/include/compiler.h"

mkdir -p "$SUB/libvhost-user/standard-headers/linux" \
         "$SUB/libvduse/linux-headers/linux" \
         "$SUB/libvduse/standard-headers/linux"

cp -r "$QR/include/standard-headers/linux/." "$SUB/libvhost-user/standard-headers/linux/"
cp -r "$QR/linux-headers/linux/."             "$SUB/libvduse/linux-headers/linux/"
cp -r "$QR/include/standard-headers/linux/." "$SUB/libvduse/standard-headers/linux/"
```

## Symptom 3 — `FileNotFoundError: scripts/hxtool` (during meson compile)

Despite the script existing on disk with executable perms.

### Lo que SE INVESTIGÓ

```bash
$ file /mnt/c/.../scripts/hxtool
POSIX shell script, ASCII text executable, with CRLF line terminators
```

Windows-side editing or `core.autocrlf=true` converted Unix line endings
to Windows. The kernel reads `#!/bin/sh\r` from the shebang and tries
to execute `/bin/sh\r` (literal CR character in the path) — fails with
ENOENT, surfacing as `FileNotFoundError`.

### Lo que SÍ funcionó

```bash
cd /mnt/c/Desarrollo/velxio/third-party/qemu-lcgamboa
find scripts -type f | xargs file 2>/dev/null | grep CRLF | cut -d: -f1 | xargs dos2unix
```

Repeat for any script created/edited from Windows. The internal
`scripts/qemu-version.sh`, `scripts/minikconf.py`, `scripts/hxtool`,
`scripts/shaderinclude.py`, `scripts/qapi-gen.py`,
`scripts/symlink-install-tree.py`, `scripts/make-config-poison.sh` are
the ones meson invokes during configure/build.

Apply the same to any test scripts created via the `Write` tool —
PowerShell tends to add CRLF + BOM. After every `Write`, run
`dos2unix` from inside WSL.

## Symptom 4 — `/tmp/qemu-p4-build/` disappears between commands (same WSL session)

The build script's smoke test passes, but a subsequent `wsl -d
Ubuntu-24.04 ...` invocation reports `qemu-system-riscv32: No such
file or directory` even though `uptime` shows the WSL VM did NOT
restart.

### Lo que SE INVESTIGÓ

`systemd-tmpfiles` aggressively cleans `/tmp` even mid-session.
`ls /tmp/` shows only `systemd-private-*` directories — anything user-
created is gone.

### Lo que SÍ funcionó

Build to `$HOME/qemu-p4-build` instead of `/tmp/qemu-p4-build`. Already
applied as `BUILD_DIR=${BUILD_DIR:-$HOME/qemu-p4-build}` in
`test/test-esp32-p4/scripts/wsl_build_p4.sh`.

The home directory persists across `wsl` invocations and isn't subject
to tmpfiles cleaning.

## Symptom 5 — Live test produces only fake-button events (no LEDC/ADC/running-light)

Console shows `[esp32p4.gpio] pin 0 -> 1` every 3 s but no other events.
JSON log has 4 lines (start marker + 3 button transitions).

### Lo que SE INVESTIGÓ

`-d guest_errors,unimp -D /tmp/qemu-trace.log` reveals:
```
Invalid read at addr 0x0, size 2, region '(null)', reason: rejected
Invalid read at addr 0x0, size 2, region '(null)', reason: rejected
... (repeated)
```

The CPU is fetching instructions at `0x0` because **no firmware is
loaded**. The runtime patches that install the demo blob at
`0x40400100` did execute, but the CPU never reaches that address — it
faults on the first instruction fetch from PC=0.

### Lo que SÍ funcionó

The QEMU machine needs a kernel/bios image to boot:

```bash
$HOME/qemu-p4-build/qemu-system-riscv32 \
    -M esp32p4 -nographic -monitor none \
    -kernel /mnt/c/Desarrollo/velxio/test/test-esp32-p4/sketches/blink/build/esp32.esp32.esp32p4/blink.ino.elf
```

The IDF `blink.ino.elf` provides the ROM/IDF flow that the bypass
patches divert to the demo blob. Without it, the runtime patches have
nothing to redirect.

The `wsl_build_p4.sh` smoke test runs *without* `-kernel` — it only
verifies the machine model registers correctly and the runtime patches
install. Real-test verification requires `-kernel blink.ino.elf`.

## Recovery checklist (after fresh WSL session or `/tmp` wipe)

1. Verify subprojects are real:
   ```bash
   ls subprojects/keycodemapdb/meson.build       # must exist
   file subprojects/libvhost-user/include/atomic.h | grep -v "ASCII"  # must NOT be 30-byte text
   ```
   If broken: re-apply Symptom 1 + Symptom 2 fixes.

2. Verify scripts are LF:
   ```bash
   file scripts/hxtool | grep CRLF && dos2unix scripts/hxtool
   ```

3. Build to `$HOME` not `/tmp`:
   ```bash
   bash test/test-esp32-p4/scripts/wsl_build_p4.sh
   ```

4. Test with firmware:
   ```bash
   bash test/test-esp32-p4/scripts/run_phase2af_test.sh
   ```
