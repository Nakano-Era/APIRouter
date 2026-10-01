# VPS 部署教程

这个部署方式适合自己和受邀用户使用：应用负责登录、聊天、模型选择和后台配置；Caddy 负责 HTTPS。用户浏览器只连接你的域名，API Key 保存在服务器端。模型请求仍会经过你在后台配置的上游服务。

## 最短操作

先把完整项目上传到 VPS，例如 `/opt/APIRouter`，并把域名 `chat.example.com` 的 A 记录指向 VPS 公网 IPv4。然后在 VPS 执行：

```bash
cd /opt/APIRouter
sudo bash deploy.sh chat.example.com --install-docker --with-work
```

把示例域名换成你的域名。脚本会检查环境，在支持的全新 Ubuntu/Debian 系统上安装 Docker，构建应用与通用 Docker 工作镜像，再启动 HTTPS 入口。已有 Docker 时不会重新安装；已有 `.env` 和数据卷会保留。只需要直接 API 聊天时去掉 `--with-work`。默认 Work 不依赖 Claude Code，三种支持的 API 协议均可使用沙箱工具。

只有确实需要 Claude Code 专属接入时，额外运行 `sudo bash deploy.sh --with-claude-code`，安装独立的可选镜像。已部署的普通 API 沙箱无需为此更换模型或 Key。

成功后打开 `https://你的域名`。终端末尾会显示首次管理员设置码，用它创建管理员账号。若没看到设置码：

```bash
sudo docker compose logs --tail=30 app
```

设置码仅在还没有管理员时生成，应用重启后旧码失效。创建管理员后，后续用户只能使用管理员发出的邀请注册。

## 部署前准备

- **VPS 系统**：建议 64 位 Ubuntu 24.04 或 Debian 12/13。自动安装支持 Ubuntu 22.04、24.04、26.04，以及 Debian 12、13；其他系统先自行安装 Docker Engine 和 Compose 插件，再去掉 `--install-docker`。
- **配置起点**：直接 API 聊天至少 2 核、2GB 内存；启用 Claude Code / Work 建议 4GB 起步。这是容量估算，不是压力测试结论。不需要显卡。
- **磁盘**：聊天建议预留 10GB；含 Work 建议 20GB，用于镜像、依赖、文件及备份。实际占用取决于使用量。
- **域名**：A 记录指向 VPS；只有 VPS 确实支持 IPv6 时才添加 AAAA 记录。不要填 `https://`、端口或路径。
- **端口**：在云厂商安全组及服务器防火墙允许 TCP 80、443。SSH 端口按你的管理方式保留。应用的 3001 端口不会发布到公网。
- **已有网站**：如果已有 Nginx、Caddy 或面板占用 80/443，先安排好域名代理，不能让两套服务同时占用相同端口。默认一键部署适合专用 VPS 或空闲端口。

