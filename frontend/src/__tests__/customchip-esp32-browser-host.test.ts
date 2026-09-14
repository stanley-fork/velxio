/**
 * A custom chip on an ESP32 board whose bridge does not host chips in a
 * backend worker takes the browser path, and that path gives it I2C and SPI
 * through the shim's surfaces.
 *
 * The OSS QEMU bridge hosts chips in its worker and has no opinion; an
 * overlay's in-browser engine answers `hostsCustomChips()` false. Before
 * this seam existed the shim's `sendPinEvent` alone decided, and a chip on
 * an in-browser engine was shipped as a sensor record nothing ever ran.
 */
import { describe, it, expect } from 'vitest';
import {
  detectSimulatorKind,
  hostsChipsInWorker,
  getI2CBus,
  ensureSpiBridge,
  getSimulatorBridges,
} from '../simulation/customChips/simulatorBridges';

function esp32Shim(extra: Record<string, unknown> = {}) {
  const added: Array<{ device: unknown; bus: number }> = [];
  const spi = {
    onByte: null as ((mosi: number) => void) | null,
    completed: [] as number[],
    completeTransfer(miso: number) {
      this.completed.push(miso);
    },
  };
  return {
    added,
    spi,
    sim: {
      sendPinEvent: () => {},
      registerSensor: () => true,
      addI2CDevice: (device: unknown, bus: number) => {
        added.push({ device, bus });
      },
      spi,
      ...extra,
    },
  };
}

describe('custom chips on an ESP32 shim', () => {
  it('is an esp32 simulator whichever bridge is behind the shim', () => {
    expect(detectSimulatorKind(esp32Shim().sim)).toBe('esp32');
    expect(detectSimulatorKind(esp32Shim({ hostsCustomChips: () => false }).sim)).toBe('esp32');
  });

  it('hosts chips in the worker when the bridge has no opinion', () => {
    expect(hostsChipsInWorker(esp32Shim().sim)).toBe(true);
    expect(hostsChipsInWorker(esp32Shim({ hostsCustomChips: () => true }).sim)).toBe(true);
  });

  it('leaves chips to the browser when the bridge says it has no worker', () => {
    expect(hostsChipsInWorker(esp32Shim({ hostsCustomChips: () => false }).sim)).toBe(false);
  });

  it('treats a throwing answer as the worker path, never as a crash', () => {
    const { sim } = esp32Shim({
      hostsCustomChips: () => {
        throw new Error('bridge gone');
      },
    });
    expect(hostsChipsInWorker(sim)).toBe(true);
  });

  it('never claims a worker for a simulator that is not there', () => {
    expect(hostsChipsInWorker(null)).toBe(false);
    expect(hostsChipsInWorker(undefined)).toBe(false);
  });

  it('gives a browser-hosted chip the shim I2C bus', () => {
    const { sim, added } = esp32Shim({ hostsCustomChips: () => false });
    const bus = getI2CBus(sim, 0);
    expect(bus).not.toBeNull();
    const device = { address: 0x50 };
    bus!.addDevice(device);
    expect(added).toEqual([{ device, bus: 0 }]);
  });

  it('gives a browser-hosted chip the shim SPI adapter', () => {
    const { sim, spi } = esp32Shim({ hostsCustomChips: () => false });
    ensureSpiBridge(sim);
    expect(typeof spi.onByte).toBe('function');
    const bridges = getSimulatorBridges(sim);
    expect(bridges.spiInstalled).toBe(true);
    // No chip on the bus yet: a transfer still completes with the bus's
    // idle answer, so the engine's SPI master is never left waiting.
    spi.onByte!(0xa5);
    expect(spi.completed).toHaveLength(1);
  });
});
