import { hexToBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import {
  displayExcerpt,
  hasHiddenCharacters,
  isBlindIntent,
  isEncodedBytes,
  messageBlindReason,
  messageContent,
  messageTextHazard,
} from "../src/index.ts";
import type { DisplayIntent } from "../src/index.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const utf8s = new TextDecoder("utf-8", { fatal: true });

/* The England flag emoji: U+1F3F4 then tag letters g, b, e, n, g and the cancel tag. */
const ENGLAND = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";

describe("displayExcerpt", () => {
  it("replaces characters that hide or reorder text", () => {
    const { lines, omitted } = displayExcerpt("pay \u202Eecila\u202C\u200B to\tbob\u0007", 4, 100);
    expect(lines).toStrictEqual(["pay �ecila�� to bob�"]);
    expect(omitted).toBe(0);
  });

  it("drops empty lines so padding cannot push content out of view", () => {
    const padded = `first${"\n".repeat(50)}\r\n \u2028second\u2029third`;
    expect(displayExcerpt(padded, 3, 100).lines).toStrictEqual(["first", "second", "third"]);
  });

  it("stops at the line limit and counts what it left out", () => {
    expect(displayExcerpt("a\nbb\nccc\ndddd", 2, 100)).toStrictEqual({
      lines: ["a", "bb"],
      omitted: 7,
    });
  });

  it("cuts the last line at the code-point limit", () => {
    expect(displayExcerpt("abcdef\nghi", 4, 4)).toStrictEqual({ lines: ["abcd"], omitted: 5 });
  });

  it("counts an astral character once", () => {
    expect(displayExcerpt("😀😀😀", 1, 2)).toStrictEqual({ lines: ["😀😀"], omitted: 1 });
  });

  it("keeps joiners that join and replaces the ones that do not", () => {
    // A ZWJ between emoji and a ZWNJ between Persian letters are kept verbatim.
    expect(displayExcerpt("a 👨\u200D💻 b", 1, 96).lines[0]).toBe("a 👨\u200D💻 b");
    expect(displayExcerpt("می\u200Cخواهم وارد شوم", 1, 96).lines[0]).toBe("می\u200Cخواهم وارد شوم");
    // A joiner at the start of the text or next to whitespace joins nothing: U+FFFD.
    expect(displayExcerpt("\u200Dabc", 1, 96).lines[0]).toBe("�abc");
    expect(displayExcerpt("a\u200D b", 1, 96).lines[0]).toBe("a� b");
    // Direction marks and the soft hyphen always display as U+FFFD.
    expect(displayExcerpt("ab\u200Ecd\u200Fef\u00ADg\u061Ch", 1, 96).lines[0]).toBe("ab�cd�ef�g�h");
    // A valid emoji tag sequence is kept; a stray tag character is replaced.
    expect(displayExcerpt(`flag ${ENGLAND}`, 1, 96).lines[0]).toBe(`flag ${ENGLAND}`);
    expect(displayExcerpt("stray \u{E0067} tag", 1, 96).lines[0]).toBe("stray � tag");
  });
});

describe("hasHiddenCharacters", () => {
  it("ordinary text and the permitted whitespace pass", () => {
    expect(hasHiddenCharacters("hello world")).toBe(false);
    expect(hasHiddenCharacters("a\tb\nc\rd\r\ne")).toBe(false);
    expect(hasHiddenCharacters("héllo wörld 你好")).toBe(false);
  });

  it("format characters — joiners, marks, soft hyphen, tag sequences — are ordinary text", () => {
    expect(hasHiddenCharacters("Sign in 👨\u200D💻")).toBe(false);
    expect(hasHiddenCharacters("می\u200Cخواهم وارد شوم")).toBe(false);
    expect(hasHiddenCharacters("התחברות לאתר\u200F 2026")).toBe(false);
    expect(hasHiddenCharacters("\u061Cمرحبا")).toBe(false);
    expect(hasHiddenCharacters("Ex\u00ADample")).toBe(false);
    expect(hasHiddenCharacters(ENGLAND)).toBe(false);
  });

  it.each([
    ["NUL", "\u0000"],
    ["bell", "\u0007"],
    ["escape", "\u001B"],
    ["bidi override", "\u202E"],
    ["zero-width space", "\u200B"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
    ["tag character", "\u{E0061}"],
    ["vertical tab", "\u000B"],
    ["form feed", "\u000C"],
    ["backspace", "\u0008"],
    ["delete", "\u007F"],
    ["interlinear annotation anchor", "\uFFF9"],
    ["word joiner", "\u2060"],
    ["byte order mark", "\uFEFF"],
  ])("text containing %s has hidden characters", (_name, char) => {
    expect(hasHiddenCharacters(`see ${char} this`)).toBe(true);
  });
});

describe("code point classes against an independent definition", () => {
  /* The same rule re-derived independently: a code point is hidden iff it is a control other
     than TAB/LF/CR, a line or paragraph separator U+2028/2029, one of the bidi embedding/override
     marks U+202A–202E, an interlinear annotation anchor U+FFF9–FFFB, a default-ignorable outside
     the format set (joiners, direction marks, SHY, CGJ, variation selectors, tag characters), a
     tag character — a lone one is never inside an RGI emoji tag sequence — or a variation
     selector — a lone one has no base before it. */
  const DECEPTIVE = /[\p{Cc}\u2028\u2029\u202A-\u202E\uFFF9-\uFFFB]/u;
  const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
  const BASIC_FORMAT = /\u200C|\u200D|\u200E|\u200F|\u061C|\u00AD|\u034F/u;
  const SELECTOR = /\p{Variation_Selector}/u;
  const expectHidden = (char: string, cp: number): boolean =>
    (cp >= 0xe0020 && cp <= 0xe007f) ||
    SELECTOR.test(char) ||
    (cp !== 0x09 && cp !== 0x0a && cp !== 0x0d && DECEPTIVE.test(char)) ||
    (IGNORABLE.test(char) && !BASIC_FORMAT.test(char));

  it("every code point 0..0x10FFFF agrees with the oracle", { timeout: 120_000 }, () => {
    const ranges: ReadonlyArray<readonly [number, number]> = [
      [0, 0xd7ff],
      [0xe000, 0x10ffff],
    ];
    for (const [lo, hi] of ranges) {
      for (let cp = lo; cp <= hi; cp++) {
        const char = String.fromCodePoint(cp);
        expect(hasHiddenCharacters(char)).toBe(expectHidden(char, cp));
      }
    }
  });
});

describe("isEncodedBytes", () => {
  const digest = new Uint8Array(32).fill(0xab);

  it("is true for hex of more than 40 digits, separated or with a 0x of either case", () => {
    for (const text of [
      `0x${"ab".repeat(32)}`,
      `0X${"ab".repeat(32)}`,
      "ab".repeat(32),
      `0x${"ab".repeat(32)}a`,
      Array.from({ length: 32 }, () => "ab").join(" "),
      Array.from({ length: 32 }, () => "ab").join(":"),
      Array.from({ length: 32 }, () => "ab").join("-"),
      `${"ab".repeat(16)}\n${"ab".repeat(16)}`,
      `  0x${"cd".repeat(32)}  `,
      `0x${"ab".repeat(21)}`,
      `0x${"ab".repeat(31)}`,
    ]) {
      expect(isEncodedBytes(text)).toBe(true);
    }
  });

  it("is true for a base64 or base58 token of 32 bytes", () => {
    expect(isEncodedBytes(base64.encode(digest))).toBe(true);
    expect(isEncodedBytes(base58.encode(digest))).toBe(true);
  });

  it("is false for an address written as text and for hex inside a sentence", () => {
    expect(isEncodedBytes(`0x${"ab".repeat(20)}`)).toBe(false);
    expect(isEncodedBytes("9f2b8c1d4e5a6f708192a3b4c5d6e7f8")).toBe(false);
    expect(isEncodedBytes(`nonce ${"ab".repeat(16)} ok`)).toBe(false);
    expect(isEncodedBytes(`the code is ${"ab".repeat(16)} — see it`)).toBe(false);
    expect(isEncodedBytes(`0x${"ab".repeat(19)}`)).toBe(false);
    expect(isEncodedBytes(`0x${"gh".repeat(32)}`)).toBe(false);
    expect(isEncodedBytes("hello")).toBe(false);
    expect(isEncodedBytes("0x")).toBe(false);
  });
});

describe("messageContent", () => {
  const siwe = [
    "example.com wants you to sign in with your Ethereum account:",
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "",
    "",
    "URI: https://example.com",
    "Version: 1",
    "Chain ID: 1",
    "Nonce: 12345678",
    "Issued At: 2026-01-01T00:00:00Z",
  ].join("\n");

  it("recognises a sign-in message for its own family only", () => {
    expect(messageContent(utf8(siwe), "evm")).toMatchObject({
      kind: "text",
      signIn: { status: "valid", fields: { domain: "example.com" } },
    });
    expect(messageContent(utf8(siwe), "solana")).toMatchObject({
      kind: "text",
      signIn: { status: "malformed" },
    });
  });

  it("keeps plain text and falls back to hex for invalid UTF-8", () => {
    expect(messageContent(utf8("hello"), "evm")).toStrictEqual({ kind: "text", text: "hello" });
    expect(messageContent(new Uint8Array([0xff, 0x00]), "solana")).toStrictEqual({
      kind: "bytes",
      hex: "0xff00",
    });
  });

  it("keeps a leading BOM so the text still measures as the signed bytes", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("sign this digest for me now!!")]);
    expect(bom).toHaveLength(32);
    expect(messageContent(bom, "evm")).toStrictEqual({
      kind: "text",
      text: "\uFEFFsign this digest for me now!!",
    });
    expect(messageTextHazard("\uFEFFsign this digest for me now!!")).toBe("digest-length");
    const short = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("hello")]);
    expect(messageContent(short, "evm")).toStrictEqual({ kind: "text", text: "\uFEFFhello" });
    expect(messageTextHazard("\uFEFFhello")).toBe("hidden-characters");
  });
});

