/**
 * sensorModels — the one declaration of the sensors whose MODEL drives the line.
 *
 * A handful of parts are not in the SPICE netlist and are not driven by the
 * host either: the sensor's own model owns the wire for the whole exchange. An
 * HC-SR04 answers a trigger with a timed ECHO pulse; a DHT22 bit-bangs a
 * 40-bit frame on its DATA line. Whoever emulates that model — the backend
 * QEMU worker, or an in-browser engine's sensor hub — is the only thing
 * allowed to move those pads, and every other layer has to stand down.
 *
 * That fact used to be written down in several places at once: a set of type
 * names in the ESP32 bridge, a union type and a pair of `if (type === ...)`
 * branches in the overlay's hub, and a wiring map in the store. Nothing tied
 * them together, so adding a third single-wire sensor meant finding all of
 * them, and missing one was silent — exactly the failure that cost an HC-SR04
 * its echo pin. This module is the single list; the code that MODELS each
 * sensor stays where it is (that is real per-device behaviour, not a list).
 *
 * NOT in here on purpose: sensors that register through the same channel but
 * only LISTEN — an ePaper panel's DC / CS / RST, a membrane keypad's rows, any
 * I2C device on a virtual 200+addr pin. The host drives those, so they must
 * stay drivable.
 *
 * Adding a single-wire sensor: one entry here, plus the model itself (a part
 * under simulation/parts and, for the in-browser engines, a case in the
 * overlay's singleWireSensors). Nothing else needs to learn its name.
 */

export interface SensorModelSpec {
  /** `sensor_type` in the wire protocol — what the backend / engine dispatches on. */
  sensorType: string;
  /** Component pin carrying the data (or trigger) line, as named on the part. */
  dataPinName: string;
  /** Component properties forwarded to the model (temperature, distance, …). */
  propertyKeys: string[];
  /**
   * Extra pins the model also drives, as `record field -> component pin name`.
   * The field name is what reaches the backend (`echo_pin`), and the same
   * fields are what `ownsPin` walks — so a model that gains a second line only
   * has to declare it here.
   */
  extraPins?: Record<string, string>;
}

/** Keyed by the component's metadataId on the canvas. */
export const SINGLE_WIRE_SENSOR_MODELS: Readonly<Record<string, SensorModelSpec>> = {
  dht22: {
    sensorType: 'dht22',
    dataPinName: 'SDA',
    propertyKeys: ['temperature', 'humidity'],
  },
  'hc-sr04': {
    sensorType: 'hc-sr04',
    dataPinName: 'TRIG',
    propertyKeys: ['distance'],
    extraPins: { echo_pin: 'ECHO' },
  },
};

/** `sensor_type` values whose model drives its own line. Derived, never typed twice. */
export const SINGLE_WIRE_SENSOR_TYPES: ReadonlySet<string> = new Set(
  Object.values(SINGLE_WIRE_SENSOR_MODELS).map((m) => m.sensorType),
);

/** True for a sensor record (`{ sensor_type, pin, ... }`) of a single-wire kind. */
export function isSingleWireSensorRecord(rec: Record<string, unknown>): boolean {
  return SINGLE_WIRE_SENSOR_TYPES.has(String(rec['sensor_type'] ?? ''));
}

/**
 * Pads a single-wire sensor record owns: its data pin plus every extra pin its
 * model declares (`echo_pin` for an HC-SR04). Read off the record's own fields
 * rather than a hard-coded field list, so a new extra pin is covered by the
 * declaration above alone.
 */
export function sensorRecordOwnsPin(rec: Record<string, unknown>, gpioPin: number): boolean {
  if (!isSingleWireSensorRecord(rec)) return false;
  if (rec['pin'] === gpioPin) return true;
  const spec = Object.values(SINGLE_WIRE_SENSOR_MODELS).find(
    (m) => m.sensorType === rec['sensor_type'],
  );
  for (const field of Object.keys(spec?.extraPins ?? {})) {
    if (rec[field] === gpioPin) return true;
  }
  return false;
}
