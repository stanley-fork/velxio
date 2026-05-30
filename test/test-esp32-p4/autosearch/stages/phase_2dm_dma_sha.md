# Phase 2.DM — DMA-mode SHA-256 via AXI-DMA

**Estado:** ✅ DONE — the SHA peripheral now hashes messages pulled off the
AXI-DMA out-link (the real ESP32-P4 bulk-crypto path), verified with
`SHA-256("abc")` == FIPS 180-2 §B.1 through the full DMA flow. First
cross-peripheral (crypto ↔ DMA) integration in the model.

Files:
- `third-party/qemu-lcgamboa/hw/misc/esp32p4_sha.c` (+DMA-mode paths +
  self-test; typical mode untouched)
- `third-party/qemu-lcgamboa/include/hw/misc/esp32p4_sha.h` (+self-test decl)
- `third-party/qemu-lcgamboa/hw/riscv/esp32p4.c` (call SHA-DMA self-test
  after the SHA + AXI-DMA are both up)
- `test/test-esp32-p4/autosearch/scripts/run_dmasha_selftest.sh`

---

## SE INVESTIGÓ (what was researched)

This makes the AXI-DMA (2.DL) *useful*: bulk SHA in ESP-IDF/mbedtls goes
through DMA, not the CPU-fed M_MEM registers. The driver path is
`esp_sha_dma()` → `esp_sha_dma_start()` →
`esp_crypto_shared_gdma_start_axi_ahb(input, NULL, GDMA_TRIG_PERIPH_SHA)`.

IDF facts established:
- **SHA DMA registers** (`sha_reg.h`): `SHA_DMA_BLOCK_NUM`@0x0C (block
  count), `SHA_DMA_START`@0x1C (first block), `SHA_DMA_CONTINUE`@0x20
  (subsequent). `SHA_MODE`@0x00 selects the algorithm.
- **Binding**: `gdma_channel.h` → SHA0 = `SOC_GDMA_TRIG_PERIPH_SHA0` =
  peri_sel **5**, on the **AXI** bus. The driver `gdma_connect`s the TX
  (out) channel to SHA; SHA uses **only the TX channel** (message in;
  the digest is read from the SHA H registers, no RX writeback).
- **Block size**: 64 bytes for SHA-1/224/256, 128 bytes for the
  SHA-384/512 family. mbedtls software-pads the message into full
  blocks before starting the DMA, so the SHA block just consumes
  `SHA_DMA_BLOCK_NUM × block_size` bytes off the descriptor chain.
- The descriptor format is the shared `dma_descriptor_t` already handled
  by the AXI-DMA.

---

## SÍ funcionó (what worked)

- **Decoupled cross-peripheral read.** Rather than give the SHA a struct
  pointer to the AXI-DMA, the SHA reads the bound channel's
  `OUT_PERI_SEL` / `OUT_LINK2` (descriptor base) **through the address
  space** (`address_space_read` on the AXI-DMA MMIO at 0x5008A000), then
  walks the descriptors in guest RAM. This mirrors how the real SHA block
  reads off the DMA bus, needs no machine-init wiring order between the
  two devices, and keeps the peripherals independent.
- **Reusing the verified compress core.** DMA mode copies each pulled
  block into M_MEM and calls the *existing* `esp32p4_sha_compute(s,
  is_start)` — the same per-block path the CPU-fed mode uses and that's
  already validated for all 8 SHA modes. `is_start` = (DMA_START && first
  block); later blocks + DMA_CONTINUE = continue. Zero new crypto code.
- **End-to-end verification in running QEMU.** The self-test programs the
  whole real flow — padded "abc" block in L2MEM scratch, AXI-DMA ch0 TX
  bound to SHA (peri_sel 5) + out-link started via the AXI-DMA's own
  MMIO, then `SHA_MODE=256` + `SHA_DMA_BLOCK_NUM=1` + `SHA_DMA_START`:
  ```
  op#9 mode=2 (SHA-256) START → digest prefix: ba7816bf8f01cfea...
  self-test DMA-SHA256("abc")=OK
  ```
  `H_MEM == ba7816bf…20015ad` (FIPS 180-2 §B.1). AXI-DMA + AHB-DMA mem2mem
  regressions green; the guest bootloader's ~300 real SHA ops still run
  (typical mode untouched).

