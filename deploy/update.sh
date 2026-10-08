#!/bin/bash
# Update this server to the latest code on GitHub — safely:  it takes a backup FIRST, and stops before changing anything if that fails.
#
#   bash deploy/update.sh              update to the newest code on the main branch
#   bash deploy/update.sh abc1234      go to one particular version (a commit code, tag or branch) — e.g. to roll back
#
# Run it from anywhere; it works from the folder it lives in. Your .env and your data (DATA_DIR) are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# git: use the server's own if it has one, otherwise a throw-away container that has it (the repo folder is shared with it)
if command -v git >/dev/null 2>&1; then git_() { git "$@"; }
else git_() { docker run --rm -v "$PWD":/git alpine/git -c safe.directory=/git "$@"; }; fi

[ -f .env ] || fail "There's no .env file here. Copy .env.example to .env and fill it in first (see SETUP.md)."
docker compose version >/dev/null 2>&1 || fail "Docker Compose isn't available. On Unraid, install the 'Docker Compose Manager' plugin from Community Applications."

TARGET="${1:-main}"
BEFORE="$(git_ rev-parse --short HEAD)"

# Anything edited on the server would be overwritten, so don't go on if there is some.
if [ -n "$(git_ status --porcelain --untracked-files=no)" ]; then
  fail "Files in this folder have been changed on the server, so an update could overwrite them:
$(git_ status --short --untracked-files=no)
Undo those changes (git checkout -- <file>) and run this again."
fi

say "1/5  Looking for the new version…"
git_ fetch --tags origin >/dev/null
if [ "$TARGET" = "main" ]; then git_ checkout -q main; AFTER="$(git_ rev-parse --short origin/main)"; else AFTER="$(git_ rev-parse --short "$TARGET")" || fail "I can't find '$TARGET'."; fi
if [ "$BEFORE" = "$AFTER" ] && [ "$TARGET" = "main" ] && [ "$(git_ rev-parse --abbrev-ref HEAD)" = "main" ]; then
  echo "Already up to date ($BEFORE). Nothing to do."; exit 0
fi
echo "Going from $BEFORE to $AFTER:"
git_ log --oneline "$BEFORE..$AFTER" 2>/dev/null | head -15 || true
NEW_MIGRATIONS="$(git_ diff --name-only "$BEFORE" "$AFTER" -- db/migrations 2>/dev/null | wc -l | tr -d ' ')"
[ "$NEW_MIGRATIONS" != "0" ] && echo "(This update changes the database layout — $NEW_MIGRATIONS migration file(s). They run automatically on start, which is why a backup comes first.)"

say "2/5  Taking a backup (database and pictures)…"
if docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  docker compose run --rm -e ONCE=1 backup || fail "The backup failed, so I have NOT updated anything. Fix that first (see the messages above)."
else
  echo "The database isn't running, so there's nothing to back up yet (first start?). Carrying on."
fi

say "3/5  Getting the code…"
if [ "$TARGET" = "main" ]; then git_ merge --ff-only -q origin/main; else git_ -c advice.detachedHead=false checkout -q "$TARGET"; fi

say "4/5  Rebuilding and restarting…"
if ! docker compose up -d --build; then
  fail "The rebuild failed. To go back to how it was:  bash deploy/update.sh $BEFORE"
fi

say "5/5  Checking the site came back…"
PORT="$(grep -E '^APP_PORT=' .env | tail -1 | cut -d= -f2 | tr -d '"' || true)"; PORT="${PORT:-3000}"
CHECK=""; command -v curl >/dev/null 2>&1 && CHECK="curl -fsS" || { command -v wget >/dev/null 2>&1 && CHECK="wget -qO-"; }
if [ -z "$CHECK" ]; then echo "(No curl or wget here, so I can't check automatically — open the site and have a look.)"
else
  ok=""; for _ in $(seq 1 30); do if $CHECK "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi; sleep 2; done
  if [ -z "$ok" ]; then
    docker compose logs --tail 30 app || true
    fail "The site didn't come back within a minute. To go back to how it was:  bash deploy/update.sh $BEFORE
(If this update changed the database layout and it won't start, restore the backup — see SETUP.md.)"
  fi
fi
docker image prune -f >/dev/null 2>&1 || true
printf '\n\033[32m✔ Updated to %s (was %s). The site is up.\033[0m\n' "$AFTER" "$BEFORE"
[ "$TARGET" != "main" ] && echo "You're on a fixed version now. To get back on the newest:  bash deploy/update.sh"
exit 0
