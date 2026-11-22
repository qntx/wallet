/**
 * `clientKeys` strictly parses the client address: a valid IPv4 maps to its /24 — including an
 * IPv4-mapped IPv6, whose embedded address earns the same key — any other IPv6 to its normalized
 * /64 and /48, and an absent, unparseable or unspecified address yields no keys at all. The
 * `clientAddress` option decides what that means: `required` rejects the request with 400 before
 * any limiter or upstream call, `optional` meters it on the shared `unknown` key.
 */
import { describe, expect, it } from "vite-plus/test";

import { clientKeys } from "../src/middleware/rate-limit.ts";
import {
  SEPOLIA,
  allowAll,
  call,
  fakeFetch,
  gateway,
  headers,
  post,
  recordingLimiter,
  rpcOk,
} from "./helpers.ts";

describe("clientKeys", () => {
  it("maps an IPv4 address to its /24", () => {
    expect(clientKeys("198.51.100.200")).toStrictEqual(["198.51.100.0/24"]);
  });

  it("maps IPv4-mapped IPv6 to the embedded IPv4's /24, dotted or hex", () => {
    expect(clientKeys("::ffff:198.51.100.1")).toStrictEqual(clientKeys("198.51.100.1"));
    expect(clientKeys("::ffff:c633:6401")).toStrictEqual(clientKeys("198.51.100.1"));
    expect(clientKeys("::ffff:198.51.100.1")).toStrictEqual(["198.51.100.0/24"]);
  });

  it("keeps different embedded IPv4 prefixes on different keys", () => {
    expect(clientKeys("::ffff:198.51.100.1")).not.toStrictEqual(clientKeys("::ffff:203.0.113.9"));
    expect(clientKeys("::ffff:203.0.113.9")).toStrictEqual(["203.0.113.0/24"]);
  });

  it("keeps ::1 on IPv6 keys, distinct from mapped addresses", () => {
    const loopback = clientKeys("::1");
    expect(loopback).toStrictEqual(["0000:0000:0000:0000::/64", "0000:0000:0000::/48"]);
    expect(loopback).not.toStrictEqual(clientKeys("::ffff:198.51.100.1"));
  });

  it("normalizes other IPv6 addresses to /64 and /48 keys", () => {
    expect(clientKeys("2001:db8::1")).toStrictEqual([
      "2001:0db8:0000:0000::/64",
      "2001:0db8:0000::/48",
    ]);
    expect(clientKeys("fe80::1:2:3:4")).toStrictEqual([
      "fe80:0000:0000:0000::/64",
      "fe80:0000:0000::/48",
    ]);
    expect(clientKeys("2001:db8:1:2:3:4:5:6")).toStrictEqual([
      "2001:0db8:0001:0002::/64",
      "2001:0db8:0001::/48",
    ]);
  });

  it("returns undefined for absent, empty, unparseable and unspecified addresses", () => {
    for (const ip of [
      undefined,
      "",
      "::",
      "0.0.0.0",
      "1.2.3",
      "256.1.1.1",
      "fe80::1%eth0",
      "nonsense",
    ]) {
      expect(clientKeys(ip)).toBeUndefined();
    }
  });
});

describe("client address modes", () => {
  it("required rejects a missing client address before any limiter or upstream call", async () => {
    const ip = recordingLimiter();
    const rpc = recordingLimiter();
    const share = recordingLimiter();
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk("0xaa36a7") });
    const app = gateway({
      fetch: up.fetch,
      clientAddress: "required",
      limiters: { ip, rpc, default: allowAll, share },
    });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
    expect(ip.keys).toHaveLength(0);
    expect(rpc.keys).toHaveLength(0);
    expect(share.keys).toHaveLength(0);
    expect(up.calls).toHaveLength(0);
  });

  it("required still exempts health", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch, clientAddress: "required" });
    const res = await app.request("/v1/health", { headers: headers() });
    expect(res.status).toBe(200);
  });

  it("optional meters an invalid client address on the shared unknown key", async () => {
    const ip = recordingLimiter();
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk("0xaa36a7") });
    const app = gateway({
      fetch: up.fetch,
      limiters: { ip, rpc: allowAll, default: allowAll, share: allowAll },
    });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(200);
    expect(ip.keys).toStrictEqual(["unknown"]);
  });
});
