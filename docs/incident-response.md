# Incident response

What the maintainers do when something goes wrong in a released `@qntx/wallet*` package, in the
gateway, or in the release path itself. Reports arrive through the channels in
[SECURITY.md](../SECURITY.md); this document is the response, not the intake.

## Roles

| Role               | Who                                   | Owns                                                                    |
| ------------------ | ------------------------------------- | ----------------------------------------------------------------------- |
| Incident lead      | the first maintainer who confirms it  | severity, the timeline, every decision below, the final write-up        |
| Release maintainer | an npm maintainer other than the lead | `npm deprecate`, a fixed release, the `npm` environment approval        |
| Gateway operator   | a holder of the production Cloudflare | `wrangler rollback`, secrets rotation, detaching the custom domain      |
|                    | account                               |                                                                         |
| Host contact       | per consuming app (Meowl first)       | shipping the fix to users, in-app notices, the host's own store release |

One person may hold several roles. A release is meant to need two people — the `npm`
environment's reviewers — but that rule is a repository setting the owner applies from
`.github/rulesets/`; until it is applied, assume any repository writer can tag and publish.

## Severity

| Level | Meaning                                                                                     | Response                       |
| ----- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| S1    | funds or secrets can be taken now: a kernel bypass, a signing-key or seed leak, a malicious | start within 1 hour; all hands |
|       | release on npm                                                                              |                                |
| S2    | funds at risk under conditions not yet met in the wild (needs a compromised main runtime, a | start within 1 day             |
|       | specific dApp, an unreleased feature); gateway outage on every provider of a route          |                                |
| S3    | wrong display, privacy leak without funds risk, single-provider gateway degradation         | next release                   |

## Common steps

1. Open a private GitHub security advisory for the repository (Security → Advisories → New draft) —
   never a public issue. Record there: who reported it, when, affected versions and platforms,
   the severity and its reason. Every later step is logged in the advisory.
2. Reproduce on the latest release and on `main`. Keep the proof of concept in the advisory's
   private fork, not on a public branch.
3. Decide the user-facing action (none / update / stop using a feature / move funds) before
   anything is published. Moving funds is advised only when keys may be known to someone else.
4. Fix in the advisory's private fork with a regression test; release through the normal tag path
   (`publish-npm.yml` — tag-only OIDC, no publish tokens; a reviewer's approval once the `npm`
   environment is applied). No out-of-band publish, ever.
5. Publish the advisory with a CVE request once a fixed version is on npm and the host contacts
   have shipped or have a date; credit the reporter unless they declined.
6. Write the post-incident note in the advisory: timeline, root cause, why tests missed it, what
   changes in the process.

## Key compromise

Which key is compromised decides everything.

- **A user's wallet keys** (seed, imported key, session key) through a wallet defect: the user must
  move funds to a new wallet created after the fixed version is installed. The host shows the
  instruction; the advisory says which versions, platforms and wallet kinds are affected. A
  Hyperliquid agent or other session key is revoked by deleting the session (`sessions.delete`)
  and, for Hyperliquid, by approving a replacement agent under the same name (Hyperliquid keeps
  one agent per name).
- **The npm publishing path** (a GitHub admin account, a maintainer's npm account, an OIDC
  misconfiguration that let a branch publish): treat every version published since the earliest
  possible compromise as malicious until its provenance is checked — `npm view <pkg>@<v> dist`
  and the provenance attestation must name `publish-npm.yml` on a `v*.*.*` tag of a `main` commit.
  Rotate: remove the compromised account from the org and the `npm` environment reviewers, delete
  and re-create the npm Trusted Publisher connections, revoke any token listed in npm. Then follow
  "Bad release".
- **Cloudflare / provider secrets** (gateway API keys, the Cloudflare API token): rotate the key at
  the provider, `bunx wrangler secret put <NAME> --env production`, and revoke the old key. The
  gateway holds no user secrets; the exposure is billing and the provider account's rate limits.
- **Card CA keys**: out of scope until card wallets ship; the card design owns that ceremony.

## Bad release

A published version is broken or malicious.

1. Stop the spread: `npm deprecate @qntx/<pkg>@<version> "<one-line reason; upgrade to X>"` for
   every affected package (the release maintainer, with 2FA). Deprecation keeps installs working
   but warns every installer; it is the default.
2. `npm unpublish` only for a malicious version within npm's unpublish window, and only after the
   advisory records why: unpublishing breaks every lockfile that pinned it, and the version number
   can never be reused.
3. Publish the fix as a new patch version through the normal tag path. Never move a tag.
4. `@qntx/wallet-native` ships the kernel bytecode: a host that already built an app store release
   with the bad version needs its own store release. Tell the host contacts which builds are
   affected, with the kernel manifest hash of the bad and the fixed version.
5. If the bad release changed a persisted format, say in the advisory whether downgrading is safe.
   Downgrading below a vault format reads the vault as `unsupported` with `reason: "newer"`
   (data kept, see `MIGRATION.md`); it never wipes it.

## Gateway incident

Signals are the log events in `apps/gateway/README.md` (Observability) and the alert definitions
next to them.

- **Every provider of a route failing** (`all-providers-failed`): check the providers' status pages;
  if the cause is a gateway deploy, `bunx wrangler rollback --env production` (not across a Durable
  Object migration — fix forward then). Wallets keep signing: the gateway serves display data and
  relays; transaction values come from chain RPC.
- **A provider account spent or throttled** (`budget-error`, `upstream-throttled`): confirm with the
  provider console, raise the plan or the budget row in `src/config/accounts.ts` through a reviewed
  PR. Never disable the budget to get traffic through.
- **Suspected gateway compromise** (unexpected deploy, changed secrets, responses that disagree with
  chain data): detach the `gateway.meowl.xyz` custom domain to withdraw the service, rotate the
  Cloudflare token and every provider secret, redeploy from a reviewed `main` commit. A compromised
  gateway can lie about balances, prices and history and can withhold or delay broadcasts; it
  cannot change what the kernel signs (SECURITY.md).

## User notification

The library has no channel to users; the hosts do. The incident lead sends the host contacts:

- what happened, in one paragraph without exploit detail;
- who is affected: versions, platforms (iOS / Android / Web), wallet kinds, features;
- what the user must do: update, stop using a feature, or move funds — and by when;
- the fixed version and, for React Native, whether a store release is needed.

Template for the host's in-app or e-mail notice:

> **Security update for your wallet.** We fixed a problem in `<feature>` that affects
> `<who>`. `<Impact in one sentence, no exploit detail.>` Please `<action>` by `<date>`. Your
> recovery phrase was / was not exposed. Details: `<advisory link>`.

Never ask users for their recovery phrase, password or backup file in a notice, and say so in the
notice itself.
