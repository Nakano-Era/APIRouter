#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ ! -f compose.yaml || ! -f runner/Dockerfile ]]; then
  echo '请在完整 APIRouter 项目中运行此脚本。' >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo '请先按照 VPS 部署指南运行 deploy.sh，生成域名配置。' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo 'Docker 尚未运行或当前账号无权限，请启动 Docker 后以 sudo 重新运行。' >&2
  exit 1
fi
docker compose version >/dev/null
umask 077
if ! grep -Eq '^WORK_RUNNER_TOKEN=.{32,}$' .env; then
  if grep -Eq '^WORK_RUNNER_TOKEN=' .env; then
    echo '.env 中已有但无效的 WORK_RUNNER_TOKEN；请设为至少 32 个随机字符后重试。' >&2
    exit 1
  fi
  token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  printf '\nWORK_RUNNER_TOKEN=%s\n' "$token" >> .env
  unset token
fi
if grep -Eq '^COMPOSE_FILE=' .env; then
  if ! grep -Eq '^COMPOSE_FILE=compose.yaml:compose.work.yaml$' .env; then
    echo '已有自定义 COMPOSE_FILE，请将 compose.work.yaml 加入组合后手动部署；脚本未覆盖现有设置。' >&2
    exit 1
  fi
else
  printf '\nCOMPOSE_FILE=compose.yaml:compose.work.yaml\n' >> .env
fi
chmod 600 .env
echo '正在构建 Claude Code 沙箱镜像，首次需要下载运行环境。'
docker build --file runner/Dockerfile --target worker --tag apirouter-work:local .
docker compose -f compose.yaml -f compose.work.yaml up -d --build --wait
echo 'Work 执行器已启用。请在管理后台测试 Anthropic 渠道，再选择 Work 模式运行任务。'