describe("isBlindIntent", () => {
  it("is blind iff the decoder set a blind reason", () => {
    expect(isBlindIntent({})).toBe(false);
    expect(isBlindIntent({ blind: "message-bytes" })).toBe(true);
    for (const blind of [
      "typed-data-oversize",
      "token-function",
      "account-code",
      "safe-delegatecall",
      "safe-refund-unbounded",
    ] as const) {
      expect(isBlindIntent({ blind })).toBe(true);
    }
  });

  it("an unverifiable request is not blind unless the decoder says so", () => {
    const opaque: DisplayIntent = {
      family: "evm",
      network: "eip155:1",
      summary: "contract-call",
      outflows: [],
      approvals: [],
      fee: undefined,
      warnings: [],
      verifiability: "opaque",
    };
    expect(isBlindIntent(opaque)).toBe(false);
    expect(isBlindIntent({ ...opaque, blind: "account-code" })).toBe(true);
  });
});

describe("messageTextHazard", () => {
  it("32-byte text is a digest-length hazard; longer or shorter text is not", () => {
    expect(messageTextHazard("a".repeat(32))).toBe("digest-length");
    for (const n of [31, 33]) {
      expect(messageTextHazard("a".repeat(n))).toBeUndefined();
    }
    expect(messageTextHazard("hello world")).toBeUndefined();
    /* The ground digest: a keccak output that happens to be valid UTF-8. */
    const digest = hexToBytes("5718efa1a01c4e34c7b5481f5450604d1274491d0f310532dcbd7461c9ae3b79");
    expect(() => utf8s.decode(digest)).not.toThrow();
    expect(messageTextHazard(utf8s.decode(digest))).toBe("digest-length");
  });

  it("a deceptive code point is a hidden-characters hazard; format characters are not", () => {
    for (const char of ["\u0000", "\u202E", "\u200B", "\u2028", "\u{E0061}"]) {
      expect(messageTextHazard(`see ${char} this`)).toBe("hidden-characters");
    }
    for (const text of [
      "a\tb",
      "Sign in 👨\u200D💻",
      "می\u200Cخواهم وارد شوم",
      "התחברות לאתר\u200F 2026",
      "\u061Cمرحبا",
      "Ex\u00ADample",
      ENGLAND,
    ]) {
      expect(messageTextHazard(text)).toBeUndefined();
    }
  });

  it("an encoded rendering is an encoded-bytes hazard; digest-length wins over both", () => {
    expect(messageTextHazard(`0x${"ab".repeat(32)}`)).toBe("encoded-bytes");
    expect(messageTextHazard(base64.encode(Uint8Array.from({ length: 32 }, (_, i) => i)))).toBe(
      "encoded-bytes",
    );
    expect(messageTextHazard("ab".repeat(16))).toBe("digest-length");
  });
});

