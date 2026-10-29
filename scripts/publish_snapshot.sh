#!/usr/bin/env bash
# The public repository (github.com/kmbenjel/musammi) is a curated copy of this one, not its history: each run
# commits HEAD's tree minus the private paths below onto the local branch `public` (the working tree is not
# touched). It refuses if a private path or a secret would go out. Nothing is pushed.
#
#   scripts/publish_snapshot.sh "commit message"
#   git push <public remote> public:main        # after checking, by hand
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
msg=${1:?usage: scripts/publish_snapshot.sh "commit message"}

# Kept out of the public repository (see THIRD_PARTY.md):
PRIVATE=(
  HANDOFF.md                      # the owner's working notes: own sessions, laptop setup
  scripts/pull_sessions.mjs       # copies the owner's sessions from KV to the laptop
  data/tafsir                     # Ibn Juzay, 2018 edition: no licence to redistribute it
  client/public/tafsir/ibn_juzay
  Dockerfile                      # obsolete: the app runs on Cloudflare
  test/live_check.ts              # development harness tied to the owner's machine and recordings
)
NAME=${PUBLIC_AUTHOR_NAME:-Khalid Benjelloun}
EMAIL=${PUBLIC_AUTHOR_EMAIL:-14932601+kmbenjel@users.noreply.github.com}
# the secrets to look for: this checkout's .env, or the main checkout's (worktrees have none)
ENV_FILE=${ENV_FILE:-.env}
[ -f "$ENV_FILE" ] || ENV_FILE="$(git worktree list --porcelain | sed -n '1s/^worktree //p')/.env"

index=$(mktemp)
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE=$index git read-tree HEAD
GIT_INDEX_FILE=$index git rm -r -q --cached --ignore-unmatch -- "${PRIVATE[@]}"
tree=$(GIT_INDEX_FILE=$index git write-tree)

fail() { echo "publish_snapshot: $*" >&2; exit 1; }
leaked=$(git ls-tree -r --name-only "$tree" |
  grep -E '^(\.env|\.dev\.vars|sessions|archive|briefs|certs)(/|$)|^HANDOFF\.md$|^data/tafsir/|^client/public/tafsir/ibn_juzay/' || true)
[ -z "$leaked" ] || fail "private paths in the tree: $leaked"
if [ -f "$ENV_FILE" ]; then
  for var in GEMINI_API_KEY ACCESS_KEY; do
    val=$(sed -n "s/^$var=//p" "$ENV_FILE" | tr -d "\"' \r")
    if [ -n "$val" ] && git grep -qF -e "$val" "$tree"; then fail "the value of $var is in the tree"; fi
  done
else
  echo "publish_snapshot: no .env found, only the key pattern is checked" >&2
fi
if git grep -qE -e 'AIza[0-9A-Za-z_-]{35}' "$tree"; then fail "a Google API key is in the tree"; fi

parent=$(git rev-parse -q --verify refs/heads/public || true)
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "public is already up to date ($parent)"
  exit 0
fi
commit=$(GIT_AUTHOR_NAME=$NAME GIT_AUTHOR_EMAIL=$EMAIL GIT_COMMITTER_NAME=$NAME GIT_COMMITTER_EMAIL=$EMAIL \
  git commit-tree "$tree" ${parent:+-p "$parent"} -m "$msg")
git update-ref refs/heads/public "$commit" ${parent:+"$parent"}
echo "public → $commit: $(git ls-tree -r --name-only "$tree" | wc -l) files, from $(git rev-parse --short HEAD)"
