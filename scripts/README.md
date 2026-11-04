# 24/7 自动生成（scripts/）

用本地 ComfyUI + 站点同款工作流（Qwen-Image 2.1 三图合成），随机组合 **人像 + 服装 + 姿势**，
随机画风、随机种子，循环出图。默认安全模式（只抽 SFW 素材）。

## 快速开始

前置：本机 ComfyUI 已启动（默认 `http://127.0.0.1:8188`），并装好 2.1 int8 模型（见站点「API 接口配置 → 本地 ComfyUI」）。

    node scripts/autogen.mjs                # 前台运行，Ctrl+C 停止

Windows 开机自启（推荐长期挂机；守护进程负责崩溃后自动重启）：

    powershell -ExecutionPolicy Bypass -File scripts/autogen-task.ps1 -Action install   # 安装开机自启
    powershell -ExecutionPolicy Bypass -File scripts/autogen-task.ps1 -Action start     # 立即启动
    powershell -ExecutionPolicy Bypass -File scripts/autogen-task.ps1 -Action status    # 查看状态 / 张数 / 最近日志
    powershell -ExecutionPolicy Bypass -File scripts/autogen-task.ps1 -Action stop      # 暂停（任务与进程都停）
    powershell -ExecutionPolicy Bypass -File scripts/autogen-task.ps1 -Action uninstall # 取消开机自启（保留输出）

> 自启实现：优先注册 Windows 计划任务（需要管理员权限的 PowerShell）；普通权限下自动回退为
> `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（当前用户登录即启动，无需提权）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `AUTOGEN_OUT_DIR` | `<项目>/.auto-gen` | 输出目录 |
| `DELAY_SEC` | `3` | 每张之间间隔秒数 |
| `MAX_STORAGE_GB` | `30` | 输出目录容量上限，超出自动删最旧图 |
| `MAX_IMAGES` | `0` | 生成 N 张后退出（0 = 无限循环） |
| `INCLUDE_NSFW` | `0` | 设为 1 才抽取 18+ 分类素材 |
| `STEPS` | `25` | 采样步数（20 步约快 17%，质量差异很小） |
| `MEGAPIXELS` | `1.6875` | 画布面积（1.6875 → 3:4 姿势约 1152×1536） |
| `REF_RESOLUTION` | `1024` | 参考图编码分辨率（实测调低不提速，建议保持） |
| `CACHE_DTYPE` | `int8` | KV cache 精度（int8 更快更省显存） |
| `TIMEOUT_SEC` | `600` | 单张最长等待 |
| `COMFY_OUTPUT_DIR` | 自动识别 | ComfyUI output 目录（从 `/system_stats` 的 argv 解析；远程 ComfyUI 时需手动指定才生效） |
| `KEEP_COMFY_COPIES` | `0` | 设为 1 保留 ComfyUI `output/autogen` 中的副本（默认下载后删除） |

示例：后台挂机、降低间隔压力：

    $env:STEPS=20; $env:DELAY_SEC=5; node scripts/autogen.mjs

## 输出

    .auto-gen/
      images/auto-YYYYMMDD-HHMMSS-<seed>.png   生成图（1152×1536 PNG）
      meta.jsonl                               每张的配方、提示词、种子、耗时（一行一条 JSON）
      gallery.html                             最近 200 张的本地图库（浏览器直接打开，每张完成后自动刷新）
      autogen.log / supervisor.log             运行日志

`.auto-gen/` 已加入 `.gitignore`。默认 30GB 上限；1.7MP PNG 每张约 1.5–2.5MB，
按 60–80 秒一张约 2–3.5 GB/天，达到上限后自动删最旧的图。

ComfyUI 的 `output/autogen/` 里还会存一份同名副本（`SaveImage` 节点行为），脚本会在下载完成后
自动删除，并在启动/重连时清掉上一轮残留，因此长期挂机不会在 ComfyUI 侧重复占盘；如需保留，设
`KEEP_COMFY_COPIES=1`。

## 工作流优化结论（实测）

| 项 | 结论 |
| --- | --- |
| KV cache 精度 default → **int8** | 每张 **79s → 60s**（-24%），12GB 显存更稳，精度约等于 bf16 |
| 采样步数 25 → 20 | 再省约 17%（50s/张），固定种子对比画质差异很小，要求极致质量用 25 |
| 参考图编码分辨率 1024 → 768 | **不提速**（瓶颈在采样），保持 1024 |
| 输出画布 | 已改为跟随姿势图比例（约 1152×1536），全身姿势不裁脚 |
| 4 步加速 LoRA | 本机没有 Qwen-Image 2.1 专用 LoRA，有的话可把单张压到 20–30s |

## 注意

- 单张约 60–80 秒（模型已加载时），全天约 900–1100 张。
- ComfyUI 未启动时每 60 秒重试，不会退出。
- 生成进程是独立 Node 进程，不依赖站点 dev server（站点关了也能跑）。
- 想改画幅：调整 `MEGAPIXELS`（面积）即可，比例始终跟随姿势图。
- 上传到 ComfyUI 的参考图使用固定文件名覆盖，不会在 ComfyUI input 目录堆积垃圾。