describe("messageBlindReason", () => {
  it("bytes and hazard text are blind; ordinary text and typed data are not", () => {
    expect(messageBlindReason({ kind: "bytes", hex: "0xff" })).toBe("message-bytes");
    expect(messageBlindReason({ kind: "text", text: "hi" })).toBeUndefined();
    expect(
      messageBlindReason({
        kind: "typed-data",
        primaryType: "Order",
        domain: {},
        data: {},
      }),
    ).toBeUndefined();
    expect(messageBlindReason({ kind: "text", text: "a".repeat(32) })).toBe("message-bytes");
    expect(messageBlindReason({ kind: "text", text: "see \u202E this" })).toBe("message-bytes");
    expect(messageBlindReason({ kind: "text", text: `0x${"ab".repeat(32)}` })).toBe(
      "message-bytes",
    );
    expect(messageBlindReason({ kind: "text", text: "see \t this" })).toBeUndefined();
  });
});

describe("corpus message texts", () => {
  const texts: ReadonlyArray<
    readonly [string, string, "digest-length" | undefined, "message-bytes" | undefined]
  > = [
    ["32-byte ASCII login", "Sign in to app.example.org #4821", "digest-length", "message-bytes"],
    ["32-char hex nonce", "9f86d081884c7d659a2feaa0c55ad015", "digest-length", "message-bytes"],
    ["32-byte CJK login", "请签名以登录示例网站12", "digest-length", "message-bytes"],
    ["ZWJ emoji", "Welcome back 👨\u200D💻 — sign to log in", undefined, undefined],
    ["ZWJ flag", "Sign in to Pride DAO 🏳️\u200D🌈", undefined, undefined],
    ["England flag tag sequence", ENGLAND, undefined, undefined],
    ["Persian ZWNJ", "برای ورود به حساب کاربری می\u200Cخواهم امضا کنم", undefined, undefined],
    ["Hebrew RLM", "התחברות לאתר\u200F 2026", undefined, undefined],
    ["Arabic ALM", "\u061Cمرحبا، تسجيل الدخول إلى حسابي", undefined, undefined],
    ["soft hyphen", "Sign in to Ex\u00ADample", undefined, undefined],
  ];

  it.each(texts)(
    "%s is text, and blind exactly when digest-length",
    (_name, text, hazard, blind) => {
      const content = messageContent(utf8(text), "evm");
      expect(content.kind).toBe("text");
      expect(messageTextHazard(text)).toBe(hazard);
      expect(messageBlindReason(content)).toBe(blind);
    },
  );
});

