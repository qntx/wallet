# Device checklist — system prompt bounds

`PROMPT_BOUNDS` in `packages/wallet-kernel/src/prompts.ts` is a policy table: neither OS documents
how much text its verification dialog shows. This checklist is how the values are confirmed or
lowered on real devices — never raised without a passing measurement on every listed row.

Current values:

| platform | title (code points) | description lines | description code points |
| -------- | ------------------- | ----------------- | ----------------------- |
| ios      | — (not shown)       | 8                 | 400                     |
| android  | 60                  | 12                | 640                     |

## Procedure

For each row, build a prompt of `bound` lines where line _i_ is `line i: ` followed by `x`s,
send it to `keystore.authenticate` (or a `presence` seal/open), and record whether the last line
is fully visible without scrolling. Repeat at `bound + 1` to confirm the cliff, and with CJK text
and emoji to confirm the platform measures code points/glyphs rather than UTF-16 units.

- [ ] iOS — Face ID device (any current iPhone except SE): `localizedReason` is **not shown at
      all** — confirm nothing but the passcode fallback displays text.
- [ ] iOS — Touch ID / passcode sheet (iPhone SE, or Face ID cancelled to passcode): record the
      last fully visible line count and code points for a 400-character 8-line description.
- [ ] Android 11–16, stock (Pixel): BiometricPrompt — record visible title/description limits.
- [ ] Android OEM skins: Samsung One UI, Xiaomi MIUI/HyperOS, Oppo ColorOS — the same.

## Rules after measuring

- A row that shows less than the table claims → lower the table to the smallest observed value.
- The kernel truncates before handing text to the OS; never rely on the dialog's own ellipsizing.