---

## NO funcionó / decisiones (what failed + decisions made)

- **Self-test silently no-op'd (init-order bug).** First run produced no
  `DMA-SHA…` line and no extra SHA op. Cause: in `esp32p4.c` the **SHA
  init block runs *after* the AXI-DMA block** (the AES/SHA crypto sub-block
  sits lower in `machine_init` than the DMA blocks). I'd placed the
  SHA-DMA self-test call *inside* the AXI-DMA block — at which point
  `ms->sha` is not yet realized and `event_log` is NULL, so
  `esp32p4_sha_dma_self_test` hit its `if (!s->event_log) return;` guard.
  **Fix:** moved the call to just after `esp32p4_sha_self_test(&ms->sha)`
  in the SHA block — by then the SHA is realized *and* the AXI-DMA (mapped
  earlier) is reachable via the bus. Confirmed by the ordering of the
  stderr (axi_dma self-test @ line 102, SHA self-tests @ 119-128). Lesson:
  a cross-peripheral self-test must run after *both* devices are realized
  — place it at the later device's init, reaching back to the earlier one.
- **Scope: SHA TX-only, no DMA-side interrupt.** SHA uses only the TX
  channel; there's no RX writeback (the digest is in registers). The SHA
  returns each consumed descriptor's ownership→CPU but does **not** raise
  the AXI-DMA channel's OUT_EOF interrupt (real SHA drivers poll SHA /
  take the SHA interrupt, not the DMA one). Documented simplification.
- **DMA-mode AES deferred.** AES-DMA additionally needs the **RX**
  (result) channel — ciphertext written back to memory via the in-link +
  CBC/CTR/GCM chaining — so it's a larger, separate phase. Flagged in next.
- **Tooling (recurring):** must launch QEMU from a committed script file;
  the inline `wsl … bash -lc '…/mnt/c/… long path…'` blanks `$FW` (Git-Bash
  MSYS path mangling). Also: WSL `/tmp` clears between separate `wsl.exe`
  invocations, so run + inspect in **one** `bash -lc`.

---

## Lessons learned

1. **Read the peripheral off the bus, not via a pointer.** Modeling the
   crypto↔DMA coupling as MMIO/memory reads (`address_space_read` of the
   AXI-DMA's `OUT_PERI_SEL`/`OUT_LINK2`) is both more faithful (it's what
   the silicon does) and structurally cleaner (no init-order wiring, no
   header entanglement) than a direct `ESP32P4AxiDmaState *` field.
2. **Cross-peripheral self-tests belong at the later-initialized device.**
   Place the test where the *last* dependency is realized and reach back
   to the earlier (already-mapped) one — otherwise the early-return guard
   hides the bug as a silent no-op.
3. **A verified per-block core makes new feed paths cheap.** DMA mode added
   ~80 lines and zero new crypto — it just feeds the existing
   `esp32p4_sha_compute`. The earlier investment in a clean compress
   function paid off directly.

## Implementación final (key shape)

- `esp32p4_sha_dma_run(s, is_start)`: read MODE→block_size; read
  `SHA_DMA_BLOCK_NUM`; scan AXI-DMA OUT channels for `PERI_SEL==5`; read
  its `OUT_LINK2`; walk the descriptor chain gathering
  `num_blocks×block_size` bytes (owner→CPU writeback per descriptor);
  feed each block to `esp32p4_sha_compute`.
- Hooked on `SHA_DMA_START` (is_start=true) / `SHA_DMA_CONTINUE`
  (is_start=false) writes; both self-clear.

## Próximas direcciones (next)

- **DMA-mode AES** (CBC/CTR/GCM): adds the RX result channel + chaining.
- **DMA-mode SHA-512** multi-block (128-byte blocks) — the path supports
  it; add a multi-block self-test.
- **INTMTX** (still the top structural gap for interrupts).
