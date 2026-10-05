# 将本站 API 提供给其他客户端

管理员可以为外部客户端创建独立的本站 API Key，并限制这把密钥允许调用的上游模型和渠道。客户端使用本站地址和这把新密钥；上游服务商的密钥仍由本站服务器保存，不会写进导出配置。

## 创建与导出

1. 打开“管理工作空间 → 对外 API”，点击“创建 API”。
2. 填写名称，例如“我的桌面客户端”。
3. 搜索上游原始模型 ID 或渠道名，也可在右侧筛选渠道；勾选这把密钥可以调用的模型记录。
4. 保存后复制 API 基础地址及新 API Key，或点击“下载 API 配置”。

完整密钥只在创建成功时展示一次。关闭提示、切换页面或刷新后，服务器不能再次返回该明文；遗失后新建替代密钥并撤销旧密钥。列表仅显示密钥提示、授权模型、启用状态和最近调用时间。

导出的 JSON 包含以下字段：

```json
{
  "name": "我的桌面客户端",
  "url": "https://chat.example.com/v1",
  "apiKey": "创建时生成的本站独立密钥",
  "models": ["上游原始模型ID"],
  "endpoints": ["/v1/responses"]
}
```

这是用于查看、保存和手动配置客户端的本站调用配置，不保证任意客户端能直接导入此 JSON 格式。文件内包含完整本站密钥，请按密钥文件保存。该功能与“API 连接 → 导出渠道备份”不同：渠道备份用于迁移上游配置，包含上游密钥；这里仅导出受限的本站调用凭据。

## 模型名称与权限

`GET /v1/models` 返回这把密钥授权且当前启用的**上游原始 `model_id`**，不使用网页显示名称、统一模型别名或“高智商版”等版本名称。模型在列表中不保证上游此刻可调用；冷却、服务商限额或权限仍可能导致请求失败。

例如，网页模型名是 `ChatGPT 6 Astra`，某个渠道的上游 ID 是 `gpt-6-astra`，外部请求应填写 `gpt-6-astra`。此处仅举命名示例，不表示该模型或账号一定可用；以后台配置和 `/v1/models` 实际结果为准。

授权精确绑定勾选的渠道模型记录。若同一个原始 ID 在多个渠道出现，模型列表合并显示一次，但请求只会使用显式勾选且当前可用的渠道，不会因名称相同自动扩大权限。修改网页模型名称不会把外部调用 ID 改为新别名；上游原始 ID 才是调用依据。

停用密钥、取消某模型授权、停用模型或渠道后，后续调用立即按新状态校验；撤销密钥无法恢复。创建密钥的管理员账号失效或失去管理员权限后，该密钥也不能继续鉴权。密钥不设自动到期时间。

## 选择接口协议

基础地址通常填写 `https://你的域名/v1`。某些客户端会自行追加 `/v1`，这类客户端应填写站点根地址，避免出现 `/v1/v1/...`。

| 接口 | 对应后台渠道协议 |
| --- | --- |
| `GET /v1/models` | 查看此密钥允许的原始模型 ID |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/messages` | Anthropic Messages |

生成接口按原生协议透传请求。请求参数应符合对应上游接口，本站不会把 Chat Completions 自动改写为 Responses 或 Anthropic Messages。授权了 Responses 渠道的模型，不等于可以从 `/chat/completions` 调用；需要正确匹配客户端协议。

认证支持 `Authorization: Bearer 本站密钥` 或 `x-api-key: 本站密钥`。如果同时发送两个头，值必须一致；不要把渠道服务商的 Key 填在这里。Anthropic 客户端仍需使用它要求的版本头和 Messages 参数。

模型列表请求示例：

```bash
curl https://chat.example.com/v1/models \
  -H "Authorization: Bearer YOUR_SITE_API_KEY"
```

Chat Completions 示例（仅适用于授权的 Chat Completions 渠道）：

```bash
curl https://chat.example.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_SITE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"UPSTREAM_MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

同一原始模型 ID 授权了多个相同协议的渠道时，本站按渠道优先级及可用状态选择，失败时在授权范围内有限重试。已经向客户端输出响应后发生中断，会结束这次连接，不把另一渠道的全新回答拼进原始响应流；客户端应自行处理重试或续写。

## 使用边界

- 仅支持“直接 API”渠道，不通过外部接口运行 Claude Code CLI、网页 Work 沙箱、技能、文件任务或后台用户专属模型路由。
- 外部 API 使用独立管理员密钥鉴权，不需要网页登录 Cookie，也不需要网页 CSRF Token。本站 Key 仅用于本站验证，不转发给上游；本站使用已保存的渠道密钥完成上游认证。
- 外部调用不计入网页成员的套餐次数、每日总次数或模型版本限额。上游仍按实际调用收费；此版本不提供外部 Key 的独立付费套餐、Token 预算或余额计费。
- 外部调用不保存为网页聊天记录。默认每个 IP 每分钟最多 300 次 API 请求，每把密钥最多同时 10 个生成请求；请求 JSON 上限 32 MiB、响应上限 64 MiB、总时长上限一小时。上游流空闲超时沿用 `UPSTREAM_TIMEOUT_MS`，默认 180 秒，持续收到数据刷新计时；这些保护值不代表经过压测的承载能力。
- 管理员仍可在“路由日志”查看外部 API 的渠道尝试、结果及加密保存的原始报错，记录的请求 ID 以 `api-export-` 开头。调用方仅收到通用失败提示，不会获得管理员诊断中的配置与原始错误全文。
- 客户端可提交对应原生协议支持的参数，但真实上下文、工具能力、模型权限和响应限制仍由上游决定。工具定义透传不表示本站会替外部客户端执行工具。
- 本地测试可以验证密钥隔离、授权模型筛选和流式转发；真实 VPS 反向代理、TLS、实际服务商协议及客户端兼容性仍需部署后测试。

## 管理接口

以下接口要求管理员网页登录，写入操作同时要求 CSRF：

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/api-keys` | 列出已创建凭据，不返回完整密钥 |
| `POST /api/admin/api-keys` | `{name,modelIds}` 创建；`modelIds` 是勾选渠道的内部模型记录 ID |
| `PATCH /api/admin/api-keys/:id` | 修改名称、`modelIds` 或 `enabled` |
| `DELETE /api/admin/api-keys/:id` | 撤销凭据 |

凭据记录为 `{id,name,enabled,modelIds,keyHint,createdAt,lastUsedAt}`；创建响应额外返回一次 `apiKey`。`modelIds` 是管理员授权记录，不应直接作为生成请求的 `model` 字段；外部客户端应读取 `/v1/models` 的原始 ID。

名称最多 80 字符，至少勾选一条直接 API 模型记录。被删除的模型不会因为密钥中还保存旧记录 ID 而重新获得访问权限。服务器只保存本站密钥哈希；当前 Key 只能停用/启用、修改授权或撤销，不能读取明文或更换为自行指定的密钥。
