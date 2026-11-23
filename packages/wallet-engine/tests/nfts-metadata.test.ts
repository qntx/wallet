import { readFileSync } from "node:fs";

import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { hasHiddenCharacters } from "@qntx/wallet-chains";
import type { DisplayExcerpt } from "@qntx/wallet-chains";

import { hasUnsafeText } from "../src/display.ts";
import { NFT_DATA_URI_MAX, NFT_URL_MAX } from "../src/gateway/contract/index.ts";
import type { NftMediaRef } from "../src/gateway/contract/index.ts";
import {
  NFT_NAME_DISPLAY_MAX,
  sanitizeAttributes,
  sanitizeDescription,
  sanitizeMedia,
  sanitizeName,
} from "../src/nfts/metadata.ts";
import type { NftMedia } from "../src/nfts/metadata.ts";

type OrNull<T> = T | null;

type MediaExpect = {
  readonly scheme?: string;
  readonly url?: string;
  readonly mime?: string;
  readonly active?: boolean;
};

type Corpus = {
  readonly media: ReadonlyArray<{
    readonly id: string;
    readonly url: string;
    readonly mime?: string;
    readonly role?: "image" | "animation";
    readonly expect: OrNull<MediaExpect>;
  }>;
  readonly names: ReadonlyArray<{
    readonly id: string;
    readonly raw: string;
    readonly expect: { readonly name?: string; readonly deceptive: boolean };
  }>;
  readonly descriptions: ReadonlyArray<{
    readonly id: string;
    readonly raw: OrNull<string>;
    readonly expect: OrNull<{ readonly lines: ReadonlyArray<string>; readonly omitted: number }>;
  }>;
  readonly attributes: ReadonlyArray<{
    readonly id: string;
    readonly raw: ReadonlyArray<{ readonly trait: string; readonly value: string }>;
    readonly expect: ReadonlyArray<{ readonly trait: string; readonly value: string }>;
  }>;
};

const corpus = JSON.parse(
  readFileSync(new URL("fixtures/nfts/hostile-metadata.json", import.meta.url).pathname, "utf8"),
) as Corpus;

const refOf = (row: Corpus["media"][number]): NftMediaRef => ({
  url: row.url,
  mime: row.mime ?? null,
});

const mediaOf = (row: Corpus["media"][number]): NftMedia | undefined =>
  sanitizeMedia(refOf(row), row.role ?? "image");

const mediaRejects = corpus.media.filter((row) => row.expect === null);
const mediaAccepts = corpus.media.filter(
  (row): row is Corpus["media"][number] & { readonly expect: MediaExpect } => row.expect !== null,
);
const descriptionRejects = corpus.descriptions.filter((row) => row.expect === null);
const descriptionAccepts = corpus.descriptions.filter(
  (
    row,
  ): row is Corpus["descriptions"][number] & {
    readonly expect: { readonly lines: ReadonlyArray<string>; readonly omitted: number };
  } => row.expect !== null,
);

// oxlint-disable-next-line eslint/no-control-regex -- whitespace and C0/C1 must not survive sanitising
const NOISE = /[\s\u0000-\u001F\u007F-\u009F]/;

const HTTPS_SANE = /^https:\/\/[^/@:]+(:[0-9]*)?\//;

/** Every invariant an accepted media must hold, as one boolean so the property needs no branch. */
const mediaSane = (media: NftMedia | undefined): boolean =>
  media === undefined ||
  (["https", "ipfs", "ar", "data"].includes(media.scheme) &&
    !NOISE.test(media.url) &&
    media.url.length <= NFT_DATA_URI_MAX &&
    (media.scheme === "data" || media.url.length <= NFT_URL_MAX) &&
    (media.scheme !== "data" || media.url.startsWith("data:image/")) &&
    (media.mime === undefined || /^[a-z]+\/[a-z0-9.+-]+$/.test(media.mime)) &&
    (media.mime !== "image/svg+xml" || media.active));

/** Accepted https media is a credentialess, https-only URL. */
const httpsSane = (media: NftMedia | undefined): boolean =>
  media === undefined ||
  media.scheme !== "https" ||
  (HTTPS_SANE.test(media.url) &&
    new URL(media.url).username === "" &&
    new URL(media.url).password === "");

/** Code points of `text` — what the display caps count. */
const codePoints = (text: string): number => {
  let count = 0;
  for (const _char of text) {
    count += 1;
  }
  return count;
};

