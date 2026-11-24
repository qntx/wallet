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

## Session-approval prompts (value-moving schemes)

`hyperliquid-l1-agent` create/open approvals are kernel-rendered prompt text
(`modules/sessions/schemes/hyperliquid-l1-agent/prompt.ts`). On a keystore host
whose vault holds a `device` factor (app lock off), `sessions.create` and
`sessions.open` must answer `app-lock-required` before any prompt.

- [ ] iOS — Touch ID / passcode sheet: create a session with the worst-case
      limits (16 five-digit asset ids, max-length notional, 16-char agent
      name); confirm the agent name, scope, deadline, budget, leverage cap and
      asset lines are all visible in both locales.
- [ ] iOS — Face ID device: confirm no kernel text is shown; approval is
      presence-only.
- [ ] Android: same worst-case prompt — confirm the bound (title ≤ 60,
      description ≤ 12 lines / 640 code points) is not clipped.
- [ ] Both platforms, app lock off (`device` factor present): create and open
      answer `app-lock-required` with no prompt; with the app lock on, open
      restates the remaining budget.
- [ ] After lock/unlock, `sessions.sign` on an unopened session answers
      `approval-required`; after the user opens it, signing proceeds within the
      approved limits and out-of-bounds actions answer `limit-exceeded`.

## Secure input fields

The kernel secure input (`SecureInput`, `@qntx/wallet-native/secure-input`)
serves the backup password (kernel `backup.*` commands) and the card
access-code/short-id fields.

- [ ] iOS: password fields are masked (`secureTextEntry`), autocorrection /
      spell-check / smart-quotes / smart-dashes off; the backup-password field
      shows the default keyboard, others ASCII-capable
      (`SecureInputIos.mm:133-143`).
- [ ] Android: backup-password and access-code fields mask every character
      (dot transformation, never reveal-last-char), `NO_SUGGESTIONS` input
      type, autofill excluded, `IME_FLAG_NO_PERSONALIZED_LEARNING`,
      `IME_ACTION_DONE` (`SecureInputField.kt:114-294`).
- [ ] Both platforms: the field is editable only while a kernel
      `secureInput.request` is pending; it takes focus and raises the keyboard
      on that request; the main runtime receives only
      `idle|empty|filled|submitted` — no characters, length or hash.
- [ ] Enable-backup asks the new password twice; a mismatch or a sub-policy
      entry re-asks with the reason in the label (three rounds max); a restore
      entry that fails unwrap answers `wrong-password`.
