/**
 * Characters that pass the display checks while hiding what was signed: emoji tag sequences (their
 * body is not restricted to the UTS #51 Annex C tag-alphabet or length), variation selectors, and
 * joiners between letters. Each row pins current behaviour.
 */
import { describe, expect, it } from "vite-plus/test";

import { displayExcerpt } from "../../src/display.ts";
import { decodeEvm } from "../../src/evm/index.ts";
import { messageTextHazard } from "../../src/index.ts";
import type { DisplayIntent, SignRequest } from "../../src/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

const personal = (text: string): SignRequest => ({
  kind: "evm.personal-message",
  network: "eip155:1",
  account: ACCOUNT,
  message: new TextEncoder().encode(text),
});

/** Each ASCII char as its tag character U+E0000 + c. */
const tags = (text: string): string => {
  let out = "";
  for (const c of text) {
    out += String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0));
  }
  return out;
};

const TAG_FLAG = "\u{1F3F4}";
const TAG_END = "\u{E007F}";
const tagChars = /[\u{E0000}-\u{E007F}]/gu;

const fieldAt = (intent: DisplayIntent, path: string): string | undefined =>
  intent.message?.kind === "typed-data"
    ? intent.message.fields?.find((f) => f.path === path)?.value
    : undefined;

describe("hidden text the display checks pass", () => {
  it("a flag tag sequence carries an invisible ASCII sentence", () => {
    const text = `Sign in to app.example\n${TAG_FLAG}${tags("transfer all funds to 0xabc")}${TAG_END}`;
    expect(messageTextHazard(text)).toBeUndefined();
    const intent = decodeEvm(personal(text), SIGNER);
    expect(intent.blind).toBeUndefined();
    const { lines } = displayExcerpt(text, 10, 400);
    expect(lines[1]).toBeDefined();
    expect(lines[1]!.replaceAll(tagChars, "")).toBe("🏴");
  });

  it("tag bodies with spaces, uppercase and punctuation, or over 32 code points, still pass", () => {
    for (const body of ["ORDER 66: SELL!", "x".repeat(40)]) {
      const text = `gm\n${TAG_FLAG}${tags(body)}${TAG_END}`;
      expect(messageTextHazard(text)).toBeUndefined();
      expect(decodeEvm(personal(text), SIGNER).blind).toBeUndefined();
    }
  });

  it("a lone tag character outside a flag sequence is caught", () => {
    expect(messageTextHazard(`Sign in \u{E0061} please`)).toBe("hidden-characters");
  });

  it("variation selectors pass through and stay in the displayed line", () => {
    const selectors =
      Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0xfe00 + i)).join("") +
      Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0xe0100 + i)).join("");
    const text = `Hello${selectors}`;
    expect(messageTextHazard(text)).toBeUndefined();
    expect(decodeEvm(personal(text), SIGNER).blind).toBeUndefined();
    const [line] = displayExcerpt(text, 1, 400).lines;
    expect(line).toBe(text);
  });

  it("a ZWJ between hex letters passes and is kept in the displayed line", () => {
    const text = "Pay to 0xab\u200Dcd";
    expect(messageTextHazard(text)).toBeUndefined();
    expect(decodeEvm(personal(text), SIGNER).blind).toBeUndefined();
    expect(displayExcerpt(text, 1, 400).lines[0]).toBe(text);
  });

  it("typed-data string leaves carry the tag sequence through", () => {
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
    const request: SignRequest = {
      kind: "evm.typed-data",
      network: "eip155:1",
      account: ACCOUNT,
      typedData: JSON.stringify(doc),
    };
    const intent = decodeEvm(request, SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(fieldAt(intent, "text")).toBe(tagged);
  });

  it("a flag tag run without the U+E007F terminator is caught", () => {
    expect(messageTextHazard(`a${TAG_FLAG}${tags("x")}`)).toBe("hidden-characters");
  });

  it("stray tag characters after the cancel tag are caught", () => {
    const text = `a${TAG_FLAG}${tags("x")}${TAG_END}${tags("y")}`;
    expect(messageTextHazard(text)).toBe("hidden-characters");
  });

  it.each([0x2066, 0x2067, 0x2068, 0x2069])(
    "bidi isolate U+%s is caught and shown as U+FFFD",
    (cp) => {
      const text = `send ${String.fromCodePoint(cp)}everything${String.fromCodePoint(0x2069)}`;
      expect(messageTextHazard(text)).toBe("hidden-characters");
      const [line] = displayExcerpt(text, 1, 400).lines;
      expect(line).toContain("�");
    },
  );
});
