/**
 * Pro WiFi-gate registry.
 *
 * Pico W (CYW43439) WiFi emulation is a paid overlay feature. Unlike
 * `proBoardGate` (which gates whole Pro boards: STM32 / QEMU Raspberry Pi),
 * the Pico W BOARD itself is free — it runs as a plain Pico in the browser.
 * ONLY WiFi is gated, so this doorbell fires only when a Pico W sketch
 * actually USES WiFi (so a free user can still blink an LED on a Pico W).
 *
 * Mirrors the other OSS->Pro seams (`proBoardGate.ts`, `proSaveAction.ts`,
 * `proSession.ts`): the OSS app defines a stable doorbell and hands over the
 * sketch files; the overlay plugs in the real decision.
 *
 *   - OSS without an overlay -> default 'allow'. Self-hosted builds have no
 *     WiFi engine at all; a Pico W simulates as a plain Pico.
 *   - With the pro overlay   -> 'block' for a WiFi-using sketch run by a
 *     non-paid web user; the caller fires the upgrade prompt and skips the run
 *     (so it never boots the plain-Pico firmware and crashes on
 *     `import network`).
 */

import type { BoardKind } from '../types/board';

export type WifiGateDecision = 'allow' | 'block';

type WifiGateFile = { name: string; content: string };
type WifiGateImpl = (kind: BoardKind | string, files: WifiGateFile[]) => WifiGateDecision;

let _impl: WifiGateImpl | null = null;

/** Installed by the pro overlay (mountPro). Pass null to clear (hot reload). */
export function installWifiGateImpl(impl: WifiGateImpl | null): void {
  _impl = impl;
}

/** Whether the pro overlay has installed a WiFi gate. */
export function hasWifiGateImpl(): boolean {
  return _impl !== null;
}

/**
 * Decide whether running `kind` with these source files is allowed. With no
 * overlay the OSS default is 'allow'. The overlay's impl sniffs the files for
 * WiFi usage and checks the signed-in user's entitlement.
 */
export function wifiGateDecision(
  kind: BoardKind | string,
  files: WifiGateFile[],
): WifiGateDecision {
  if (!_impl) return 'allow';
  try {
    return _impl(kind, files);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] wifi-gate impl threw:', err);
    return 'allow';
  }
}
