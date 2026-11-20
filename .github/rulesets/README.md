# Repository protection

What a workflow file can enforce, and what only the repository and npm settings can. Anyone with
write access can push a branch whose copy of a workflow says anything: GitHub runs the definition
from the ref that triggered it, so `if:`, `needs:` and verification steps bind only an unmodified
file. The settings below are evaluated by GitHub and npm themselves and are what stop a writer — or
a leaked token with `contents: write` — from publishing.

## Release path

A `vX.Y.Z` tag on a reviewed `main` commit runs `.github/workflows/publish-npm.yml`:

1. `verify` (no secrets): the tag is `vX.Y.Z`, the commit is an ancestor of `main`, CI passed on a
   `main` push of that commit, and every published package carries the tag's version.
2. `pack` (no token): install, build, `check:pkg`, `bun pm pack`, upload the tarball.
3. `publish`, in the environment `npm`: download the tarball and `npm publish --provenance`. This is
   the only job with `id-token: write`.

| Guarantee                                                          | Enforced by                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| npm accepts a publish only from `publish-npm.yml` in `qntx/wallet` | npm Trusted Publisher: repository + workflow filename                                 |
| …and only from a job running in the environment `npm`              | npm Trusted Publisher: **Environment name `npm`** (the OIDC `environment` claim)      |
| A job enters `npm` only from a `v*.*.*` tag, never from a branch   | GitHub environment `npm`: deployment policy = tag `v*.*.*` only                       |
| Two people release: someone other than the tagger approves         | GitHub environment `npm`: 2+ required reviewers, prevent self-review, no admin bypass |
| Only admins create, move or delete release tags                    | Ruleset `release tags` (`release-tags.json`)                                          |
| The tagged commit was reviewed and passed CI                       | Ruleset `main` (`main.json`) + `verify`                                               |
| No long-lived token can publish around the workflow                | npm package setting: require 2FA and disallow tokens                                  |

Without the environment on the Trusted Publisher, a branch copy of `publish-npm.yml` that drops
`environment:` and `verify` gets an OIDC token npm accepts: the Trusted Publisher has no branch or
tag field. With it, the branch copy must name `environment: npm`, and GitHub refuses to start the
job on a branch ref before any token exists.

## npm (per package)

For each of `@qntx/wallet`, `@qntx/wallet-worker`, `@qntx/wallet-chains`, `@qntx/wallet-engine` and
`@qntx/wallet-native` on npmjs.com → package → Settings:

1. **Trusted Publisher → GitHub Actions**. An existing connection cannot be edited: delete every
   connection for this repository that has no environment, then add:
   - Organization or user: `qntx`
   - Repository: `wallet`
   - Workflow filename: `publish-npm.yml`
   - Environment name: `npm`
   - Allowed actions: `npm publish` (or leave it stage-only, see below)
2. **Publishing access**: "Require two-factor authentication and disallow tokens".
3. Revoke any automation or granular token that can publish the package.

Stage-only (optional, stronger): allow only `npm stage publish` on the Trusted Publisher and change
the `publish` step to `npm stage publish`. Every release then also needs a maintainer to approve the
staged version on npmjs.com with 2FA.

## GitHub

Run as a repository admin, with two or more reviewer logins:

```bash
.github/rulesets/apply.sh <reviewer-login> <reviewer-login>
```

It creates or updates the rulesets `main` and `release tags`, and configures the environments:

| Environment  | Reviewers        | Prevent self-review | Deployment policy (the only one) |
| ------------ | ---------------- | ------------------- | -------------------------------- |
| `staging`    | none             | —                   | branch `main`                    |
| `production` | the given logins | yes                 | branch `main`                    |
| `npm`        | the given logins | yes                 | tag `v*.*.*`                     |

Any other deployment policy an environment already has is deleted. Then, by hand (the REST API
cannot set it), for `production` and `npm`: Settings → Environments → clear **Allow administrators
to bypass configured protection rules**. `apply.sh` exits non-zero until that is done; rerun it.

Check the result:

```bash
gh api repos/qntx/wallet/rulesets --jq '.[].name'
gh api repos/qntx/wallet/environments/npm \
  --jq '{can_admins_bypass, rules: [.protection_rules[] | {type, prevent_self_review, reviewers: [.reviewers[]?.reviewer.login]}], policy: .deployment_branch_policy}'
gh api repos/qntx/wallet/environments/npm/deployment-branch-policies --jq '.branch_policies[] | {type, name}'
```

Expected for `npm`: `can_admins_bypass: false`, one `required_reviewers` rule with
`prevent_self_review: true` and two or more reviewers, `custom_branch_policies: true`, and exactly
one policy `{type: "tag", name: "v*.*.*"}`.
