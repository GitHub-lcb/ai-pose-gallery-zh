# 用 ComfyUI Desktop（MiniMax H3）生成视频与分镜处理

> 本机 ComfyUI Desktop 实例已装好 MiniMax H3 视频模型，可以「首帧 / 首尾帧 → 带原生立体声音频的视频」。
> 本文记录实测参数、GUI 操作步骤，以及用三大图库做分镜的完整方法。

## 一、本机已装的视频能力

| 用途 | 文件 | 大小 |
| --- | --- | --- |
| 视频主模型（first/last frame → video + audio） | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | 19.5 GB |
| turbo 8 步加速 LoRA | `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | 1.8 GB |
| 文本编码器（Qwen3-VL 32B） | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 14.6 GB |
| 视频 VAE / 音频 VAE | `minimax_h3_video_vae_fp16` / `minimax_h3_audio_vae_fp32` | 4.9 / 0.6 GB |

## 二、在 ComfyUI Desktop 里生成视频（GUI 流程）

1. 启动 ComfyUI（Desktop 打开，或浏览器访问 `http://127.0.0.1:8188`）。
2. 新建工作流 → 模板/蓝图搜索 **"Image to Video (MiniMax H3)"**。
3. 参数设置：

   | 参数 | 说明 |
   | --- | --- |
   | prompt | 英文效果最稳；结构 = 画面内容 + `[时间轴]` + 镜头运动 + 音频描述 |
   | width / height | 32 的倍数；竖屏 `768×1024`（与站点关键帧 3:4 一致），横屏 `1344×768` |
   | duration | 蓝图自动换算 length = 17k+5 帧 @24fps；常用 39/56/73/124 帧 = 1.6/2.3/3.0/5.2 秒 |
   | first_frame | 上传首帧关键帧（必填） |
   | last_frame | 可选；首尾帧模式用于转场/动作接力 |
   | turbo 开关 | 开 = 8 步 LoRA（快，推荐）；关 = 20 步（细节更好） |

4. 点击 Run → 输出保存到 ComfyUI 输出目录的 `output/video/*.mp4`（H.264 + AAC 立体声）。

**实测**（RTX 5070 Ti Laptop 12GB，768×1024，39 帧，8 步 turbo）：
首次约 **165 秒**（其中模型加载约 80 秒，8 步采样 8×10.5s≈84 秒），输出 682KB mp4，
1.625 秒 / 24fps / 带立体声，第二次起会快一些（模型已缓存）。

## 三、API / 自动化方式

已实测通过的 API 工作流：`scripts/workflows/h3_i2v.api.json`

节点链路：

    UNETLoader → (LoraLoaderModelOnly turbo) → BasicGuider
    MiniMaxH3ImageToVideo (首帧/尾帧 + prompt + 宽高 + length)
      → SamplerCustomAdvanced (res_multistep / simple / 8 步)
      → VAEDecode (视频 VAE) + VAEDecodeAudio (音频 VAE)
      → CreateVideo (fps 24) → SaveVideo (mp4)

- 脚本里把节点 6 / 6b 的 `image` 换成 `/upload/image` 返回的文件名，改 prompt / width / height / length / noise_seed，
  然后 POST `/prompt`，轮询 `/history/{id}`，再用 `/view` 下载 mp4 即可（本站 24/7 图片任务就是同一套调用方式）。
- 也可以把该 JSON 拖进 ComfyUI（工作流 → 打开），API 格式会自动转成画布。
- 如果用 GUI 蓝图，则无需自己接线。

## 四、分镜怎么处理（重点）

### 4.1 先定分镜表，再批量出片

每个镜头一行（字段模板见 `scripts/storyboard.example.json`）：

