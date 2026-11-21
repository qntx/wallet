/**
 * `ipKeys` treats IPv4-mapped IPv6 strings as IPv6 (any address containing `:`), and the
 * `::`-expansion never parses the dotted tail as hex: every `::ffff:a.b.c.d` — and every other
 * address starting with `::`, including `::1` — normalises to the same all-zero `/64` + `/48` keys.
 * Distinct embedded IPv4 /24s get no separate limiter counters.
 */
import { describe, expect, it } from "vite-plus/test";

import { ipKeys } from "../../src/middleware/rate-limit.ts";

describe("ipKeys IPv4-mapped-IPv6 collapse", () => {
  it("two different ::ffff: addresses and ::1 produce identical keys", () => {
    const a = ipKeys("::ffff:198.51.100.1");
    const b = ipKeys("::ffff:203.0.113.9");
    const lo = ipKeys("::1");
    console.log(`::ffff:198.51.100.1 → ${JSON.stringify(a)}`);
    console.log(`::ffff:203.0.113.9 → ${JSON.stringify(b)}`);
    console.log(`::1 → ${JSON.stringify(lo)}`);
    expect(b).toStrictEqual(a);
    expect(lo).toStrictEqual(a);
    expect(a).toStrictEqual(["0000:0000:0000:0000::/64", "0000:0000:0000::/48"]);
  });

  it("missing IPs share the single unknown key", () => {
    console.log(
      `undefined → ${JSON.stringify(ipKeys(undefined))} "" → ${JSON.stringify(ipKeys(""))}`,
    );
    expect(ipKeys(undefined)).toStrictEqual(["unknown"]);
    expect(ipKeys("")).toStrictEqual(["unknown"]);
  });
});