const nameSane = (name: string | undefined): boolean =>
  name === undefined ||
  (!hasUnsafeText(name) &&
    !/<\s*\/?\s*[a-z!?]/i.test(name) &&
    codePoints(name) <= NFT_NAME_DISPLAY_MAX);

const excerptSane = (excerpt: DisplayExcerpt | undefined): boolean =>
  excerpt === undefined ||
  (excerpt.lines.every((line) => !hasHiddenCharacters(line)) &&
    excerpt.lines.reduce((total, line) => total + codePoints(line), 0) <= 2000);

describe("sanitizeMedia hostile corpus", () => {
  it.each(mediaRejects)("rejects $id", (row) => {
    expect(mediaOf(row)).toBeUndefined();
  });

  it.each(mediaAccepts)("accepts $id", (row) => {
    expect(mediaOf(row)).toStrictEqual(expect.objectContaining(row.expect));
  });
});

describe("sanitizeName hostile corpus", () => {
  it.each(corpus.names)("$id", (row) => {
    expect(sanitizeName(row.raw)).toStrictEqual(row.expect);
  });
});

describe("sanitizeDescription hostile corpus", () => {
  it.each(descriptionRejects)("rejects $id", (row) => {
    expect(sanitizeDescription(row.raw)).toBeUndefined();
  });

  it.each(descriptionAccepts)("accepts $id", (row) => {
    expect(sanitizeDescription(row.raw)).toStrictEqual(row.expect);
  });
});

describe("sanitizeAttributes hostile corpus", () => {
  it.each(corpus.attributes)("$id", (row) => {
    expect(sanitizeAttributes(row.raw)).toStrictEqual(row.expect);
  });
});

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const BASE64URL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

/** URLs biased toward the allow-list shapes so accepted outputs get exercised, not just rejects. */
const urlArb = fc.oneof(
  { weight: 3, arbitrary: fc.string() },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.domain(),
        fc.array(fc.string({ unit: fc.constantFrom(..."abzAZ09-._~".split("")), maxLength: 8 }), {
          maxLength: 3,
        }),
      )
      .map(([domain, parts]) => `https://${domain}/${parts.join("/")}`),
  },
  {
    weight: 2,
    arbitrary: fc
      .string({ unit: fc.constantFrom(...BASE58.split("")), minLength: 44, maxLength: 44 })
      .map((cid) => `ipfs://Qm${cid}/x.png`),
  },
  {
    weight: 2,
    arbitrary: fc
      .string({ unit: fc.constantFrom(...BASE32.split("")), minLength: 58, maxLength: 70 })
      .map((cid) => `ipfs://b${cid}`),
  },
  {
    weight: 2,
    arbitrary: fc
      .string({ unit: fc.constantFrom(...BASE64URL.split("")), minLength: 43, maxLength: 43 })
      .map((id) => `ar://${id}`),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom("png", "jpeg", "gif", "webp", "avif", "svg+xml", "bmp"),
        fc.boolean(),
        fc.string({ unit: fc.constantFrom(..."ABCD+/=%&;<>xyz09".split("")), maxLength: 40 }),
      )
      .map(([kind, base64, payload]) => `data:image/${kind}${base64 ? ";base64" : ""},${payload}`),
  },
);

describe("sanitizer properties", () => {
  it("sanitizeMedia output stays inside the allow-list", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(
        urlArb,
        fc.oneof(fc.constant(null), fc.string()),
        fc.constantFrom("image" as const, "animation" as const),
        (url, mime, role) => {
          const media = sanitizeMedia({ url, mime }, role);
          expect(mediaSane(media)).toBe(true);
          expect(httpsSane(media)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it(
    "sanitizeName output never has unsafe text, tags, or more than the display cap",
    { timeout: 30_000 },
    () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 200 }),
          fc.string({ unit: "grapheme" }),
          (plain, unicode) => {
            expect(nameSane(sanitizeName(plain + unicode).name)).toBe(true);
          },
        ),
        { numRuns: 500 },
      );
    },
  );

  it(
    "sanitizeDescription lines never hide characters and stay inside the code-point cap",
    { timeout: 30_000 },
    () => {
      fc.assert(
        fc.property(fc.string({ unit: "grapheme" }), (raw) => {
          expect(excerptSane(sanitizeDescription(raw))).toBe(true);
        }),
        { numRuns: 500 },
      );
    },
  );
});
