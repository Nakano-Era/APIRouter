#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$project_dir"
if [[ ! -f .env ]]; then printf '%s\n' '找不到 .env，请先部署站点。' >&2; exit 1; fi
docker compose config --quiet
if [[ -z "$(docker compose ps -a -q app)" ]]; then printf '%s\n' '找不到应用容器，请先部署站点。' >&2; exit 1; fi
backup_dir="$project_dir/backups"
mkdir -p -- "$backup_dir"
backup_dir="$(cd -- "$backup_dir" && pwd -P)"
if [[ "$backup_dir" != "$project_dir/backups" ]]; then printf '%s\n' 'backups 目录不能是指向项目外的链接。' >&2; exit 1; fi
chmod 700 "$backup_dir"
stage="$(mktemp -d "$backup_dir/.backup-XXXXXXXX")"
archive="$backup_dir/apirouter-$(date -u +%Y%m%dT%H%M%SZ)-${stage##*-}.tar.gz"
was_running=0
if [[ -n "$(docker compose ps --status running -q app)" ]]; then was_running=1; fi
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$was_running" == 1 ]]; then docker compose start app >/dev/null || printf '%s\n' '应用未自动重启，请执行 docker compose start app。' >&2; fi
  if [[ "$stage" == "$backup_dir"/.backup-* && -d "$stage" ]]; then rm -rf -- "$stage"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
printf '%s\n' '暂时停止应用以备份一致的 SQLite、附件与加密密钥。'
docker compose stop app
mkdir "$stage/data"
docker compose cp app:/app/data/. "$stage/data/"
cp -- .env "$stage/deployment.env"
printf 'APIRouter backup v1\nUTC=%s\n' "$(date -u +%FT%TZ)" > "$stage/backup-info.txt"
tar -C "$stage" -czf "$archive" data deployment.env backup-info.txt
chmod 600 "$archive"
printf '备份完成：%s\n请把备份另存到 VPS 之外；其中包含聊天记录、附件与解密 API Key 所需的密钥。\n' "$archive"
