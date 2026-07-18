// @vitest-environment jsdom
/**
 * Store-level integration of parts-on-breadboard seating: moving a part so
 * its pins land on holes creates invisible bb wires, moving it away removes
 * them, and moving the breadboard carries seated parts along.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { BREADBOARD_PINS } from '../velxio-elements/breadboard-element';

const RES_PIN_INFO = [
  { name: '1', x: 0, y: 5.65, signals: [] },
  { name: '2', x: 58.8, y: 5.65, signals: [] },
];
const INSET = 6; // DynamicComponent wrapper border+padding

function mountFakeElement(id: string, pinInfo: unknown): void {
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  (el as unknown as { pinInfo: unknown }).pinInfo = pinInfo;
  document.body.appendChild(el);
}

/** Component x/y that puts resistor pin 1 exactly on the given hole. */
function resistorPosFor(holeName: string, bbX: number, bbY: number) {
  const hole = BREADBOARD_PINS.find((h) => h.name === holeName)!;
  return {
    x: bbX + INSET + hole.x - INSET - RES_PIN_INFO[0].x,
    y: bbY + INSET + hole.y - INSET - RES_PIN_INFO[0].y,
  };
}

describe('breadboard seating via updateComponent', () => {
  beforeEach(() => {
    const s = useSimulatorStore.getState();
    s.setComponents([
      { id: 'bb1', metadataId: 'breadboard', x: 0, y: 0, properties: {} },
      { id: 'res1', metadataId: 'resistor', x: 900, y: 900, properties: {} },
    ] as never);
    s.setWires([]);
    mountFakeElement('res1', RES_PIN_INFO);
  });

  it('creates one invisible bb wire per pin when the part lands on holes', () => {
    const pos = resistorPosFor('5t.a', 0, 0);
    useSimulatorStore.getState().updateComponent('res1', pos);

    const bbWires = useSimulatorStore.getState().wires.filter((w) => w.bb);
    expect(bbWires).toHaveLength(2);
    const holes = bbWires.map((w) => w.end.pinName).sort();
    // Pin 1 on 5t.a; pin 2 is 58.8 px away = 6 pitches + 1.2 px residual,
    // absorbed by the seat tolerance onto column 11.
    expect(holes).toEqual(['11t.a', '5t.a']);
    expect(bbWires.every((w) => w.end.componentId === 'bb1')).toBe(true);
  });

  it('removes the seating when the part moves off the board', () => {
    useSimulatorStore.getState().updateComponent('res1', resistorPosFor('5t.a', 0, 0));
    expect(useSimulatorStore.getState().wires.filter((w) => w.bb)).toHaveLength(2);

    useSimulatorStore.getState().updateComponent('res1', { x: 1500, y: 1500 });
    expect(useSimulatorStore.getState().wires.filter((w) => w.bb)).toHaveLength(0);
  });

  it('carries seated parts when the breadboard moves', () => {
    useSimulatorStore.getState().updateComponent('res1', resistorPosFor('5t.a', 0, 0));
    const before = useSimulatorStore.getState().components.find((c) => c.id === 'res1')!;

    useSimulatorStore.getState().updateComponent('bb1', { x: 120, y: 40 });

    const after = useSimulatorStore.getState().components.find((c) => c.id === 'res1')!;
    expect(after.x).toBeCloseTo(before.x + 120, 5);
    expect(after.y).toBeCloseTo(before.y + 40, 5);
    const holes = useSimulatorStore.getState().wires
      .filter((w) => w.bb)
      .map((w) => w.end.pinName)
      .sort();
    expect(holes).toEqual(['11t.a', '5t.a']); // same holes, new location
  });
});
