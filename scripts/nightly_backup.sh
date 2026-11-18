#!/usr/bin/env bash
# Nightly database backup (run from the server's crontab at 22:00, from the production checkout):
#   1. pg_dump of the yoratrader database (compressed custom format) into <repo>/backup/
#   2. checked: the dump must list table data
#   3. a copy on the T7 drive (/mnt/t7/yoratrader-backup/), verified by checksum
#   4. only the 7 newest dumps kept in each place
#   5. the result written to app_settings (BACKUP_STATUS, JSON), which the Settings page shows
# Credentials come from the production docker/.env (the database is reached on 127.0.0.1 from the host).
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL="$REPO/backup"
T7="/mnt/t7/yoratrader-backup"
KEEP=7
mkdir -p "$LOCAL"
ENVFILE="$REPO/docker/.env"            # production
[ -f "$ENVFILE" ] || ENVFILE="$REPO/backend/.env"   # a dev checkout
set -a
. "$ENVFILE"
set +a
export PGHOST=127.0.0.1 PGPORT="${POSTGRES_PORT:-5432}" PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" PGDATABASE="$POSTGRES_DB"

started=$(date +%s)
stamp=$(date +%Y-%m-%d-%H%M)
name="yoratrader-$stamp.dump"
ok=true error="" tables=0 t7="not copied"

if pg_dump -Fc -f "$LOCAL/$name.part"; then
  mv "$LOCAL/$name.part" "$LOCAL/$name"
  tables=$(pg_restore -l "$LOCAL/$name" | grep -c "TABLE DATA" || true)
  if [ "$tables" -lt 1 ]; then ok=false; error="the dump lists no table data"; fi
else
  ok=false; error="pg_dump failed"; rm -f "$LOCAL/$name.part"
fi

if $ok; then
  if [ -d /mnt/t7 ] && mkdir -p "$T7" 2>/dev/null && cp "$LOCAL/$name" "$T7/$name.part"; then
    if [ "$(sha256sum < "$LOCAL/$name")" = "$(sha256sum < "$T7/$name.part")" ]; then
      mv "$T7/$name.part" "$T7/$name"; t7="copied and verified"
    else
      rm -f "$T7/$name.part"; t7="copy failed the checksum"
    fi
  else
    t7="T7 drive not available"
  fi
fi

# keep the newest $KEEP dumps in each place
for dir in "$LOCAL" "$T7"; do
  [ -d "$dir" ] && ls -1t "$dir"/yoratrader-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
done

seconds=$(( $(date +%s) - started ))
status=$(OK=$ok ERR="$error" NAME="$name" TABLES="$tables" T7S="$t7" SECS="$seconds" LOCALDIR="$LOCAL" T7DIR="$T7" KEEPN="$KEEP" python3 - <<'PY'
import json, os, glob, datetime
def files(d):
    out = []
    for p in sorted(glob.glob(os.path.join(d, "yoratrader-*.dump")), reverse=True):
        st = os.stat(p)
        out.append({"name": os.path.basename(p), "bytes": st.st_size,
                    "at": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="minutes")})
    return out
print(json.dumps({
    "ran_at": datetime.datetime.now().isoformat(timespec="minutes"), "ok": os.environ["OK"] == "true",
    "error": os.environ["ERR"] or None, "file": os.environ["NAME"], "tables": int(os.environ["TABLES"] or 0),
    "seconds": int(os.environ["SECS"]), "t7": os.environ["T7S"], "keep": int(os.environ["KEEPN"]),
    "local_dir": os.environ["LOCALDIR"], "t7_dir": os.environ["T7DIR"],
    "local": files(os.environ["LOCALDIR"]), "t7_files": files(os.environ["T7DIR"]) if os.path.isdir(os.environ["T7DIR"]) else [],
}))
PY
)
psql -q -v ON_ERROR_STOP=1 -v v="$status" <<'SQL'
INSERT INTO app_settings (key, value) VALUES ('BACKUP_STATUS', :'v')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
SQL
echo "$(date '+%F %T') backup $name ok=$ok tables=$tables t7=$t7 ${seconds}s ${error}"