| 字段 | 说明 |
| --- | --- |
| `id` | 镜号 S01 / S02 … |
| `duration` | 秒；建议 1.6–5s，会自动吸附到 17k+5 帧 |
| `firstFrame` | 首帧关键帧（用站点三图配方生成） |
| `lastFrame` | 可选；同角色换姿势/换景别，做动作衔接 |
| `prompt` | 英文：画面 + 时间轴 + 镜头运动 |
| `audio` | 环境声 / 配乐 / 音效（H3 原生生成） |
| 转场 | 硬切（推荐）或溶解 |

### 4.2 关键帧 = 用站点三图工作流批量生成

- **固定人像（脸）+ 固定服装（同一套衣服），只换姿势** → 同一角色在不同镜头里的外观一致。
- 姿势库直接当分镜语言：全身体系 = 全景/全身镜头，上半身体系 = 中近景/特写。
- 站点输出 1152×1536（3:4），视频统一出 **768×1024（3:4）**，零裁切。
- 风格预设全片统一；需要更一致可以固定人像参考图和服装。
- 镜头数多时，可以复用现有的 `scripts/autogen.mjs` 批量为「人像+服装+姿势」出关键帧（把姿势换成你指定的那几张即可）。

### 4.3 首尾帧接力，保证镜头连续

- **镜 N 的尾帧 = 镜 N+1 的首帧**（同一张图），动作/服装自动连续。
- 首尾帧姿势跨度不要太大，否则中间过渡会扭曲；跨度大时拆成两个镜头。
- 全片以硬切为主时，可只用首帧；需要「转身/起身/挥手到位」这类动作收尾时再加尾帧。

### 4.4 H3 提示词写法（实测经验）

- 用英文；结构建议：

      Cinematic vertical shot of ... (画面与主体)
      Timeline:
      [0s-1s] ...
      [1s-2s] ...
      Camera: slow push-in / handheld drift / static
      Audio: soft piano, room tone, ...
      No subtitles, no text, no watermark.

- ⚠️ **H3 对首帧的约束偏弱**：它会按 prompt 重新构图。prompt 里的景别/场景要和首帧一致，
  不要写 `close-up / portrait` 之类会把全身镜头拉近的词；需要保构图时提供 last_frame 并减少运动描述。
- turbo 8 步更快；追求细节/稳定性用 20 步（关 turbo）。
- 帧数预算：39 帧≈1.6s、56 帧≈2.3s、73 帧≈3s、124 帧≈5s；再长会明显变慢且容易崩。

### 4.5 拼接与后期

- ComfyUI 内置 **「Merge Videos」** 蓝图：GetVideoComponents 拆出视频帧与音频 → 拼接 / AudioMerge → CreateVideo 导出。
- 本机没有 ffmpeg 命令行，但 ComfyUI 的 Python 环境自带 **PyAV**，可以脚本拼接（解复用→编码 h264+aac）。
- 需要字幕/调色/换 BGM 时，可以最后用剪辑软件或装 ffmpeg 处理。

## 五、12GB 显存注意事项

- H3 主体模型 19.5GB + 文本编码器 14.6GB，ComfyUI 用 dynamic VRAM offload 调度，12GB 笔记本能跑但首次加载慢（实测加载约 80 秒）。
- 生成视频前先停掉 24/7 图片任务，否则互相抢显存：
  `powershell -ExecutionPolicy Bypass -File scripts/autogen-task.ps1 -Action stop`
- 768×1024、39 帧是最稳的起步配置；需要更快就减帧数/分辨率，需要更清晰再上 20 步或更大尺寸。

## 六、实测样例

| 文件 | 说明 |
| --- | --- |
| `.auto-gen/videos/storyboard_test_00001_.mp4` | 单首帧，768×1024，39 帧，1.625s，带立体声 |
| `.auto-gen/videos/fl2v_*.mp4` | 首尾帧版本（验证 last_frame 链路） |

## 七、15 秒 × 2 段 → 30 秒成片流水线（已实现）

脚本：scripts/storyboard.mjs，一条命令出片：

    node scripts/storyboard.mjs

### 分镜结构（两段各 15.0s）