describe("text rules", () => {
  const SIGNER = "0x2222222222222222222222222222222222222222";
  const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
  const personal = (text: string) =>
    ({
      kind: "evm.personal-message",
      network: "eip155:1",
      account: ACCOUNT,
      message: new TextEncoder().encode(text),
    }) as const;
  const TAG_FLAG = "\u{1F3F4}";
  const TAG_END = "\u{E007F}";
  const tags = (text: string): string => {
    let out = "";
    for (const c of text) {
      out += String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0));
    }
    return out;
  };

  it("a flag tag sequence with a non-RGI body is hidden and blinds the message", () => {
    const body = "transfer all funds to 0xabc";
    const text = `Sign in to app.example\n${TAG_FLAG}${tags(body)}${TAG_END}`;
    expect(messageTextHazard(text)).toBe("hidden-characters");
    const intent = decodeEvm(personal(text), SIGNER);
    expect(intent.blind).toBe("message-bytes");
    const { lines } = displayExcerpt(text, 10, 400);
    /* The flag base stays visible; every tag code point — body and terminator — shows U+FFFD. */
    expect(lines[1]).toBe(`${TAG_FLAG}${"\uFFFD".repeat(body.length + 1)}`);
  });

  it("tag bodies with spaces, uppercase and punctuation, or over 32 code points, are hidden", () => {
    for (const body of ["ORDER 66: SELL!", "x".repeat(40)]) {
      const text = `gm\n${TAG_FLAG}${tags(body)}${TAG_END}`;
      expect(messageTextHazard(text)).toBe("hidden-characters");
      expect(decodeEvm(personal(text), SIGNER).blind).toBe("message-bytes");
    }
  });

  it("a well-formed but non-RGI subdivision body is hidden", () => {
    expect(messageTextHazard(`${TAG_FLAG}${tags("ustx")}${TAG_END}`)).toBe("hidden-characters");
  });

  it("a lone tag character is hidden", () => {
    expect(messageTextHazard("Sign in \u{E0061} please")).toBe("hidden-characters");
  });

  it("a flag tag run without the U+E007F terminator is hidden", () => {
    expect(messageTextHazard(`a${TAG_FLAG}${tags("x")}`)).toBe("hidden-characters");
    expect(messageTextHazard(`a${TAG_FLAG}${tags("gbsct")}`)).toBe("hidden-characters");
  });

  it("stray tag characters after the cancel tag are hidden", () => {
    expect(messageTextHazard(`a${TAG_FLAG}${tags("x")}${TAG_END}${tags("y")}`)).toBe(
      "hidden-characters",
    );
  });

  it("a variation selector without a base it is defined for is hidden", () => {
    const selectors =
      Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0xfe00 + i)).join("") +
      Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0xe0100 + i)).join("");
    expect(messageTextHazard(`Hello${selectors}`)).toBe("hidden-characters");
    expect(decodeEvm(personal(`Hello${selectors}`), SIGNER).blind).toBe("message-bytes");
    expect(messageTextHazard("a\uFE0F")).toBe("hidden-characters");
    expect(messageTextHazard("❤\uFE0F\uFE0F")).toBe("hidden-characters");
    expect(messageTextHazard("a\u{E0100}")).toBe("hidden-characters");
  });

  it("a variation selector after a base it is defined for is ordinary text", () => {
    expect(messageTextHazard("❤\uFE0F")).toBeUndefined();
    expect(messageTextHazard("\u349E\uFE00")).toBeUndefined();
    expect(messageTextHazard("葛\u{E0100}")).toBeUndefined();
    expect(messageTextHazard("ᠠ\u180B")).toBeUndefined();
  });

  it("joiners and CGJ outside a joining context display as U+FFFD but are not hidden", () => {
    for (const [text, display] of [
      ["Pay to 0xab\u200Dcd", "Pay to 0xab�cd"],
      ["a\u200Cb", "a�b"],
      ["a\u200D😀", "a�😀"],
      ["😀\u200Da", "😀�a"],
      ["a\u034Fb", "a�b"],
    ] as const) {
      expect(messageTextHazard(text)).toBeUndefined();
      expect(decodeEvm(personal(text), SIGNER).blind).toBeUndefined();
      expect(displayExcerpt(text, 1, 400).lines[0]).toBe(display);
    }
  });

  const fieldAt = (intent: DisplayIntent, path: string): string | undefined =>
    intent.message?.kind === "typed-data"
      ? intent.message.fields?.find((f) => f.path === path)?.value
      : undefined;

  it("a typed-data string leaf with a smuggling tag run shows U+FFFD, blind", () => {
    const tagged = `hi${TAG_FLAG}${tags("hidden")}${TAG_END}`;
    const doc = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Note: [
          { name: "text", type: "string" },
          { name: "to", type: "address" },
        ],
      },
      primaryType: "Note",
      domain: { name: "Notebook", chainId: 1 },
      message: { text: tagged, to: SIGNER },
    };
    const intent = decodeEvm(
      {
        kind: "evm.typed-data",
        network: "eip155:1",
        account: ACCOUNT,
        typedData: JSON.stringify(doc),
      },
      SIGNER,
    );
    /* The leaf goes through displayExcerpt like every shown value: deceptive code points render
       as U+FFFD in the field line — and the request is blind, since the signed string carries
       characters the shown line cannot reproduce. */
    expect(intent.blind).toBe("message-bytes");
    expect(fieldAt(intent, "text")).toBe(`hi${TAG_FLAG}${"\uFFFD".repeat("hidden".length + 1)}`);
  });
});