如果域名托管在 Cloudflare，首次部署可以先使用“仅 DNS”完成直接访问验证。Caddy 会申请并续期证书；这要求域名正确解析且验证端口能够到达 VPS。参见 [Caddy 自动 HTTPS 文档](https://caddyserver.com/docs/automatic-https)。

安装 Docker 使用官方软件仓库，不执行网上下载的 Shell 安装脚本。如果系统已有冲突软件包或已有 Docker 软件源但安装不完整，部署脚本会提示处理，不会卸载已有软件。手动安装请查看 [Ubuntu 官方安装步骤](https://docs.docker.com/engine/install/ubuntu/)或 [Debian 官方安装步骤](https://docs.docker.com/engine/install/debian/)。

### 性能与容量

模型在 API 服务商运行，VPS 无需显卡或本地模型。文字聊天主要占用网络连接和数据库读写；PDF、Word、Excel 提取会增加 CPU 与内存用量。

| 使用方式 | 起步配置估算 |
| --- | --- |
| 自己和少量受邀用户，主要文字聊天 | 2 核 CPU、2GB 内存 |
| 经常上传文档，或 VPS 还运行其他服务 | 2 核 CPU、4GB 内存更宽裕 |
| Claude Code / Work，少量任务 | 2 核 CPU、4GB 内存起步；机器紧张时将 Work 并发设为 1 |
| 多个 Work 任务或较大文件 | 按任务内存上限增加内存，建议从 8GB 评估 |
| 1GB 内存 VPS | 不适合当前默认部署；构建和文档解析容易耗尽内存 |

这些是按实现估算的起点，未做生产容量压测，不能据此承诺同时在线人数。默认限制全站同时 10 条生成、每用户不同对话同时 4 条，同一对话串行，文档解析同时 2 个；等待模型回答的连接和正在解析文档的请求，资源消耗差异很大。上游限流也会影响可用并发。

Compose 为应用设置 1536MB、Caddy 设置 256MB 的内存上限，这是限制值，不是空闲占用；宿主系统和构建过程仍需要余量。升级 VPS 内存不会自动提高这些上限，确需调整时修改 `compose.yaml`，并同时评估并发。较大的使用规模应先用自己的文件和上游延迟进行压测。

Work 另有 512MB 上限的网关容器，以及默认最多两个、每个 768MB / 1 CPU 的任务容器。任务的 CPU、内存、时限和并发可在管理后台配置；上游模型仍在服务商处运行。建议先用一个小文件任务验证资源消耗。

## 从 Windows 上传项目

可以用 WinSCP 把项目目录复制到 `/opt/APIRouter`。上传源码时不要包含 `node_modules`、`.npm-cache`、`dist`、`data`、`backups`、`test-results`、`deliverables`、`.agents`、`.codex`、`.env` 和 `*.tsbuildinfo`；VPS 会自行安装依赖，数据迁移则使用下文的备份恢复流程。必须包含 `package-lock.json`、`server`、`runner`、`src`、`public`、`deploy`、`scripts`、`Dockerfile`、`compose.yaml`、`compose.work.yaml`、`deploy.sh` 及项目配置文件。旧版本升级不能只替换 `server/`。

也可以在项目目录中打开 PowerShell，先打包源码，再上传：

```powershell
tar.exe --exclude=./APIRouter-deploy.tar.gz --exclude=./node_modules --exclude=./.npm-cache --exclude=./dist --exclude=./data --exclude=./backups --exclude=./test-results --exclude=./deliverables --exclude=./.agents --exclude=./.codex --exclude=./.env --exclude=./.env.* --exclude=./.git --exclude='*.tsbuildinfo' -czf APIRouter-deploy.tar.gz .
scp.exe .\APIRouter-deploy.tar.gz root@你的VPS公网IP:/root/
```

登录 VPS 后解压，然后执行前面的部署命令：

```bash
sudo mkdir -p /opt/APIRouter
sudo tar -xzf /root/APIRouter-deploy.tar.gz -C /opt/APIRouter
cd /opt/APIRouter
sudo bash deploy.sh chat.example.com --install-docker --with-work
```

如果你使用普通 SSH 用户，把上传位置改为该用户自己的目录，并相应修改解压路径。

## 创建账号与配置 AnyRouter

1. 打开站点，用终端中的设置码创建管理员。
2. 进入管理员后台，添加接口名称、API 地址、协议和 API Key；也可粘贴 `{"_type":"newapi_channel_conn","key":"sk-XXX","url":"https://xxx.com"}`，检查识别预览后保存。
3. 地址与协议以 `anyrouter.top` 给你的账号提供的信息为准。地址不是登录页面；不要仅凭域名猜测路径。本项目支持的协议及填写方式以后台提示为准。
4. 同步模型列表；若上游不提供列表接口，可手动添加准确的模型 ID。列表中的“存在”不等于当前 Key 一定能调用，需要运行连通测试。
5. 普通 API 的 Chat / Work 都选择“直接 API”，协议、认证方式遵从上游说明。若账号提供 Claude Code 专属接入，使用 Anthropic Messages 与 Claude Code 运行方式，并安装可选镜像。先用自动思考强度完成一次普通模型测试。
6. 启用可用模型，按需要设置默认模型、视觉支持、支持的思考强度与用户额度；相同模型的各渠道在同一分组下管理。
7. 创建邀请，把邀请链接发给受邀用户。普通用户不会看到渠道来源或完整 API Key。

管理员界面设置 API Key 后无需修改 `.env` 或重启服务器。模型能否回复、是否支持图片、可用上下文及额度取决于上游账号；部署成功本身不代表 AnyRouter 已通过真实调用验证。

### 旧版升级并启用 Work

先备份，再将本版完整源码覆盖到原目录，保留服务器原有 `.env` 和数据卷，执行：

```bash
cd /opt/APIRouter
sudo bash scripts/backup.sh
sudo bash deploy.sh --with-work
```

脚本沿用原域名，自动补充 Work 执行器凭据及 Compose 配置，构建工作镜像并更新服务。数据库在应用启动时补充所需字段，不清空现有账号、密钥或聊天。只需在已更新的站点上补开 Work，可执行 `sudo bash deploy/work-enable.sh`。

打开“管理工作空间 → Work”，确认执行器可用；新建对话，选择 Work 和可用的 Anthropic 模型，发送“创建一个包含你好字样的 SVG，保存到 output，提供下载”。只有实际写入的文件会出现在文件卡片中。详细技能安装、资源设置、网络搜索及文件限制见 [Work 指南](WORK.md)。

### 查询余额和备份 API

每条 API 连接可选择余额查询方式。New API 返回令牌额度；旧版兼容接口返回服务商单位，不保证是美元或完整账户余额。未实现该接口的服务商会显示不可用，普通模型调用不受影响。

API 连接页的“导出全部”会先验证管理员当前密码，可选择明文或独立密码加密的 JSON；文件包含完整 API Key 和模型映射，应保存在自己的设备上。用“粘贴识别”可导入备份，加密文件需要解密密码。API 导出不替代数据库备份。

### 配置会员套餐

部署后进入“管理工作空间 → 套餐与支付”，设置套餐名称、价格、按月/按年、每日额度及允许使用的模型。用户从右上角“升级套餐”进入。只使用人工审核时，无需配置支付服务；用户提交申请后，由管理员在后台同意或拒绝。

使用 Stripe 时，还需保存 Secret Key、注册 `https://你的域名/api/billing/webhook` 并填写 Webhook 签名密钥，配置客户门户后再启用。完整流程、事件清单与续费规则见 [会员与支付指南](MEMBERSHIP.md)。会员不依赖额外数据库或容器，相关记录和加密配置随原数据卷一同备份。

### 配置多个来源自动切换

在“API 连接”分别添加主用和备用渠道。每条渠道可独立配置认证方式 `authMode`（默认 `auto`、Bearer 或 `x-api-key`）、优先级 `priority`（数字越大越先尝试）、连续失败阈值 `failureThreshold` 和冷却秒数 `cooldownSeconds`。认证方式必须匹配服务商要求；AnyRouter 使用 Anthropic 协议时可按其账号说明选择 Bearer。

例如，你确认两条渠道提供同一个等价模型后，可以这样配置：

| 配置项 | 主用渠道 | 备用渠道 |
| --- | --- | --- |
| 渠道名称 | 主用接口 | 备用接口 |
| 优先级 `priority` | 100 | 50 |
| 连续失败阈值 `failureThreshold` | 3 | 3 |
| 冷却秒数 `cooldownSeconds` | 60 | 60 |
| 服务商实际模型 ID | `vendor/model-a` | `model-a` |
| 统一模型名 `routeKey` | `model-a` | `model-a` |

表中的模型 ID 只是示意，需要换成各渠道真实提供的 ID。到“模型”页将两条模型记录的**统一模型名**设成同一个值，并启用两条记录。用户将看到一个模型选项，后台从优先级高的渠道开始尝试；只有统一模型名相同的记录才会互相切换，管理员需要确认它们的能力确实等价。

默认网络错误、超时或 5xx 会在当前渠道最多重试一次，再尝试备用渠道；401/403/404/429 直接尝试备用渠道。每次用户请求最多尝试六次，相关重试参数可在后台调整。连续失败和冷却按“渠道＋模型”计算；冷却到期后由下一次请求触发一次恢复探测。

**重试与切换可能产生额外上游费用，不能保证只计费一次。回复已输出文字，或 Work 已开始调用工具后，中途失败不会自动换来源重做任务**。用户可以选择原回答的“继续生成”，已有文字保留并在末尾追加，原生 Work 恢复已保存的工具记录与文件。后台可查看尝试记录、健康状态与原始报错；普通用户只看到统一模型和简化错误。

Work 使用单独的一次性任务容器执行模型工具；应用容器只负责网页、权限和数据。Office/PDF 输入仍按已实现的提取方式进入模型上下文。当前没有网页浏览器、通用互联网访问或后台任务队列。

### 接续与上下文

超时、断网、停止或应用重启后，继续操作会发起新请求，保留原回答并追加新内容；也可以发送单独的“继续”。同一对话只运行一个任务，其他对话可以并行。原生 Work 恢复的是已落库的检查点和输出文件：已完成的工具不自动重放，状态不确定的操作先交给模型检查。上游隐藏状态、未收到的 token 和两次检查点之间未保存的容器状态不能恢复，模型仍可能产生重复或改写。

模型上下文容量和最大输出可从模型列表同步，也可在后台按提供商规格填写；未知值保持未知，由上游判断真实上限。历史不再静默裁剪到固定 300 条。容量估算用于渠道选择，不替代上游 tokenizer；消息请求（含 JSON 包装）与完整历史传输有 32 MB 安全上限，触及后明确提示。大上下文会增加应用内存与上游费用，应按实际任务评估 VPS。

### AnyRouter 的专属接口兼容

Claude 专属接入使用 Anthropic Messages 与可选 Claude Code 运行方式。GPT / Codex 风格接入使用“直接 API”与 Responses 协议，并按上游要求选择 Codex 兼容配置。自动配置会对 `anyrouter.top` 采用该兼容形式，其他域名保留标准请求；也可显式选择标准或 Codex。

Codex 兼容只是请求格式与请求头适配，不安装或启动 Codex CLI，也不能赋予 Key 原本没有的权限。该模式不发送 `max_output_tokens`，单次输出长度由上游默认值决定；标准 Responses 仍发送站点配置的输出限制。真实 AnyRouter Key 尚未在开发环境验证，仍应先测试普通回答，再测试 Work 工具。

## 数据保存在哪里

Docker 的 `apirouter_app_data` 数据卷保存数据库、附件和 `master.key`。API Key 使用该密钥加密存储；**丢失 `master.key` 会导致已保存的 API Key 无法解密**。备份因此需要同时保留整个数据目录。

应用以非 root 用户运行，程序目录只读，只能向数据卷和临时目录写入。应用与任务容器没有 Docker 控制接口；仅 Work 管理网关挂载 Docker socket，用于创建和清理任务容器。网关不对公网开放。自托管界面仍不能消除上游服务商的信任问题。

仅聊天部署的 `.env` 只需一项；启用 Work 后脚本会自动加入执行器凭据和 `COMPOSE_FILE`：

```dotenv
DOMAIN=chat.example.com
```

公开地址、安全 Cookie 和反向代理设置由 Compose 自动配置。不要把 API Key 放进前端源码。默认固定 Compose 项目名为 `apirouter`，单台服务器先部署一套；多实例需要分别调整项目名及入口端口。

## 更新、查看状态和重启

更新前建议备份。将新源码上传覆盖原目录，保留 `.env`，然后执行：

```bash
cd /opt/APIRouter
sudo bash scripts/backup.sh
sudo bash deploy.sh
```

脚本重建应用并使用原数据卷；已启用 Work 时会一起更新执行器和工作镜像，不会清空历史记录。Compose 官方也使用重新构建、重新创建服务的方式部署更新，参见 [Compose 生产部署说明](https://docs.docker.com/compose/how-tos/production/)。

常用操作：

```bash
# 查看是否正常运行
sudo docker compose ps

# 查看最近的应用及 HTTPS 入口日志
sudo docker compose logs --tail=80 app caddy

# 重启应用；不会删除账号或聊天
sudo docker compose restart app

# 停止站点，但保留数据
sudo docker compose stop

# 再次启动
sudo docker compose up -d
```

不要执行 `docker compose down -v`；`-v` 会删除本项目数据卷。也不要删除 Docker 数据目录。容器异常退出会按重启策略重启，但仅被标记为“不健康”不会自动触发重启；先检查日志再处理。

## 备份与恢复

备份命令：

```bash
cd /opt/APIRouter
sudo bash scripts/backup.sh
```

脚本会短暂停止应用，复制完整数据目录，再恢复原本运行的应用，保证 SQLite 文件与附件来自一致的停止状态。输出文件位于 `backups/apirouter-日期-随机码.tar.gz`。备份包含数据库、附件、`master.key` 和部署域名配置；请复制到 VPS 之外并按敏感资料保管。Caddy 证书卷不在该备份内，新服务器可重新申请证书。

恢复命令必须明确指定备份：

```bash
cd /opt/APIRouter
sudo bash scripts/restore.sh /opt/APIRouter/backups/apirouter-实际文件名.tar.gz
```

脚本要求输入 `RESTORE`，先为当前数据生成另一份备份，再替换应用数据并启动。它检查路径、拒绝压缩包中的链接和特殊文件，并在独立的可写临时副本中检查 SQLite 完整性；通过检查前不会移动当前数据，检查结束会清理临时副本。只恢复你自己可信的备份，确保磁盘空间足够容纳解压文件、数据库检查副本、新备份和原数据副本。

恢复不会覆盖当前 `.env`，因此迁移到新域名时仍使用新域名。恢复后使用备份中的账号登录。原数据还会保留在数据卷的 `.before-restore-时间戳` 目录，便于紧急回退；确认恢复无误后可由熟悉 Docker 的管理员清理，日常不需要操作它。

迁移到新 VPS：先部署一个空站，上传旧备份，然后运行恢复脚本。恢复时不要操作站点，其他用户的活跃聊天也会中断。

## 遇到问题

| 现象 | 先检查 |
| --- | --- |
| 无法连接 Docker | 使用 `sudo`；确认 Docker 服务已启动，并且装了 Compose 插件。 |
| 网页完全打不开 | A/AAAA 是否指向正确 VPS，80/443 是否允许入站，有无现成网站占用端口。 |
| 证书没有签发成功 | 查看 `sudo docker compose logs --tail=100 caddy`；优先确认 DNS 与端口，避免反复重装。 |
| 管理员设置码无效 | 查看本次启动的最新 app 日志；旧码在重启后失效。 |
| 模型列表同步失败 | 确认 API 协议、地址和 Key；上游可能不提供模型列表，此时手动添加模型 ID 后测试。 |
| 模型显示但请求失败 | 上游列表不证明调用权限；检查连通测试与上游额度。 |
| 上游 HTTP 400 / 422 | 在管理员“模型”页对该渠道执行一次测试，展开原始报错；也可在路由日志查看对应失败。按上游正文核对模型 ID、协议、参数及客户端限制。继续重试通常不能修复相同的请求。 |
| 大文件上传失败 | 单文件上限 10MB；PDF 上限 100 页；提取文字上限 20 万字符；扫描 PDF 没有 OCR。 |
| 构建或解析时内存不足 | 检查 VPS 可用内存，减少同时上传与并发；必要时升级到 4GB 或更多。 |
| 更新后短暂出现 502 | 应用可能还在重启；查看 `docker compose ps` 与 app 日志。 |
| Work 不可用 | 执行 `sudo bash deploy/work-enable.sh`，查看后台 Work 状态与 `docker compose logs --tail=100 work-runner`。 |
| Work 没有下载文件 | 确认模型实际执行工具并保存到 `output/`；说明文字不等于已生成文件，任务文件受大小限制。 |
| 回答中途被截断 | 对原回答选择“继续生成”；保持原模型继续 Work。查看日志区分上游空闲超时、输出上限和沙箱总时限。不要用“重新生成”代替接续。 |
| 网络搜索失败 | 原生搜索需要 Anthropic / Responses 上游工具支持；Chat Completions 无统一内置搜索。可选 Claude Code 使用 WebSearch。关闭搜索可先完成普通任务。 |

管理员模型测试会发送固定的简短消息，消耗少量上游额度。上游错误正文会在管理员诊断区显示，并加密保存到路由日志；模型记录保留简短提示。JSON、普通文字、HTML 等按原始文本展示，HTML 不会执行。凭据会脱敏，过大或读取超时的响应会标注截断：直接 API 最多 1MB，沙箱网关最多 128KB。普通用户不能读取这些详情。

若安装的是只有通用错误提示的旧版，先将新版完整源码覆盖到原项目目录（保留 `.env` 和数据），然后执行 `sudo bash deploy.sh --with-work`，刷新网页再测试。不要删除数据卷或重新初始化账号。

**验证范围**：源码构建、应用测试、部署脚本语法及 Compose 配置可以在开发环境检查；真实 VPS 的镜像构建、Linux 运行、域名证书签发和 AnyRouter 实际调用仍需在你的服务器与账号上验证。当前开发机器未运行 Docker 引擎，不能把文档中的部署流程当作已在该 VPS 实测的承诺。

## 模型版本、独立额度与下载升级

本版需更新完整源码并重建应用及 Work 镜像，数据库字段自动迁移。按前面的备份更新流程执行 `sudo bash deploy.sh --with-work`；使用可选 Claude Code 时改为 `--with-claude-code`。

1. 在“模型 → 模型与版本”创建父模型，再添加高智商、普通等自定义版本，分别选择渠道中的上游模型。一个上游记录只能属于一个版本；保存会启用所选记录，移出的记录会停用。用户选择模型、版本后再选思考强度，失败时仅在同一版本内切换。
2. API 连接的失败保护可关闭，或设置连续失败次数和禁用分钟数。各上游模型可单独覆盖这些设置。
3. “成员与邀请 → 各模型版本使用额度”分别设置每用户、每模型版本的每日和每月次数；不同版本不共用。留空不限此项，0 禁止使用，成员/套餐总额度仍生效。版本额度按 UTC+8 日/月重置。
4. Work 下载会匹配当前对话已保存的文件，源码目录和“打包下载”可返回 ZIP。没有实际生成的文件会明确提示。更新执行器后可用小源码任务验收下载。
5. “成员与邀请”可导出全部用户聊天，支持 Markdown/JSON ZIP。包含思考过程及文件元数据，不包含附件本体或服务密钥；完整恢复仍需数据备份。

