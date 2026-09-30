#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$project_dir"
install_docker=0
with_work=0
with_claude_code=0
requested_domain=''

usage() {
  printf '%s\n' '用法：bash deploy.sh [chat.example.com] [--install-docker] [--with-work] [--with-claude-code]' \
    '首次部署：sudo bash deploy.sh chat.example.com --install-docker --with-work' \
    '可选 Claude Code：sudo bash deploy.sh --with-claude-code' \
    '更新部署：sudo bash deploy.sh' \
    '脚本保留已有 .env 与数据卷；不会重置数据库。'
}

for argument in "$@"; do
  case "$argument" in
    --install-docker) install_docker=1 ;;
    --with-work) with_work=1 ;;
    --with-claude-code) with_work=1; with_claude_code=1 ;;
    --help|-h) usage; exit 0 ;;
    --*) printf '未知选项：%s\n' "$argument" >&2; usage; exit 1 ;;
    *)
      if [[ -n "$requested_domain" ]]; then usage; exit 1; fi
      requested_domain="$argument"
      ;;
  esac
done

install_official_docker() {
  if [[ "$EUID" -ne 0 ]]; then printf '%s\n' '安装 Docker 需要 sudo，请使用 sudo bash deploy.sh 域名 --install-docker。' >&2; exit 1; fi
  if [[ ! -f /etc/os-release ]]; then printf '%s\n' '无法识别系统。请按 Docker 官方文档安装 Docker Engine 和 Compose 插件。' >&2; exit 1; fi
  # /etc/os-release is maintained by the operating system, never project input.
  . /etc/os-release
  distro="${ID:-}"
  codename="${VERSION_CODENAME:-}"
  case "$distro:$codename" in
    ubuntu:jammy|ubuntu:noble|ubuntu:resolute|debian:bookworm|debian:trixie) ;;
    *) printf '%s\n' '自动安装仅支持 Ubuntu 22.04/24.04/26.04 或 Debian 12/13。其他系统请按 https://docs.docker.com/engine/install/ 安装后重试。' >&2; exit 1 ;;
  esac
  for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$'; then
      printf '发现已有软件包 %s；请按 Docker 官方文档处理兼容性后重试，脚本不会卸载已有软件。\n' "$package" >&2
      exit 1
    fi
  done
  if [[ -e /etc/apt/sources.list.d/docker.sources || -e /etc/apt/sources.list.d/docker.list ]]; then
    printf '%s\n' '已有 Docker 软件源；请先按官方文档完成安装，脚本不会覆盖现有软件源。' >&2
    exit 1
  fi
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --location "https://download.docker.com/linux/$distro/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$distro
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  chmod 644 /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

if ! command -v docker >/dev/null 2>&1; then
  if [[ "$install_docker" == 1 ]]; then install_official_docker
  else
    printf '%s\n' '尚未安装 Docker。Ubuntu/Debian 可添加 --install-docker 并使用 sudo，或先参照 docs/DEPLOY-VPS.md 安装。' >&2
    exit 1
  fi
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' '缺少 Docker Compose 插件。请安装 docker-compose-plugin 后重试；已有 Docker 不会被脚本替换。' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' '无法连接 Docker。请确认 Docker 已启动，并使用 sudo bash deploy.sh，或用有 Docker 权限的账号执行。' >&2
  exit 1
fi

if [[ -f .env ]]; then
  domain="$(sed -n 's/^DOMAIN=//p' .env | tr -d '\r')"
  if [[ -n "$requested_domain" && "$requested_domain" != "$domain" ]]; then
    printf '已有 .env 使用域名 %s。要更换域名，请手动修改 .env 中 DOMAIN 后重新执行。\n' "$domain" >&2
    exit 1
  fi
else
  domain="$requested_domain"
  if [[ -z "$domain" ]]; then read -r -p '请输入域名，例如 chat.example.com：' domain; fi
fi
if [[ ${#domain} -gt 253 || ! "$domain" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]]; then
  printf '%s\n' '域名无效。请使用 chat.example.com 格式，不含 https://、端口或路径；国际域名请使用 Punycode。' >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  printf 'DOMAIN=%s\n' "$domain" > .env
  chmod 600 .env
fi
export DOMAIN="$domain"

docker compose config --quiet
printf '%s\n' '开始构建并启动。首次构建需下载依赖，请稍候。'
if [[ "$with_work" == 1 ]] || grep -q '^COMPOSE_FILE=.*compose.work.yaml' .env; then
  work_arguments=()
  if [[ "$with_claude_code" == 1 ]]; then work_arguments+=(--with-claude-code); fi
  bash deploy/work-enable.sh "${work_arguments[@]}"
else
  docker compose up -d --build --wait --wait-timeout 180
fi
printf '\n网站已启动：https://%s\n' "$domain"
printf '%s\n' '首次管理员设置码在下方 app 日志中；已有管理员时不会再生成。'
docker compose logs --tail=15 app
printf '\n%s\n' '如尚未能访问，请检查域名解析与 VPS 的 80/443 端口。教程：docs/DEPLOY-VPS.md'
