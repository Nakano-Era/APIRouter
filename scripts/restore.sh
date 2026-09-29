#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$project_dir"
if [[ "$#" -ne 1 || ! -f "$1" ]]; then printf '%s\n' '用法：sudo bash scripts/restore.sh /绝对路径/apirouter-日期.tar.gz' >&2; exit 1; fi
archive="$(realpath -- "$1")"
if [[ "$archive" != /* || "$archive" != *.tar.gz ]]; then printf '%s\n' '请选择有效的 .tar.gz 备份绝对路径。' >&2; exit 1; fi
if [[ ! -f .env ]]; then printf '%s\n' '请先用 deploy.sh 完成空站部署，再执行恢复。' >&2; exit 1; fi
docker compose config --quiet
if [[ -z "$(docker compose ps -a -q app)" ]]; then printf '%s\n' '请先完成站点部署。' >&2; exit 1; fi
printf '准备恢复备份：%s\n当前站点数据将替换为备份内容，域名 .env 保持不变；替换前会自动备份当前数据。\n' "$archive"
read -r -p '确认恢复请输入 RESTORE：' confirmation
if [[ "$confirmation" != RESTORE ]]; then printf '%s\n' '已取消，未修改数据。'; exit 0; fi

backup_dir="$project_dir/backups"
mkdir -p -- "$backup_dir"
backup_dir="$(cd -- "$backup_dir" && pwd -P)"
if [[ "$backup_dir" != "$project_dir/backups" ]]; then printf '%s\n' 'backups 目录不能是指向项目外的链接。' >&2; exit 1; fi
chmod 700 "$backup_dir"
stage="$(mktemp -d "$backup_dir/.restore-XXXXXXXX")"
stopped=0
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$stopped" == 1 ]]; then docker compose start app >/dev/null || true; fi
  if [[ "$stage" == "$backup_dir"/.restore-* && -d "$stage" ]]; then rm -rf -- "$stage"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Reject traversal, links and special files before extracting a supplied archive.
tar -tzf "$archive" > "$stage/entries.txt"
tar -tvzf "$archive" > "$stage/types.txt"
while IFS= read -r entry; do
  case "$entry" in
    data|data/|data/*|deployment.env|backup-info.txt) ;;
    *) printf '%s\n' '备份包含非预期路径，已停止恢复。' >&2; exit 1 ;;
  esac
  # tar lists directories with a trailing slash; remove exactly that one slash
  # before checking separators so data/ is valid but data// remains invalid.
  checked_entry="${entry%/}"
  case "/$checked_entry/" in
    *'/../'*|*'/./'*|*'//'*) printf '%s\n' '备份包含不安全路径，已停止恢复。' >&2; exit 1 ;;
  esac
done < "$stage/entries.txt"
if LC_ALL=C grep -q '^[^-d]' "$stage/types.txt"; then printf '%s\n' '备份含链接或特殊文件，已停止恢复。' >&2; exit 1; fi
tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage"
if [[ ! -f "$stage/data/app.sqlite" || ! -f "$stage/data/master.key" || "$(wc -c < "$stage/data/master.key")" -ne 32 ]]; then
  printf '%s\n' '备份缺少数据库或有效 master.key，已停止恢复。' >&2
  exit 1
fi
# The enclosing backups directory stays 0700. The temporary bind-mounted tree
# needs read permission for the unprivileged node user inside the container.
find "$stage/data" -type d -exec chmod 755 {} +
find "$stage/data" -type f -exec chmod 644 {} +

bash "$project_dir/scripts/backup.sh"
docker compose stop app
stopped=1
docker compose run --rm --no-deps -T --entrypoint node \
  --volume "$stage/data:/restore:ro" app --input-type=module -e '
import { realpathSync, readdirSync, mkdirSync, mkdtempSync, existsSync, renameSync, cpSync, chmodSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const destination = realpathSync("/app/data");
const source = realpathSync("/restore");
if (destination !== "/app/data" || source !== "/restore") throw new Error("恢复路径检查失败");
// A closed WAL database can still need to create -wal/-shm while being read.
// Verify a private writable copy before moving any existing application data.
// Keep it on the data volume: databases may exceed the 128MB /tmp limit.
const verification = mkdtempSync(join(destination, ".verify-restore-"));
let verificationDB;
try {
  for (const name of ["app.sqlite", "app.sqlite-wal", "app.sqlite-shm", "app.sqlite-journal"]) {
    if (existsSync(join(source, name))) cpSync(join(source, name), join(verification, name), { force: false, errorOnExist: true });
  }
  verificationDB = new DatabaseSync(join(verification, "app.sqlite"), { readOnly: true });
  const integrity = verificationDB.prepare("PRAGMA quick_check").get();
  if (Object.values(integrity)[0] !== "ok") throw new Error("备份数据库完整性检查未通过");
} finally {
  try { verificationDB?.close(); }
  finally { rmSync(verification, { recursive: true, force: true }); }
}
const recovery = join(destination, `.before-restore-${Date.now()}`);
mkdirSync(recovery, { mode: 0o700 });
const originalNames = readdirSync(destination).filter(name => join(destination, name) !== recovery);
for (const name of originalNames) renameSync(join(destination, name), join(recovery, name));
const secure = (location) => {
  const directory = statSync(location).isDirectory();
  chmodSync(location, directory ? 0o700 : 0o600);
  if (directory) for (const name of readdirSync(location)) secure(join(location, name));
};
try {
  for (const name of readdirSync(source)) {
    if (name.startsWith(".before-restore-")) continue;
    cpSync(join(source, name), join(destination, name), { recursive: true, force: false, errorOnExist: true });
    secure(join(destination, name));
  }
} catch (error) {
  for (const name of readdirSync(destination)) if (join(destination, name) !== recovery) rmSync(join(destination, name), { recursive: true, force: true });
  for (const name of originalNames) renameSync(join(recovery, name), join(destination, name));
  throw error;
}
console.log(`恢复完成；原数据另保留在数据卷内 ${recovery}。`);
'
docker compose up -d --wait --wait-timeout 180
stopped=0
printf '%s\n' '恢复成功。请使用备份中的账号登录。域名仍使用当前 .env；旧数据副本占用额外空间，确认无误后可由管理员清理。'
