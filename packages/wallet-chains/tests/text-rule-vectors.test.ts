/**
 * Vectors/chains/text-rule.json (scripts/vectors/text-rule.ts): every RGI sequence of the pinned
 * emoji-sequences.txt and emoji-zwj-sequences.txt plus cited multilingual samples is ordinary text
 * — no hazard, displayed unchanged; the review's attack set is `hidden-characters`; format
 * characters outside their context carry no hazard but display as U+FFFD.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { displayExcerpt } from "../src/display.ts";
import { messageTextHazard } from "../src/index.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/text-rule.json"), "utf8"),
) as {
  readonly source: ReadonlyArray<string>;
  readonly text: ReadonlyArray<{ name: string; text: string; source: string }>;
  readonly hidden: ReadonlyArray<{ name: string; text: string }>;
  readonly visible: ReadonlyArray<{ name: string; text: string; display: string }>;
};

describe("text-rule vectors", () => {
  it("cites the pinned UCD sources", () => {
    expect(vectors.source).toStrictEqual([
      "https://www.unicode.org/Public/18.0.0/emoji/emoji-sequences.txt",
      "https://www.unicode.org/Public/18.0.0/emoji/emoji-zwj-sequences.txt",
    ]);
    expect(vectors.text.length).toBeGreaterThan(0);
    expect(vectors.hidden.length).toBeGreaterThan(0);
    expect(vectors.visible.length).toBeGreaterThan(0);
  });

  it.each(vectors.text)("$name carries no hazard and displays unchanged", ({ text }) => {
    expect(messageTextHazard(text)).toBeUndefined();
    const excerpt = displayExcerpt(text, 10, 400);
    expect(excerpt.lines).toStrictEqual([text]);
    expect(excerpt.omitted).toBe(0);
  });

  it.each(vectors.hidden)("$name is hidden-characters", ({ text }) => {
    expect(messageTextHazard(text)).toBe("hidden-characters");
  });

  it.each(vectors.visible)("$name displays the mark as U+FFFD", ({ text, display }) => {
    expect(messageTextHazard(text)).toBeUndefined();
    expect(displayExcerpt(text, 10, 400).lines).toStrictEqual([display]);
  });
});
