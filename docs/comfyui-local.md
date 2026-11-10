# 本地 ComfyUI 三图合成（Qwen Image Edit 2509）

人像（图1：脸与身份）+ 服装（图2：款式、材质、颜色）+ 姿势（图3：动作与构图）→ 一张合成人物图。

## 所需模型（ComfyUI 官方 Comfy-Org/Qwen-Image_ComfyUI 仓库）

| 用途 | 文件 | 目录 | 大小 |
| --- | --- | --- | --- |
| 扩散模型 | `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `models/diffusion_models` 或 `models/unet` | 20.4 GB |
| 文本/视觉编码器 | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `models/text_encoders` | 9.4 GB |
| VAE | `qwen_image_vae.safetensors` | `models/vae` | 254 MB |
| 4 步加速 LoRA（2509 专用） | `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | `models/loras` | 850 MB |

不需要任何自定义节点，ComfyUI 0.3.60 以上的内置节点即可（实测 0.43.0）。

## 工作流

`src/workflows/qwen_image_edit_2509_3img.api.json`（API 格式，可直接 `POST /prompt`，也可在合成台「导出 .json」）。

- `UNETLoader → LoraLoaderModelOnly(Lightning) → ModelSamplingAuraFlow(shift=3) → CFGNorm → KSampler(4 步, cfg=1, euler/simple)`，与官方模板一致。
- 三张图都送入 `TextEncodeQwenImageEditPlus`（视觉语言理解，按「图1/图2/图3」指代）。
- **只有人像和服装**通过 `ReferenceLatent` 作为像素级参考；姿势图只用于语义理解。
  实测如果把线稿人偶姿势图也作为像素参考，生成结果会照搬人偶的关节球和分块线条。
- 输出尺寸按姿势图比例缩放到约 1 MP（节点 10 的 `megapixels`）。
- cfg=1 时反向提示词不生效，「不要文字/水印」等要求写在正向提示词里。

## 提示词（Qwen Image 2.1 官方范式）

本地 Qwen 2.1 链路会自动使用官方 Prompt Enhancer 规范对应的「单段指令」提示词（合成台「提示词」区顶部会显示当前提示词引擎）：

- 多图必须用 `<image1>` / `<image2>` / `<image3>` 指向参考图 —— ComfyUI 的 `qwen_image21.py` 会自动在用户提示词前拼接 `<image1><vision> <image2><vision> …`，带标签的文本才能和视觉 token 对齐，不要再写「图1/图2」。
- 整条提示词是**单段连续文本**：不分点、不换行、不写 markdown。
- 逐图声明角色：`<image1>` 提供面部身份 / 发型 / 发色，`<image2>` 提供整套服装，`<image3>` 只提供动作、身体朝向与镜头机位。
- 肯定式保留声明（「保持与…一致」），不写「不要 / 禁止」：cfg=1 时负向提示词不生效，否定词只会把概念带进上下文。
- 主动写场景、布光、构图、镜头：本工作流的输出画布由姿势图尺寸决定，背景完全由提示词生成，不写就只能得到默认的白底棚拍感。背景由**参考图驱动、没有固定场景选项**：上传的参考图（人像 / 服装 / 姿势）如果带环境，就跟随该参考图的场景氛围；若上传图是纯色/白底，或用的是素材库白模/人台（无环境信息），则根据服装分类与标签、人物姿势、画风光线自动生成协调的真实环境背景（例如泳装 → 海边/泳池、睡衣 → 卧室、礼服 → 宴会厅、躺卧 → 卧室床品）。
- 不写分辨率 / 比例 / 2K / 4K 与「8k 超清」等质量堆词，用具体材质、焦段、光位描述替代。
- 姿势描述按姿势族动态生成（站 / 跪 / 坐 / 俯卧 / 仰卧 / 双人 / 半身），不再固定追加「站姿」这类与参考姿势冲突的句子。

对照与依据见 [Qwen Image 2.1 多图参考提示词研究报告](qwen-image-prompt-research.md)；回归断言：`pnpm check:prompts`（`scripts/check-prompts.mjs`）。旧版分点提示词仍用于云端模型与 Qwen-Image-Edit 2509 链路。

> 进阶：官方 2.1 模板还带一个可选的 Prompt Enhancer（Qwen3.5-9B 改写模型，需另装 `qwen3.5_9b_qwen_image_2.1_pe_i2i` 等权重并把它接进工作流）。本仓库当前**不依赖 PE**，代码直接生成「已被扩写好的」完整单段提示词；若自行接入 PE，提示词应切换为 20–60 字短指令，两者不要混用（见研究报告 §5.7）。

旧的 Qwen-Image 2.1 预设仍保留，但需要另行安装 2.1 模型；合成台在提交前会检测并列出缺失的模型文件。

## 本地运行

```bash
corepack pnpm install
corepack pnpm dev
```

打开 http://localhost:5173/studio，接口协议选「本地 ComfyUI」。
本地运行时 ComfyUI 地址填 `/comfy`（默认值）：Vite 把 `/comfy/*` 同源代理到本机 ComfyUI。
`pnpm dev` 启动时会**自动探测常见端口**（`8000 / 8188 / 8088 / 8189 / 8080`，默认 8188），
探测到哪个就代理到哪个，因此通常**不需要手动配置**，也无需修改 ComfyUI 的 `--enable-cors-header`。
如果自动探测不到（例如 ComfyUI 启动较慢、或端口不在列表内），可以显式指定：

```bash
# 建议先启动 ComfyUI，再启动网页（探测只在 dev server 启动时执行）
COMFYUI_URL=http://127.0.0.1:8188 corepack pnpm dev
```

PowerShell 写法：

```powershell
$env:COMFYUI_URL="http://127.0.0.1:8188"; pnpm dev
```

直连（不经代理）时，ComfyUI 启动参数需要 `--enable-cors-header "<网页的来源>"`，该参数只能填一个来源。

## 显存与速度（RTX 4070 SUPER 12 GB / 32 GB 内存实测）

- 首次生成约 50 秒（含加载模型），之后每张约 25–30 秒。
- 20 GB 的 fp8 模型超过 12 GB 显存，ComfyUI 会自动部分卸载到内存，无需额外设置。
- 8 GB 显卡：把节点 10 的 `megapixels` 调到 0.6，关闭其他占用显卡的程序；显存不足时合成台会提示并调用 `/free` 释放显存。

## 已知限制

- 个别随机种子会在角落生成无意义的“标志”文字，换一个种子重新生成即可。
- 服装名称与图片不一致时（如名称写“牛仔”但图中是粉色），以图片为准，但不能保证每次都正确。
