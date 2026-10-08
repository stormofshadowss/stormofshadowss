#!/bin/sh
# Periodic MariaDB backup. Runs forever by default (the "backup" service); with ONCE=1 it takes one backup and exits:
#   docker compose run --rm -e ONCE=1 backup
set -eu

UP="${UPLOADS_SRC:-/uploads}"
HOST="${DB_HOST:-db}"; NAME="${DB_NAME:?DB_NAME not set}"; USER="${DB_USER:?DB_USER not set}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"; EVERY_HOURS="${BACKUP_EVERY_HOURS:-24}"; DIR="${BACKUP_DIR:-/backups}"

mkdir -p "$DIR"
# Credentials go in a private file, not on the command line (where `ps` could show them).
CNF="$(mktemp)"; chmod 600 "$CNF"; trap 'rm -f "$CNF"' EXIT
printf '[client]\nhost=%s\nuser=%s\npassword=%s\n' "$HOST" "$USER" "$DB_PASSWORD" > "$CNF"

backup_once() {
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  out="$DIR/sos-$stamp.sql.gz"
  raw="$DIR/.sos-$stamp.sql.partial"
  # Dump to a plain file first and CHECK it: in a shell pipeline only the last command's failure
  # counts, so `dump | gzip` would happily report success (and keep an empty file) if the dump failed.
  # A finished mariadb-dump always ends with a "-- Dump completed" line; no line, no backup.
  # --single-transaction = a consistent snapshot without locking the site while it runs.
  if mariadb-dump --defaults-extra-file="$CNF" --single-transaction --routines --events "$NAME" > "$raw" \
     && tail -n 1 "$raw" | grep -q '^-- Dump completed' \
     && gzip -c "$raw" > "$out.tmp" && [ -s "$out.tmp" ]; then
    mv "$out.tmp" "$out"; rm -f "$raw"
    echo "backup ok: $out ($(wc -c < "$out") bytes)"
  else
    rm -f "$raw" "$out.tmp"
    echo "backup FAILED — nothing was saved, and no old backups were deleted" >&2
    return 1
  fi
  # Only reached after a SUCCESSFUL backup, so a run of failures can never eat your good ones.
  find "$DIR" -name 'sos-*.sql.gz' -type f -mtime +"$KEEP_DAYS" -delete
  backup_pictures
}

# The uploaded pictures are not in the database, so they get their own archive alongside it. Nothing to do until the first picture is uploaded.
backup_pictures() {
  [ -d "$UP" ] && [ -n "$(ls -A "$UP" 2>/dev/null)" ] || return 0
  pic="$DIR/pictures-$stamp.tar.gz"
  if tar -C "$UP" -czf "$pic.tmp" . && [ -s "$pic.tmp" ]; then
    mv "$pic.tmp" "$pic"
    echo "pictures backup ok: $pic ($(wc -c < "$pic") bytes)"
  else
    rm -f "$pic.tmp"
    echo "pictures backup FAILED — the database backup above is fine, and no old picture backups were deleted" >&2
    return 1
  fi
  find "$DIR" -name 'pictures-*.tar.gz' -type f -mtime +"$KEEP_DAYS" -delete
}

if [ "${ONCE:-0}" = "1" ]; then backup_once; exit $?; fi
while true; do
  backup_once || true
  sleep $((EVERY_HOURS * 3600))
done
