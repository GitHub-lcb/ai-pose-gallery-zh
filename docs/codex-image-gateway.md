# 本地 Codex / ChatGPT 订阅生图网关

本项目内置了一个最小的 **OpenAI 兼容生图网关**：`scripts/codex-image-gateway.mjs`。它读取本机 **Codex CLI 的 OAuth 凭据**（`~/.codex/auth.json`），把 ChatGPT / Codex 订阅账号代理成本地 `/v1/images/generations`、`/v1/images/edits` 接口，供 AI 合成台的 **OpenAI GPT Image** provider 直接使用。

> ⚠️ 使用订阅账号调用内部接口可能违反 OpenAI 服务条款，存在账号风控/封禁风险；请自行评估。本项目只提供技术实现，不承担相关责任。  
> 想要多账号、配额、计费、故障转移等生产级能力，请使用完整的开源网关 [sub2api](https://github.com/Wei-Shaw/sub2api)。

## 它是怎么实现的（参考 sub2api）

sub2api 的图片转发路径（`backend/internal/service/openai_images*.go`）：

1. 用 OpenAI OAuth 账号的 `access_token` + `chatgpt-account-id` 访问 ChatGPT 内部 Codex 接口；
2. 对 `gpt-image-2.5-flare / sunburst / gpt-image-2 / gpt-image-1.5` 等模型，**直调**
   `POST https://chatgpt.com/backend-api/codex/images/generations`（编辑为 `/images/edits`），
   请求体就是 OpenAI Images API 字段（`model / prompt / images / size / quality / ...`）；
3. 其他图片模型走 **Responses + `image_generation` 工具**（主控模型默认 `gpt-5.6-luna`，可用 `SUB2API_IMAGES_MAIN_MODEL` 覆盖）；
4. 凭据过期时用 `refresh_token` 调 `https://auth.openai.com/oauth/token`（client_id 为 Codex CLI 的公开 client_id）自动刷新；
5. 对外暴露 OpenAI 兼容的 `/v1/images/generations`、`/v1/images/edits`（以及异步任务接口）。

本项目的网关做了同样的核心链路（单账号版）：

| 能力 | 说明 |
| --- | --- |
| 凭据读取 | `$CODEX_HOME/auth.json` 或 `~/.codex/auth.json` |
| 自动刷新 | access token 失效（401/403）时用 refresh_token 刷新并写回 auth.json |
| 生成 | `POST /v1/images/generations` |
| 编辑 | `POST /v1/images/edits`（JSON `images:[{image_url}]` 或 multipart `image[]`，支持 data URL / http URL） |
| 模型列表 | `GET /v1/models`（gpt-image-2.6 / 2.5-flare / 2.5-sunburst / 2 / 1.5） |
| 健康检查 | `GET /health` |
| 浏览器跨域 | 已带 CORS 头，可直接从本项目的 Web 页面调用 |
| 代理 | 启动脚本会自动读取 Windows 系统代理并设置 `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` |

## 快速开始

1. 确认本机已登录 Codex：

   ```powershell
   codex login
   # 凭据文件：C:\Users\<你>\.codex\auth.json
   ```

2. 启动网关（任选一种）：

   ```powershell
   # 方式 A：项目根目录运行
   ./scripts/start-codex-gateway.ps1
   # 自定义端口 / 模型：
   # ./scripts/start-codex-gateway.ps1 -Port 8790 -Model gpt-image-2.6
   ```

   > 方式 B：**双击桌面启动器** `启动 Codex 生图网关.cmd`（内部调用同一个脚本）。
   > 脚本兼容 **Windows PowerShell 5.1** 与 **PowerShell 7+**，全部提示为 ASCII，避免旧版 PowerShell 读取 UTF-8 中文脚本时的解析错误。

   看到以下输出即成功：

   ```
   [xx:xx:xx] Codex image gateway: http://127.0.0.1:8788/v1
   [gateway] credentials: C:\Users\xxx\.codex\auth.json
   ```

3. 在「API 接口配置」→ **OpenAI GPT Image** 中填写（或直接点 **「Codex 网关」** 一键填入）：

   | 配置项 | 值 |
   | --- | --- |
   | Base URL | `http://127.0.0.1:8788/v1` |
   | API Key | `sk-local-codex`（若启动时设置了 `-GatewayKey` 则填它） |
   | 默认模型 | `gpt-image-2.6`（最新，实测单图约 18 秒；也可选 2.5-flare / sunburst 等） |
   | 端点模式 | `images_edits_json`（默认） |
   | 参考图传参方式 | `base64`（本地图片无法被 OpenAI 服务器访问，必须 base64） |

4. 在合成台选择「人像 + 服装」（推荐）即可生成；`检测网关` 按钮可确认连接与套餐。

### 常见问题

- **PowerShell 报「意外的标记 / 字符串缺少终止符」**：旧版脚本使用了 PowerShell 7 专属语法（`?.`、三元运算）且中文注释在 Windows PowerShell 5.1 下会被按 ANSI 解析。现已改为纯 ASCII + PS 5.1 兼容写法；更新后再运行即可。
- **端口被占用**：默认 8788；若被占用，用 `./scripts/start-codex-gateway.ps1 -Port 8790`，并把应用里的 Base URL 同步改成 `http://127.0.0.1:8790/v1`。
- **控制台中文乱码**：桌面启动器已执行 `chcp 65001`；若仍乱码，按窗口里的 Base URL / 模型信息操作即可，不影响功能。
- **桌面启动器**：`C:\Users\<你>\Desktop\启动 Codex 生图网关.cmd`；如果项目目录移动了，右键编辑它、把里面的路径改成新位置即可。

## gpt-image-2.6 与动图

- `gpt-image-2.6` 已可直调（`/backend-api/codex/images/generations`），实测 1024×1024 单图约 **18 秒**，比 2.5 更快。
- **GIF / 动图目前被上游功能门控**（2026-11 实测）：
  - 直接图片接口传 `output_format: "gif"` → `400 {"detail":"GIF output is not enabled for this request."}`
  - 走 Responses + `image_generation` 工具 → `GIF output is not enabled for the model 'gpt-image-2-codex'`
  - 加 `stream` / `n` / `partial_images` / `animation: true` 等参数均未解锁；不传 `gif` 时 2.6 会正常返回 PNG 静图。
- 本项目的 App 与网关已支持 `gif` 选项与动图 MIME 识别（GIF/WebP 会以正确 `data:image/gif|webp` 展示），等 OpenAI 对账号开放 GIF 输出后即可直接使用，无需再改代码。

## 重要限制（实测）

- **姿势参考图会被 OpenAI 图片安全审核拒绝**：无论 3D 白模还是深度图，实测都会返回
  `Your request was rejected by the safety system ... safety_violations=[sexual]`。
  因此使用 Codex 网关时：
  - ✅ 支持「人像 + 服装」、仅服装、纯文字生成、图片编辑；
  - ❌ 不要选「姿势」参考图；如需要姿势，把姿势写进提示词（例如「后仰坐・单膝立起，正面视角」），或改用本地 ComfyUI / 官方 API Key（`gpt-image-*` API Key 模式）。
- 订阅账号的图片生成受 ChatGPT 套餐配额与安全策略约束，成人/性感内容会被拒绝。
- 单账号、无并发队列、无计费；多账号/配额/故障转移请部署 [sub2api](https://github.com/Wei-Shaw/sub2api)（Docker，支持 PostgreSQL/Redis、多账号、异步图片任务等）。
- 若本机网络需要代理，启动脚本会自动读取 Windows 系统代理（如 `127.0.0.1:7897`）；也可以手动设置 `HTTPS_PROXY` 后用 `NODE_USE_ENV_PROXY=1 node scripts/codex-image-gateway.mjs`。
- 网关只监听 `127.0.0.1`，默认不需要 key；如担心被本机其他程序调用，可设置 `-GatewayKey sk-xxx`。

## 手动验证

```powershell
# 健康检查
Invoke-RestMethod http://127.0.0.1:8788/health

# 生成一张图
$body = @{ model = 'gpt-image-2.5-flare'; prompt = 'a red apple on a white background'; size = '1024x1024' } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8788/v1/images/generations -Method Post -Body $body -ContentType 'application/json' -Headers @{ Authorization = 'Bearer sk-local-codex' }
```

## 与 sub2api 的关系

| | 本项目网关 | sub2api |
| --- | --- | --- |
| 定位 | 单机单账号、开箱即用的图片代理 | 完整订阅转 API 网关 |
| 账号 | 本机 Codex OAuth | 多账号 OAuth / Setup Token / API Key |
| 存储 | 直接读写 `~/.codex/auth.json` | PostgreSQL + Redis |
| 图片 | `/v1/images/generations|edits`（同步） | 同步 + 异步图片任务、对象存储 |
| 适用 | 个人本地生图 | 团队/中转站/多账号池 |
