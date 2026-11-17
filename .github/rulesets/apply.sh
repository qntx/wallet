#!/usr/bin/env bash
# Applies the repository's protection as code: the rulesets in this directory and the two gateway
# deployment environments. Idempotent; needs `gh` authenticated as a repository admin.
#
#   .github/rulesets/apply.sh <production-reviewer-login>
#
# The Cloudflare API token of each environment is a secret only its owner can create:
#   gh secret set CLOUDFLARE_API_TOKEN --env staging
#   gh secret set CLOUDFLARE_API_TOKEN --env production
# and deployments start once `gh variable set GATEWAY_DEPLOY --body true` is set.
set -euo pipefail

repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
reviewer="${1:?usage: apply.sh <production-reviewer-login>}"
reviewer_id="$(gh api "users/${reviewer}" --jq .id)"
here="$(cd "$(dirname "$0")" && pwd)"

for file in "${here}"/*.json; do
  name="$(jq -r .name "${file}")"
  id="$(gh api "repos/${repo}/rulesets" --jq ".[] | select(.name == \"${name}\") | .id")"
  if [ -z "${id}" ]; then
    gh api --method POST "repos/${repo}/rulesets" --input "${file}" --jq '"created ruleset \(.name)"'
  else
    gh api --method PUT "repos/${repo}/rulesets/${id}" --input "${file}" --jq '"updated ruleset \(.name)"'
  fi
done

# Deployments come from main only; production also waits for a reviewer.
environment() {
  local name="$1" reviewers="$2"
  jq -n --argjson reviewers "${reviewers}" '{
    reviewers: $reviewers,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  }' | gh api --method PUT "repos/${repo}/environments/${name}" --input - --jq '"configured environment \(.name)"'
  if ! gh api "repos/${repo}/environments/${name}/deployment-branch-policies" \
    --jq '.branch_policies[].name' | grep -qx main; then
    gh api --method POST "repos/${repo}/environments/${name}/deployment-branch-policies" \
      -f name=main -f type=branch --silent
  fi
}
environment staging '[]'
environment production "[{\"type\":\"User\",\"id\":${reviewer_id}}]"

gh api --method PATCH "repos/${repo}" -F delete_branch_on_merge=true --silent
echo "done"
