/**
 * The discoverable-change window `isDiscoverableChange` opens above the sealed mark: exactly `mark +
 * BITCOIN_GAP_LIMIT` — one index wider and the scan hides an output nobody can reach.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  BITCOIN_GAP_LIMIT,
  BITCOIN_SCAN_LIMIT,
  changeScanReach,
  isDiscoverableChange,
} from "../src/bitcoin/own.ts";
import type { BitcoinPathTail } from "../src/bitcoin/own.ts";

const input = { purpose: 84, change: 0, index: 0 } satisfies BitcoinPathTail;
const output = (index: number): BitcoinPathTail => ({ purpose: 84, change: 1, index });

describe("isDiscoverableChange", () => {
  it("covers the sealed mark's window exactly — one index past the gap limit is not own", () => {
    expect(isDiscoverableChange(output(BITCOIN_GAP_LIMIT), [input], 0)).toBe(true);
    expect(isDiscoverableChange(output(BITCOIN_GAP_LIMIT + 1), [input], 0)).toBe(false);
  });

  it("the reach moves with the mark and stops at the scan limit", () => {
    expect(changeScanReach(0)).toBe(BITCOIN_GAP_LIMIT);
    expect(changeScanReach(BITCOIN_SCAN_LIMIT - 1)).toBe(BITCOIN_SCAN_LIMIT - 1);
    expect(changeScanReach(100)).toBe(100 + BITCOIN_GAP_LIMIT);
    // An input on a different purpose opens no window at all.
    const other = { purpose: 49, change: 0, index: 0 } satisfies BitcoinPathTail;
    expect(isDiscoverableChange(output(1), [other], 0)).toBe(false);
    // Receive-chain outputs are never discoverable change.
    expect(isDiscoverableChange({ purpose: 84, change: 0, index: 1 }, [input], 0)).toBe(false);
  });
});
