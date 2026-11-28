#!/usr/bin/env bash
# Applies the repository's protection as code: the rulesets in this directory and the deployment
# environments (staging and production for the gateway, npm for releases). Idempotent; needs `gh`
# authenticated as a repository admin. The npm side and the settings no API can change are in
# README.md next to this script.
#
#   .github/rulesets/apply.sh <reviewer-login> [<reviewer-login>...]
#
# With two or more reviewers the person who starts a staging, production or npm job may not
# approve it. With one — a single maintainer — that person approves their own job: the approval
# is a deliberate second step, not a second person (README.md, "Single maintainer"). Staging and
# production share one Cloudflare account and a Workers token is account-wide, so a staging token
# can replace production — that is why staging carries the same reviewers; each environment's
# token is an account API token of that account (apps/gateway/README.md):
#   gh secret set CLOUDFLARE_API_TOKEN --env staging
#   gh secret set CLOUDFLARE_API_TOKEN --env production
# and deployments start once `gh variable set GATEWAY_DEPLOY --body true` is set.
set -euo pipefail

repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
if [ "$#" -lt 1 ]; then
  echo "usage: apply.sh <reviewer-login> [<reviewer-login>...]" >&2
  exit 2
fi
# A lone reviewer who could not approve their own job could never release.
if [ "$#" -ge 2 ]; then self_review=true; else self_review=false; fi
reviewers="$(for login in "$@"; do gh api "users/${login}" --jq '{type: "User", id: .id}'; done | jq -s -c .)"
here="$(cd "$(dirname "$0")" && pwd)"
manual=()

for file in "${here}"/*.json; do
  name="$(jq -r .name "${file}")"
  id="$(gh api "repos/${repo}/rulesets" --jq ".[] | select(.name == \"${name}\") | .id")"
  if [ -z "${id}" ]; then
    gh api --method POST "repos/${repo}/rulesets" --input "${file}" --jq '"created ruleset \(.name)"'
  else
    gh api --method PUT "repos/${repo}/rulesets/${id}" --input "${file}" --jq '"updated ruleset \(.name)"'
  fi
done

# environment <name> <reviewers-json> <prevent-self-review> <policy-type> <policy-pattern>
environment() {
  local name="$1" env_reviewers="$2" self_review="$3" type="$4" pattern="$5"
  jq -n --argjson reviewers "${env_reviewers}" --argjson prevent "${self_review}" '{
    reviewers: $reviewers,
    prevent_self_review: $prevent,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  }' | gh api --method PUT "repos/${repo}/environments/${name}" --input - --jq '"configured environment \(.name)"'
  # Exactly one deployment policy: any other ref an earlier setup allowed is removed. The list is
  # read whole before it is matched, so no pipe can end early under pipefail.
  local policies found=false id kind policy
  policies="$(gh api --paginate "repos/${repo}/environments/${name}/deployment-branch-policies" \
    --jq '.branch_policies[] | "\(.id) \(.type) \(.name)"')"
  while read -r id kind policy; do
    if [ -z "${id}" ]; then
      continue
    fi
    if [ "${kind}" = "${type}" ] && [ "${policy}" = "${pattern}" ]; then
      found=true
    else
      gh api --method DELETE \
        "repos/${repo}/environments/${name}/deployment-branch-policies/${id}" --silent
      echo "removed ${kind} policy ${policy} from environment ${name}"
    fi
  done <<<"${policies}"
  if [ "${found}" = false ]; then
    gh api --method POST "repos/${repo}/environments/${name}/deployment-branch-policies" \
      -f name="${pattern}" -f type="${type}" --silent
  fi
  # The REST API cannot change "Allow administrators to bypass configured protection rules".
  if [ "$(gh api "repos/${repo}/environments/${name}" --jq .can_admins_bypass)" != "false" ]; then
    manual+=("Settings → Environments → ${name}: clear \"Allow administrators to bypass configured protection rules\"")
  fi
}
environment staging "${reviewers}" "${self_review}" branch main
environment production "${reviewers}" "${self_review}" branch main
environment npm "${reviewers}" "${self_review}" tag 'v*.*.*'

# Environment secrets are readable only by jobs in their environment; a repository or organization
# secret of the same name would reach every job, staging's included.
shared="$({
  gh api "repos/${repo}/actions/secrets" --paginate --jq '.secrets[].name'
  gh api "repos/${repo}/actions/organization-secrets" --paginate --jq '.secrets[].name'
} | grep -x 'CLOUDFLARE_API_TOKEN' || true)"
if [ -n "${shared}" ]; then
  manual+=("delete the repository or organization secret CLOUDFLARE_API_TOKEN; it must exist only per environment")
fi

gh api --method PATCH "repos/${repo}" -F delete_branch_on_merge=true --silent

if [ "${#manual[@]}" -gt 0 ]; then
  printf 'not done — finish by hand, then rerun:\n' >&2
  printf '  - %s\n' "${manual[@]}" >&2
  exit 1
fi
echo "done"