| 段落 | 镜头 | 首帧 → 尾帧 | 帧数 | 内容 |
| --- | --- | --- | --- | --- |
| A 段 | A1 | KF1 → KF2 | 124 | 开场：工作室回眸转身 |
| A 段 | A2 | KF2 → KF3 | 124 | 中段：双手比心 |
| A 段 | A3 | KF3 → KF4 | 107 | 收尾：猫爪挥手 + 定格 |
| B 段 | B1 | KF4 → KF5 | 107 | 续接 A 尾：转身走向镜头 |
| B 段 | B2 | KF5 → KF6 | 124 | 中段：坐下 |
| B 段 | B3 | KF6 → KF7 | 124 | 收尾：脸侧比心 + 定格 |

- 每段 355 帧 + 末帧定格 5 帧 = 360 帧 = **15.0 秒**；A 结尾（KF4）与 B 开头（KF4）是同一张关键帧，硬切拼接天然无缝；A+B 合并 = **30.0 秒**。
- 7 张关键帧全部用同一人像 + 同一套服装 + 不同姿势生成（1152×1536），保证全片角色/服装一致。
- 每条镜头都是「首帧 → 尾帧」驱动（H3 会按提示词补镜头运动），自带 32kHz 立体声音频。

### 输出

| 文件 | 规格 |
| --- | --- |
| .auto-gen/videos/film_A_15s.mp4 | 768×1024，24fps，360 帧，15.0s，H.264 + AAC |
| .auto-gen/videos/film_B_15s.mp4 | 同上 |
| .auto-gen/videos/film_AB_30s.mp4 | 768×1024，24fps，720 帧，30.0s |
| .auto-gen/storyboard/keyframes/KF*.png | 关键帧（1152×1536） |
| .auto-gen/storyboard/clips/*.mp4 | 每镜头原始片段 |
| .auto-gen/storyboard/storyboard.generated.json | 分镜表 + 提示词 + 文件清单 |

拼接脚本：scripts/stitch_videos.py（PyAV，按帧精确裁剪 + 末帧定格 + 音画同步）。

### 实测耗时（RTX 5070 Ti Laptop 12GB，8 步 turbo）

| 项目 | 耗时 |
| --- | --- |
| 1 张关键帧（Qwen-Image 2.1 三图） | ≈111 秒 |
| 1 个 124 帧镜头（约 5.2s） | ≈557–566 秒 |
| 1 个 107 帧镜头（约 4.5s） | ≈451–458 秒 |
| 整条流水线（7 关键帧 + 6 镜头 + 拼接） | ≈53 分钟 |

### 想改成自己的分镜

直接编辑 scripts/storyboard.mjs 顶部的 KEYFRAMES / SHOTS / FILMS：

- KEYFRAMES：poseId（姿势库 id，从 data/pose-zh.json 里挑）与备注；
- SHOTS：每镜的 first / last（关键帧 id）、frames（17k+5 网格：107≈4.5s、124≈5.2s、141≈5.9s）、英文 prompt；
- FILMS：镜头分组、每段目标帧数（targetFrames: 360 = 15s）。
- 脚本支持断点续跑：已有关键帧/片段/成片会自动跳过；改某镜头后删掉对应 clips/xx.mp4 与成片即可重拼。

### 实测踩坑

1. 提示词必须和关键帧一致：H3 对首帧约束偏弱，prompt 里写了关键帧没有的衣服/场景，画面会照 prompt 变（第一次就出现「酒红衬衫→米白蕾丝衫」「白棚→窗边房间」的漂移）。正确写法：在 prompt 里逐项描述关键帧里的真实人设/服装/背景，并加一句「Keep her face, hair, outfit and background identical to the first frame」。
2. 关键帧和视频同为 3:4（1152×1536 → 768×1024）时，构图不需要裁切。
3. 12GB 显存下，模型会在 H3 / Qwen-Image 之间反复装载，切换阶段会慢几十秒。
