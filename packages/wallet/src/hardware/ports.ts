/** The byte-oriented host ports the hardware transports run on: one write, one read. */

/** A byte-oriented HID port: report writes and reads (64 bytes for the current drivers). */
export type HidPort = {
  write: (report: Uint8Array) => Promise<void>;
  read: () => Promise<Uint8Array>;
};

/** A byte-oriented BLE port: characteristic writes and notification reads. */
export type BlePort = {
  write: (frame: Uint8Array) => Promise<void>;
  read: () => Promise<Uint8Array>;
};
