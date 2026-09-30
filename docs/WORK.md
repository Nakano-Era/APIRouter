# Claude Code Chat / Work

APIRouter 可以通过真正的 Claude Code CLI 执行任务。Chat 调用关闭工具；Work 允许在一次性 Docker 容器中使用 Agent、Skill、Read、Write、Edit、Bash、Glob、Grep，并可按次开启 WebSearch。模型生成的说明不等于任务已经执行；只有从工作区读取到的实际文件才会出现在下载列表。

## 启用

先完成 [VPS 部署](DEPLOY-VPS.md)，再在项目目录执行：

```bash
sudo bash deploy/work-enable.sh
```

脚本构建固定版本的 Claude Code 工作镜像、启动执行器，并把执行器凭据及 `COMPOSE_FILE=compose.yaml:compose.work.yaml` 保存到现有 `.env`。不会覆盖原有域名和其他设置。首次构建需要访问 Docker、Debian 和 npm 软件源。`.env` 不应提交到 GitHub。

之后通常的 `docker compose up -d --build --wait` 会继续读取 Work 配置；升级 Claude Code 工作镜像时再次运行上述脚本。默认 CLI 版本写在 `runner/Dockerfile` 的 `CLAUDE_CODE_VERSION` 参数中。本地开发也可以把 `WORK_RUNNER_URL` 和 `WORK_RUNNER_TOKEN` 指向同一受控执行器；不要将执行器端口公开到公网。

1. 在管理后台添加 **Anthropic Messages** 接口，填写提供商明确支持 Claude Code 的地址及密钥。Bearer 或 x-api-key 认证需要与提供商一致。
2. 同步模型后，先用“测试”确认该渠道能完成普通回答。
3. 需要 Claude Code 的 Chat 调用时，选择该渠道的 Claude Code 运行方式；Work 会使用 Claude Code 执行器。
4. 在后台的 Work 设置中确认执行器可用，按机器能力设置资源上限。
5. 在聊天页面选择 Work、模型和思考强度，运行例如“创建一个 SVG 文件并保存到 output”这样的任务，完成后下载实际文件。

仅模型列表同步成功不代表该提供商接受 Claude Code 的请求格式、模型或 WebSearch。400/401/403/404 等原始错误可以在管理员日志中查看。工作执行器没有配置或健康检查失败时会明确显示不可用，不会用普通聊天伪装完成工具操作。

## 资源与任务边界

默认每个任务：768 MB 内存、1 CPU、128 个进程、20 轮模型调用、600 秒时限、CLI 估算预算 2 美元；最多同时两个任务。后台允许的范围分别为 512–4096 MB、0.25–4 CPU、1–80 轮、30–1800 秒、0.1–20 美元、1–4 个任务。预算依赖 Claude Code 对模型价格的认识，第三方渠道的真实费用以渠道账单为准；时限与资源限制由 Docker 强制执行。

Work 建议至少 2 核 4 GB VPS，多个并发任务或较大文件应增加内存。该建议不是压力测试结论。Chat 直接 API 模式不需要创建工作容器。

镜像预装 Node.js、Python 3、Pillow、python-docx、openpyxl、ReportLab、python-pptx、Git、ripgrep 和 Bash。基础 Python 库来自 Debian 软件包；python-pptx 及补充依赖使用固定版本安装到独立虚拟环境。任务不能直接安装联网依赖，也不能访问宿主机目录或 Docker socket。复杂办公文件生成依赖所选技能和镜像内已有工具；需要额外软件时，应由管理员修改 `runner/Dockerfile` 并重新构建，不能在网页上传宿主机启动命令或挂载路径。

每次任务创建新工作区，同一对话最近的输出文件会重新注入 `output/`；容器与其他临时文件在任务结束后清理。对话上下文作为结构化历史发送给 Claude Code，不恢复旧的 CLI 会话。当前的工作区延续只包括输出文件；上传的文档以已有提取文本进入上下文，图片以真实图片内容发送。没有后台无人值守任务队列或浏览器桌面控制。

每个输出文件最多 10 MB，一次最多 30 个、合计 30 MB，每位用户保存的工作文件最多 500 个、200 MB。下载内容只来自 `output/` 下的普通文件；隐藏文件、符号链接、硬链接与越界路径不会导出。HTML 和 SVG 强制下载，避免在站点权限下直接执行。删除对话会删除对应输出文件；输出保存在数据库中，常规数据库备份会一起保存。

## Skill

管理员可粘贴 `SKILL.md`，或填写原始 Markdown 文件的公网 HTTPS 地址导入。普通成员可以选择管理员提供的技能并下载技能文件。技能名称使用小写英文、数字与连字符；单份最大 64 KB，最多保存 32 份，每次最多选择 10 份。

本版导入的是 Markdown 指令，不会自动安装仓库、插件、MCP、hooks 或额外的脚本文件。导入时重建名称和说明元数据，并拒绝 `!` 加反引号的动态命令替换语法。需要脚本资源的技能应由管理员预装到工作镜像。技能是给模型的任务说明，管理员应先检查其来源和内容。

## 网络搜索与隔离

勾选网络搜索后会允许 Claude Code 内置 WebSearch 工具；请求仍通过所选 Anthropic 兼容提供商，成功与否取决于它是否支持该工具。当前不提供通用网页抓取、浏览器访问或任意外网 shell 权限。如果上游拒绝搜索工具，会保留实际错误，不会伪造搜索结果。

工作容器为非 root、只读根文件系统，使用单独的内网 Docker 网络与有限大小的临时文件系统。真实 API Key 只保留在应用和执行器网关内；工作进程只能获得本任务的短期凭据。网关仅转发该任务所选模型的 Messages 和 count_tokens 请求，验证公网地址并固定 DNS 解析结果，不跟随重定向。任务不能通过该网关访问任意网址。

只有 `work-runner` 管理容器拥有 Docker socket。该容器属于高权限部署组件，应只运行本项目代码并及时更新；应用及每个工作容器都不持有 socket。容器隔离共享宿主机内核，不等同于独立虚拟机。执行器重启时会清理上次遗留的工作容器与网络。

## 验证与排错

```bash
docker compose ps
docker compose logs --tail=100 work-runner
node --test tests/work.test.mjs
```

本仓库另有 `node --test tests/work.test.mjs`，覆盖资源参数、工具选项、网关权限、凭据隔离、流式文本、文件导出及访问权限等。当前开发环境未运行 Docker Engine，所以镜像构建、真实 CLI 调用和具体第三方渠道兼容性仍需在目标 VPS 验证。首次上线先运行小任务，不要把“单元测试通过”当成真实上游已验证。

实现参考 [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)、[程序化运行](https://code.claude.com/docs/en/headless) 与 [Skills 文档](https://code.claude.com/docs/en/skills)。
