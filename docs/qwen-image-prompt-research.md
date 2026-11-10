# Qwen Image 2.1 多图参考提示词研究报告

> 目标场景：用户选「人像（图1 脸部/身份）+ 服装（图2 款式）+ 姿势（图3 3D 白模或深度图）」三张参考图，合成一张新人物图；重点是本机 ComfyUI + Qwen Image 2.1（int8）这条链路。
> 说明：文中 	mp/qwen-prompt-lab/... 为本地评测产物（出图、评分报告、评测脚本），未纳入仓库，仅在本机保留。
> 调研日期：2026-11-10。**结论先行**；每条结论标注证据来源，拿不到实证的写「待实测」，不编造来源（检索局限见 §9）。
> 配套文件：
> - 官方 PE-I2I 系统提示词全文：`tmp/qwen-prompt-lab/prompts/official-pe-i2i-system.md`
> - 12 个待评测变体（R1–R4 × 3 case，已通过 `run.mjs --dry`）：`tmp/qwen-prompt-lab/prompts/variants.json`

---

## 0. 一页结论（TL;DR）

**核心判断：本地 Qwen Image 2.1 是一条「编辑模型 + 多模态指令」链路，官方要求提示词写成「单段连续、指令式、用 `<imageN>` 指向参考图、肯定式陈述保留项」的自然语言段落；本项目现有 `buildRecipePrompt()` 的「中文分点列表 + 图1/图2 + 文字描述五官发型 + 大量否定句」与这套规范几乎完全相反，这是「出图效果一般、姿势丢失、背景呆板」最可能的主因。**

### 0.1 必须改的 9 件事（按预期收益排序）

| # | 旧实现 | 官方规范 / 推荐 | 证据 |
|---|---|---|---|
| 1 | 多图用「图1 / 图2 / 图3」指代 | 多图**必须**用 `<image1>`/`<image2>`/`<image3>`（官方原文 "This tagging format is mandatory and non-negotiable"，并明令禁止「图1」「第一张图」） | PE-I2I system prompt；ComfyUI 2.1 模板 MarkdownNote；`comfy/text_encoders/qwen_image21.py:22-24` |
| 2 | 中文分点列表（`• 人物：…\n• 服装：…`） | **单段连续文本，不能有换行/分点/markdown**（"one single continuous paragraph with NO line breaks"） | PE-I2I Output Format；PE-T2I Output Format |
| 3 | 用文字描述身份：「保持其脸型、五官、发型（中长发）和发色一致」 | **指向图片**而不是用文字描述长相：官方明确说 "When identity comes from a reference image, point at that image rather than describing features in words — verbal descriptions make the model regenerate and degrade the likeness." 应写「`<image1>` 提供面部身份、发型与发色，并保持与 `<image1>` 一致」 | PE-I2I "What to Anchor, What to Decide" |
| 4 | 大量否定句（「不要照搬白模」「不要断头」「不要幼态」「不要文字水印」） | **肯定式陈述**（"State requirements affirmatively … rather than as prohibitions"）；且本机 `cfg=1.0` 时负向提示词无效（模板原文 "negative_prompt: unused while cfg is 1."） | PE-I2I Output Format；ComfyUI 2.1 模板 Parameters 注 |
| 5 | 不写场景/布光/构图（默认白底棚拍感） | 跨图合成属于「做一张这个主体的新图」分支 → **主动设计场景、布光、构图**（"construct actively: design the scene, lighting, composition and layout to a professional standard"） | PE-I2I Core Objective；官方 2.1 单图编辑示例（长段描述） |
| 6 | 写「8k 高清画质 / 超清」等质量词 | **不要写分辨率/比例/2K/4K**，也不要质量堆词（PE-T2I 明列 "no quality boosters — no masterpiece, 8K, highly detailed, award-winning"）；用具体材质、光线、介质词替代 | PE-T2I "Throughout"；PE-I2I Output Format |
| 7 | 姿势句埋在列表中间、只写「图3只是动作示意」 | 用独立一句写清**动作 + 身体朝向 + 镜头机位**（例：双膝跪地、上身后仰、双手抱在脑后、身体正面朝向镜头、平视），并声明 `<image3>` 只提供动作/朝向/机位 | PE-I2I Image Reference Rules；社区实测（§3.1） |
| 8 | 把「重要/务必」等元话语、重复约束堆给模型 | 精简为可观察的视觉状态；一条保留声明覆盖一大类内容，不要逐项复述 | PE-I2I "Say what stays, without repainting it." |
| 9 | 固定句「站姿与关节自然」被无条件追加，与跪/卧姿势冲突 | 按姿势族动态生成比例/入镜/关节句（见 §5.9.1） | 本机 4 个真实 case 中 3 个非站姿；`aiGenerator.ts:154-157, 336-338` |

### 0.2 三个最关键的代码级事实

1. **模型的提示词前面会自动拼上 `<image1><vision> <image2><vision> <image3><vision>`**：`comfy/text_encoders/qwen_image21.py:22-24` 的 `refs = " ".join("<image{}>{}".format(i + 1, VISION_BLOCK) …)`；系统提示固定为 `Comprehend and analyze the provided prompt.`（`qwen_image21.py:8-10`）。→ 用户提示词里的 `<imageN>` 才是和视觉 token 对齐的原生指代；「图N」只是普通文本 token，**没有绑定关系**。
2. **本工作流的输出画布来自姿势图，而不是 `<image1>`**：真实出图工作流 `tmp/qwen-prompt-lab/workflows/result_00090_.json` 中，节点 13 `ImageScaleToTotalPixels` 的输入是节点 3（姿势图），megapixels=1.6875，再经节点 14 `VAEEncode` 作为 `KSampler.latent_image`；输出约 1152×1536 是姿势图比例。三张参考图只进 `TextEncodeQwenImage21` 的条件输入。→ **背景/构图完全没有被任何参考图锁定，必须靠提示词主动构建**；不写场景就只能得到模型默认的「白底/棚拍/中性背景」。
3. **本机模板的 Prompt Enhancer（PE）默认关闭**：`tmp/qwen-prompt-lab/template-subgraph.txt` 中 `ComfySwitchNode [false]`；官方模板说明 "`refine_prompt`: … This template starts with it off." 也就是说官方样例里那种「短指令 → 扩写成详细提示词」的便利在本机**拿不到**，我们必须直接生成「已经被扩写好的」长单段提示词。

### 0.3 推荐范式（一句话）

> **用 300–550 个汉字的单段中文，先一句操作指令（以 `<image1>` 中的人物为主角、穿 `<image2>` 的整套服装、按 `<image3>` 的动作与机位摆姿势），紧接着逐图声明角色（谁提供身份、谁提供服装、谁只提供动作与机位），再把动作/朝向/机位写具体，然后主动写场景 + 布光 + 构图 + 镜头，接着用一句肯定式保留声明锁住面部身份/发型/服装单品，补一句正向人体结构描述，最后用一句整体风格/色调收束；不写分辨率、不写比例、不写否定句、不分点、不用「图N」。**

### 0.4 实测结论（2026-11-10，本机 27 run A/B，详见 `tmp/qwen-prompt-lab/eval-report.md`）

- 新版单段范式 vs 旧分点基线：kneel **+2.5**、short_hair **+1.5**、lying **+1.0**、standing **−2.0**（退步已定位为「配饰枚举漏项」并修复），平均 **+0.75**；**审美/场景是最大提升项（4 case 审美全部 ≥4.5）**，2.5D 画风首次达标。
- 变量裁决：`<imageN>` ≈ 「图N」（等价，保留官方标签）；**长单段 > 短指令**（但必须补机位硬锁与配饰穷尽）；中文 ≈ 英文（等价，保持中文）；steps 40 ≈ 25（保持 25）；参考图顺序不改。
- 仍需正视：**极端姿势（俯卧+俯视近景）仅靠提示词无法完全还原**，模型本体对近景裁切/非常规俯仰视角的姿势线稿跟随能力有限；躺卧类场景要使用室内/床品等兼容场景，并让机位句与姿势参考硬对齐，否则场景文本会把机位带偏。

---

## 1. 本机链路：模型实际看到的输入（源码/工作流级事实）

### 1.1 文本编码器与标签拼接

`C:\Users\Administrator\AppData\Local\Comfy-Desktop\ComfyUI-Installs\h3\ComfyUI\comfy\text_encoders\qwen_image21.py`：

```python
VISION_BLOCK = "<|vision_start|><|image_pad|><|vision_end|>"
SYSTEM_PROMPT = "<|im_start|>system\nComprehend and analyze the provided prompt.<|im_end|>\n"
T2I_TEMPLATE = SYSTEM_PROMPT + "<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"
...
if llama_template is None and len(images) > 0:
    refs = " ".join("<image{}>{}".format(i + 1, VISION_BLOCK) for i in range(len(images)))
    llama_template = T2I_TEMPLATE.replace("{}", refs + "{}", 1)
```

结论：
- 模型收到的用户轮 = `<image1><vision> <image2><vision> <image3><vision> + 用户提示词`；提示词中出现的 `<imageN>` 与前面的视觉块同名，构成**文本-视觉绑定**。
- 「图1 / 第一张图 / 图一」不会产生这种绑定，只是普通文字；三张图同时在上下文里时，模型没有理由知道「图3」= 第三个视觉块。→ **这是姿势指令容易失效的高风险原因**（推断，需 R2 vs R3 实测）。
- 系统提示是任务型短句（"Comprehend and analyze the provided prompt."），不是「你是文生图模型」这类角色设定，所以提示词本身应写成**可执行的编辑指令**，而不是艺术词清单。

### 1.2 本机工作流关键节点（来自真实出图工作流）

`tmp/qwen-prompt-lab/workflows/result_00090_.json`（4 个 case 结构相同）：

| 节点 | 类型 | 关键值 | 含义 |
|---|---|---|---|
| 1/2/3 | LoadImage | 人像 / 服装 / 姿势 | 三张参考图，分别接到 `TextEncodeQwenImage21.images.image_1/2/3` |
| 4/6/7/8 | UNETLoader / QwenImage21Cache / CLIPLoader / VAELoader | `qwen_image_2.1_int8_convrot` + `qwen3vl_8b_bf16` + `qwen_image_2.1_vae_bf16` | 本机 2.1 链路 |
| 9 | TextEncodeQwenImage21 | `prompt`、`negative_prompt=""`、`resolution=1024`、images.image_1..3 | 多图条件编码；`resolution` 是图像 token 预算，不是画幅比例 |
| 10 | KSampler | euler / simple / **25 步** / **cfg=1.0** / denoise 1.0 | cfg=1 时负向分支无效 |
| 13 | ImageScaleToTotalPixels | 输入=**姿势图**，megapixels=1.6875，resolution_steps=32 | 决定输出尺寸（≈1152×1536） |
| 14 | VAEEncode | 13 → latent | KSampler 的初始 latent（画布形状来自姿势图） |

官方模板对参数的说法（`image_qwen_image_2_1_image_edit.json` 的 MarkdownNote）：
- "Up to 10 reference images (image_1 to image_10)."
- "Mention them in the prompt as `<image1>`, `<image2>`, ..."
- "image_1 is the edit target. The rest are references."（**注意：这是官方模板的接线方式；本项目工作流不是这样接的——我们的画布来自姿势图，见 1.2**）
- "negative_prompt: unused while cfg is 1."
- "steps: Qwen Image 2.1 official pipeline uses about 40-50 with euler. This template starts at 25."

### 1.3 PE 默认关闭（决定提示词形态）

`image_qwen_image_2_1_image_edit.json` / `t2i.json` 的 Prompt Enhancer 说明：
- `refine_prompt`: on 先把用户指令交给 Qwen3.5-9B 的 PE 模型改写再送编辑模型；**模板默认 off**。
- `thinking`: PE 推理块开关；官方权重训练时带 reasoning block，关掉会掉质量（所以即使打开 PE 也要同时开 thinking）。
- `max_length`: 模板压到 4096；官方推荐 T2I 16256、Edit 24000（见 Comfy-Org/workflow_templates PR #1298）。
- 采样：temperature 1.0 / top_p 0.95 / top_k 20 / min_p 0 / presence_penalty 0（edit）或 1.5（t2i）/ repetition_penalty 1.0。

→ **本项目调用契约：PE off ⇒ 代码生成的提示词必须已经是 PE 输出形态**（即 §4/§5 的规则）；如果未来把 PE 打开，提示词应退化为短指令（见 §5.7），两种模式不能混用。

### 1.4 现有实现（`src/services/aiGenerator.ts`）与规范的逐条对照

`buildRecipePrompt()`（243–380 行）目前产出（以 `tmp/qwen-prompt-lab/baseline-prompts.md` 的 standing_knit 为例）：

```text
请根据提供的 3 张参考图，生成一张完整的真实人物照片：
• 人物：图1中的人物，保持其脸型、五官、发型（中长发）和发色一致。人物的肤色必须与图一人物一致……
• 服装：让人物穿上图2中展示的整套服装和配饰（参考名称：…），每件单品的颜色、款式、面料与配饰都以图2为准……
• 姿势：按照图3中人体模型的动作和镜头角度摆姿势（跪立・上体后仰・双手抱后脑，正面）；图3只是动作示意……
• 人体比例（重要）：…避免大头小身、幼态娃娃比例……不要照搬人体模型的白模材质、接缝与拼接线。
• 风格：写实商业摄影级质感，85mm 人像镜头，自然柔和光影，真实肌肤纹理与织物细节，8k 高清画质。…
画面中没有任何文字、标志或水印。
```

逐条对照规范：①分点列表 → 违规；②「图1/图2/图3」→ 违规；③文字描述面部/发型 → 官方明确不推荐；④大量「不要/避免」→ 否定式，且 cfg=1 无效；⑤无场景/布光/构图 → 缺失；⑥「8k 高清画质」→ 质量词；⑦「画面中没有任何文字…」→ 否定式且通常不需要；⑧「重要」等元话语 → 无效信息。这套提示词能出图，但它在**和模型的原生指令格式对抗**，效果自然一般，最典型的就是姿势/构图丢失（见 §3.1 的社区同类现象）。

---

## 2. 官方 / 权威来源与硬规则

### 2.1 Qwen 官方

| 来源 | URL | 关键内容 |
|---|---|---|
| Qwen-Image-2.1 模型卡（HF） | <https://huggingface.co/Qwen/Qwen-Image-2.1> | 统一生成/编辑；**最多 10 张参考图**；原生 2K；默认 40 步；官方示例：多图用短句 "These three characters are sitting around a campfire in a forest"；单图编辑用长段描述（yacht 示例）；展示图含「6 张肖像合成合影」「模特+衣服+鞋+包+帽 5 张图组装整套造型」（与本项目场景高度一致） |
| Qwen-Image-2.1 GitHub README | <https://github.com/QwenLM/Qwen-Image-2.1> | 同上 + "For best results, we recommend using the official prompt rewriting models to expand short prompts into detailed, high-quality descriptions."；PE 两个权重：`Qwen-Image-2.1-PE-T2I` / `PE-I2I`；输出字段 `rewritten_prompt` / `wh_ratio` / `ratio_follow` |
| **PE-I2I 系统提示词**（官方权重仓随附） | <https://huggingface.co/Qwen/Qwen-Image-2.1-PE-I2I/blob/main/system_prompt.txt>（本机镜像可读：<https://hf-mirror.com/Qwen/Qwen-Image-2.1-PE-I2I/resolve/main/system_prompt.txt>） | 本报告 §4 的核心依据；全文已存 `tmp/qwen-prompt-lab/prompts/official-pe-i2i-system.md` |
| PE-T2I 系统提示词 | <https://huggingface.co/Qwen/Qwen-Image-2.1-PE-T2I> | 「观察式」长段英文描述：8 步流程、约 20 句/400–500 词、开场句点名媒介/风格/主体/背景、约 10 个方位短语、布光独立一句、结尾整体构图一句、禁用质量词与分辨率 |
| Qwen-Image（2509/2511）GitHub README | <https://github.com/QwenLM/Qwen-Image> | 2509 多图示例、2511 单图示例；**"We have observed that editing results may become unstable if prompt rewriting is not used."**（官方承认不用提示词改写时编辑不稳定）；2511 多人物/多图一致性增强 |
| 阿里云百炼 · 千问-图像编辑 使用指南 | <https://help.aliyun.com/zh/model-studio/qwen-image-edit-guide> | 官方中文长段示例：`帮我生成一张充满高级感的都市风格女性写真，画面中人物完美保留输入图片中这位年轻女性的面部特征与一头柔顺的黑色长发。人物换上一套…场景设定在一家装修现代简约的高端咖啡店内…`（单段、先保留后换景，与本项目需求同构） |
| 阿里云百炼 · 图像编辑 API 参考 | <https://help.aliyun.com/zh/model-studio/qwen-image-edit-api> | qwen-image-2.0 系列：`text` 中英文、**上限 1300 Token**；`negative_prompt` ≤500 字符；`prompt_extend` 默认 true（云侧自动改写）；多图示例用「图一/图二」自然语言（云侧 PE 会再改写，与本地契约不同，勿直接照抄） |

### 2.2 ComfyUI 官方

| 来源 | URL | 关键内容 |
|---|---|---|
| Qwen 2.1 Image Edit 模板 | <https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_image_edit.json> | 内嵌 PE v2（精简版）系统提示词；"image_1 is the edit target"；"up to 10 reference images"；"negative_prompt unused while cfg is 1"；"official pipeline uses about 40-50 with euler" |
| Qwen 2.1 T2I 模板 | <https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_t2i.json> | 内嵌 T2I 改写系统提示词（观察式长段） |
| Qwen 2.1 Turbo Edit 模板 | <https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_turbo_image_edit.json> | 同上 + Turbo 8 步；提示词示例 "Relight the scene as a clear moonlit night… Keep her exact pose, the architecture, the framing and the tree position unchanged."（**肯定式保留 + 主动重打光的范本**） |
| workflow_templates PR #1298 | <https://github.com/Comfy-Org/workflow_templates/pull/1298> | 官方维护者说明：两个 2.1 模板此前 PE 系统提示词**根本没接上**、采样参数与权重训练值不一致；PE 权重是带 reasoning block 训练的，`thinking` 关掉会掉质量；上游 `max_length` T2I 16256 / Edit 24000 |
| Comfy-Org/Qwen-Image-2.1 模型卡 | <https://huggingface.co/Comfy-Org/Qwen-Image-2.1> | 文件清单、PE 权重说明、工作流索引（含 background removal） |
| ComfyUI 文档 · Qwen-Image-Edit | <https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit> | 2509 原生工作流与参数表（Qwen Team: 50 步 / cfg 4.0；Comfy 原版: 20 步 / cfg 2.5；Lightning: 4 步 / cfg 1.0） |
| ComfyUI 文档 · Qwen-Image-Edit-2511 | <https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit-2511> | 2511 工作流与模板说明 |
| workflow_templates issue #1401 | <https://github.com/Comfy-Org/workflow_templates/issues/1401> | 用户反馈 2.1 T2I 默认出噪声（提示：评测时先确认参数/种子基线，避免把参数问题误判成提示词问题） |

### 2.3 官方 PE-I2I 的 12 条硬规则（原文摘录 + 中译）

> 以下均为 PE-I2I 系统提示词原文，是本报告最核心的依据；完整全文见 `tmp/qwen-prompt-lab/prompts/official-pe-i2i-system.md`。

| # | 原文 | 中译要点 |
|---|---|---|
| 1 | "Edit exactly the attribute(s) the user named, push each to a strong and unmistakable degree, and hold everything else at input fidelity." | 只改被点名的属性，且改到 unmistakable；其余保持输入保真 |
| 2 | "Preservation locks content, never edit strength." | 保留声明锁的是「内容」，不是削弱改动强度 |
| 3 | "Say what stays, without repainting it. Name the untargeted content by type, position and role rather than describing its appearance… A preservation description reads to the model as a generation instruction: the more concretely you describe something you meant to keep, the more likely it drifts." | 不要细描你要保留的东西（越细描越容易漂移），按「类型+位置+角色」点名即可 |
| 4 | "Identity is the hardest invariant… When identity comes from a reference image, point at that image rather than describing features in words — verbal descriptions make the model regenerate and degrade the likeness." | 身份最易漂移；**指图，不要用文字描述长相** |
| 5 | "Anchor on the image. Every spatial, tonal and contextual claim comes from what is visibly there… a preserved element described at a higher level of abstraction is always safer than an invented specific." | 以图为准，不发明参考图里没有的具体细节 |
| 6 | "How much you build is intent-branched. When the user wants this picture changed … clarify and constrain… When the user wants a new picture of this subject (placing a subject in a new scene, compositing across images…) construct actively: design the scene, lighting, composition and layout to a professional standard." | 新图/跨图合成 → 主动设计场景/布光/构图；局部修改 → 克制 |
| 7 | "For Multi-Image Input (N >= 2), the rewritten instruction MUST use `<image1>`, `<image2>`, ... Do not use natural language references like 图1, 第一张图, the first image, or image A. This tagging format is mandatory and non-negotiable. For single-image input (N = 1), do NOT use tags — refer to the image naturally." | 多图必须 `<imageN>`；单图**不要**标签，自然指代 |
| 8 | "State each image's role explicitly — which one is the canvas whose composition and untargeted content survive, and which supply material to transfer — and say what is taken from each. For scene generation with no canvas (合影/合照…), all images serve as identity sources. Describe every referenced image individually." | 逐图声明角色；无画布的合成场景里所有图都是身份来源；每张图单独描述，不合并成一组 |
| 9 | "The entire rewritten prompt must be a single continuous paragraph with NO line breaks or newline characters." | 单段、无换行 |
| 10 | "Never include any resolution or aspect ratio information (e.g., 2:3, 16:9, 1920x1080, 2K, 4K)." | 不写分辨率/比例 |
| 11 | "State requirements affirmatively (「保持背景与输入图完全一致」) rather than as prohibitions (「禁止改变背景」)." | 肯定式，不用禁令 |
| 12 | "Write it as an instruction. Lead with the operation, not a description of the finished picture." | 先写操作指令，再描述画面 |

补充（与姿势迁移直接相关）：PE-I2I 的「画布」判定表把**换装（clothing swap）的画布定为人物图**；「无画布的合影/合照类」全部图都当身份来源。本项目工作流画布由姿势图尺寸决定、内容全生成（见 1.2），属于「无画布的新场景合成」→ 应主动构建场景，且不写比例。

---

## 3. 社区实践

### 3.1 GitHub：真实 ComfyUI + Qwen-Image-Edit 项目记录（最有价值的失败经验）

来源：<https://github.com/kelvin78901/AIVideoGenerationAgent/pull/6>（一个真实剧集分镜项目的 PR 描述，2026-10-26，含本机 5090 + ComfyUI 0.41.2 真跑记录）

可直接复用的结论：
1. **人物一致性可以很好**：用锁定的人物参考图出关键帧，「脸型、低马尾、卡其色风衣配深色衬衫」都稳定带过来（说明参考图链路本身没问题，问题主要在指令写法/构图绑定）。
2. **「提示词里提到参考图里没有的人/物 → 模型自己造」** 是真实故障：把整场俯视站位写成「林晚在画面中间」时，模型画了个陌生人；修复办法是「**只写这个镜头参考素材里有的人和道具**」。→ 对应规范第 5 条「不发明参考图没有的具体细节」。
3. **参考图是拼图/分格图 → 输出跟着分格**：加「单幅画面，不要分格或拼图」后 10/10 单幅；后来把场景参考图固定为横屏 16:9 后进一步稳定（3/4）。→ 说明**构图约束要用肯定式的视觉状态写清楚**（「单幅写实照片」），并让参考图本身格式一致。
4. **剧情文本里的细节会直接画出来**：剧本写「湿了半边」（描述衣服）→ 风衣出现污渍；改成「被雨淋湿」即消失。→ 与主体无关的细节词会污染画面，提示词只应包含你要的画面状态。
5. **4 步加速 LoRA 下同提示词多张很相似，官方 50 步更多样**；本地 Qwen-Image-Edit 出 3 张约 15–19 秒（5090，31.4GB 峰值）。→ 与「25 步 vs 40 步」的评测变量相关。
6. 同项目对比测试里 FLUX 3 Klein 在场景还原/近景准确度上优于 Qwen-Image-Edit（该结论针对 2509 级编辑模型 + 该项目的写实需求，**不能直接外推到 2.1**）。

### 3.2 GitHub：Qwen 提示词工程化仓库（社区对官方规范的二次整理）

来源：<https://github.com/twj515895394/image-prompt-skill>（SKILL.md，19KB，含 Prompt Finalization/QC 合同；相关 PR <https://github.com/twj515895394/image-prompt-skill/pull/4>）

可交叉验证的结论：
1. **默认最终表达采用 Qwen-Image-2.1 Prompt Enhancer 所体现的自然语言规范作为跨模型基线**；T2I 默认最终化为「Qwen-compatible 的英文观察式画面描述」，Image Edit 默认最终化为「属性解耦的编辑指令」。
2. 多图输入「**不要平均融合**」，必须判断每张图的职责（人物/服装/场景/构图/光影/风格由哪张提供）——与 PE-I2I 第 8 条一致。
3. 参考图任务必须明确四件事：**保留什么、修改什么、允许什么变化、禁止什么出现**；负向限制只针对当前最危险的失败模式，「最终化阶段优先转换为正向视觉状态」——与 PE-I2I 第 11 条一致。
4. 其 QC 脚本检查的机械规则：「T2I 命令式语言、空泛 booster、比例/像素泄漏、单图/多图标签、Qwen 字段互斥」——可作为我们代码里 lint 提示词的自检项。
5. 多图换装被列为独立回归场景（`多图换装`），说明这是社区公认的高频/高难场景。

### 3.3 GitHub：官方仓库 issue 中的工程事实

- <https://github.com/QwenLM/Qwen-Image-2.1/issues/23>：PE 改写模型在 H20 上 T2I 一次约 10 秒（"prompt rewriter 在 H20 单卡 T2I 测试耗时需要 10 秒"）→ 本机如果以后打开 PE，每次出图要多 10 秒级延迟，这也是模板默认关闭 PE 的现实原因。
- <https://github.com/QwenLM/Qwen-Image-2.1/issues/19>：PE 的 edit profile 请求 24000 输出 token，会超出默认服务上下文（说明 edit 改写预算远大于 T2I，官方重视 edit 提示词的完整度）。
- <https://github.com/QwenLM/Qwen-Image-2.1/issues/14>、<https://github.com/QwenLM/Qwen-Image-2.1/issues/5>：2.1 在部分量化/设备组合下出现竖条纹伪影——与提示词无关，但提示我们评测时要固定量化/设备，避免把伪影当成提示词效果。

### 3.4 中文社区与 Reddit：未找到可引用的可靠来源（如实说明）

- 本环境 `web_search` 工具当日返回 401（认证失败），无法做常规检索；改用 `web_fetch` 直接抓取已知 URL + GitHub API 检索。
- Reddit `old.reddit.com` / `www.reddit.com` 抓取失败（TypeError: fetch failed，网络不可达）。
- 知乎搜索页返回 **HTTP 403**（反爬），CSDN 通过 Bing 检索只得到泛化结果、无对应 Qwen-Image-Edit 提示词文章可确认。
- 因此本报告的中文社区证据**只采用可实际抓取的 GitHub 中文项目记录**（§3.1/§3.2）；「知乎/CSDN/微信上的说法」未纳入，避免编造链接。若后续需要中文社区样本，建议在可联网环境补 Reddit r/StableDiffusion、r/Qwen_Image、知乎「Qwen-Image-Edit」话题、B 站教程评论区做人工抽样。

---

## 4. 对比结论（预期胜负 + 依据 + 适用条件）

> 证据等级：A = 官方原文/官方示例；B = 官方模板/代码/维护者说明；C = 社区实测；D = 推断/待实测。
> 对应评测变体：`tmp/qwen-prompt-lab/prompts/variants.json` 的 R1（短指令）、R2（单段长描述，`<imageN>`，中文）、R3（R2 但「图N」）、R4（R2 英文版）。每 case 一套，共 12 runs，seed 用原值。

### 4.1 中文 vs 英文

- **结论**：本地 Qwen 2.1 链路中文完全可用，且官方 PE-I2I 明文规定「用户指令是中文 → 描述就用中文」（决策 A）。预期中文与英文**接近**；中文在「服饰/姿势中文术语」上更省 token、歧义更少；英文在细粒度美学词（织物、光位、镜头）上词汇更丰富。→ 预期 R2（中文）与 R4（英文）差距不大，中文略优或不显著；**待实测**（D，规范支持中文为 A）。
- 依据：PE-I2I 决策 A（A）；PE-T2I 强制英文仅适用于 T2I 改写（A）；Qwen3-VL 8B 文本编码器为中英双语模型（A/B）；阿里云官方中文长段示例效果展示（A）。
- 适用条件：**不要中英混杂**；`<imageN>` 标签本身是英文形态，保留原样即可；引号内文字（若画面要出现字）必须单一语言（PE-I2I 决策 B）。

### 4.2 长提示词 vs 短指令

- **结论**：**PE off（本机现状）→ 长（单段 300–550 汉字）明显更稳**；PE on → 短指令即可（PE 会扩写）。预期 R2 > R1，尤其在姿势还原、背景质量、手部结构上。
- 依据：Qwen 2.1 官方示例单图编辑是长段（A）；官方多图示例的短句来自「有 PE 改写」的调用方式（A/B）；Qwen-Image-Edit 官方 README 承认「不用 prompt rewriting 结果不稳定」（A）；本机 PE 默认 off（B）。
- 适用条件：短指令适合「单张图局部改一个属性」（如换发色、换背景），本项目的三图合成不属于局部编辑，必须长段。长度上限参考：云侧 2.0 系列 text ≤1300 Token（A）；建议本地 350–600 汉字，硬上限 800 汉字（超出收益递减且可能挤压视觉 token 预算）。

### 4.3 单段连续 vs 分点列表

- **结论**：**单段**。分点列表与官方输出契约直接冲突，且会把「一条指令」拆成互不相关的属性清单，模型更容易只满足其中几条（典型：脸和衣服对，姿势/构图丢）。不需要实测也有 A 级依据；R2 vs 旧 baseline 的对比即是证据。
- 依据：PE-I2I "single continuous paragraph with NO line breaks"（A）；PE-T2I 同（A）；社区 QC 规则也无「列表」写法（C）。
- 适用条件：没有例外。要「分点」的只有人看的报告，不是模型输入。

### 4.4 `<imageN>` 标签 vs 自然语言「图N」

- **结论**：**多图必须 `<imageN>`**，预期 R2 明显优于 R3（尤其姿势还原与服装细节归属）。这是本报告最确定、收益最大的单项改动。
- 依据：PE-I2I 第 7 条（A，措辞 "mandatory and non-negotiable"）；ComfyUI 2.1 模板 MarkdownNote（B）；`qwen_image21.py:22-24` 的自动拼接机制（B）；自然语言指代在其他模型上可用，但 2.1 的文本编码器期望标签（D，机制推断）。
- 适用条件：**单图（N=1）不要用标签**，按官方用自然指代（「图中的人物」「照片里的人体模型」）。注意：ComfyUI 在 N=1 时也会自动插 `<image1><vision>` 视觉占位符，但那是模型侧的绑定，不等于要求文本里写 `<image1>`；按官方规范自然指代即可。
- 其他组合：双图固定模板的送图顺序是「`<image1>`=姿势、`<image2>`=人像/服装」（见 `aiGenerator.ts:217-223` 的 `poseFirst` 注释），所以双图提示词里的标签顺序必须按实际送图顺序写，**不能沿用三图的「人像在前」**。
- 需要正视的反证：`aiGenerator.ts:148-149` 的现有注释写着「用自然语言逐项描述（人物 / 服装 / 姿势），实测比堆砌要点更能让多图编辑模型还原服装、避免照搬人体模型线条」。这条旧结论**很可能来自 2509/旧工作流链路**（`qwen_image_edit_2509` 用的是 Qwen2.5-VL 编码器，官方示例本来就用自然语言），不能直接外推到 2.1。R2 vs R3 正是为了裁决这一点：**若 R3 不劣于 R2，则保留自然语言写法；若 R2 明显更好，则 2.1 链路必须切标签。**（结果待 Lead 回填，见 §4.11）

### 4.5 正向肯定式 vs 负向「不要…」

- **结论**：**肯定式**。本机 cfg=1.0 负向提示词无效（B，模板原文），「不要…」既不会生效，又可能把被否定的概念带进画面（如「不要白模」→ 白模概念被激活）。全部转成「目标状态是什么」。
- 依据：PE-I2I 第 11 条（A）；cfg=1 注（B）；PE-T2I「不要质量词」同理（A）。
- 适用条件：没有任何需要否定的场景；需要「排除」时改写成「A 来自 `<image1>`，B 来自 `<image2>`，`<image3>` 只提供动作与机位」这种**来源声明**，而不是禁令。

### 4.6 是否主动写场景 / 布光 / 构图 / 镜头

- **结论**：**必须写**。本项目属于「无画布的新场景合成」，官方要求主动构建到专业水准；不写就会得到模型默认背景（白底/中性棚拍），这正是「背景呆板、棚拍感」的来源。
- 依据：PE-I2I 第 6 条（A）；官方 2.1 单图编辑示例主动写「calm deep-blue sea / sunlight from the front left / entire vessel fits inside the frame」（A）；官方 Turbo edit 示例写「moonlit night + only light source + long soft shadow」（A）；PE-T2I 第 7 步要求布光独立成句、第 8 步整体构图收束（A）。
- 写法要求：场景是「开放项」——可以设计工作室/街道/卧室；参考图里的人物/服装属性是「锁定项」——不能加。分两段：先写**场景+光位+光质+投影**，再写**镜头焦段+视角+构图+入镜范围**。
- 与「背景呆板」的关系：本工作流画布内容不被参考图锁定（1.2），所以背景 100% 由提示词决定；旧提示词完全没写背景 → 模型只能给默认纯色/棚拍。

### 4.7 质量词 / 分辨率 / 风格词

- **结论**：不写分辨率、比例、2K/4K/8K、masterpiece/best quality/超清/极致画质；写具体介质和材质（「85mm 人像定焦」「35mm 富士胶片」「针织/皮革/羊毛的真实面料质感」「自然肌肤质感与自然光泽」）。风格词全篇只出现一次，作为整体收束。
- 依据：PE-I2I 第 10 条（A）；PE-T2I "No quality boosters"（A）；旧提示词的「8k 高清画质」属于典型无效 booster（D→实测可验证 R2 vs baseline 的细节密度）。
- 适用条件：分辨率由工作流节点决定（本机 ≈1152×1536），比例由姿势图/节点决定（B）；提示词写比例只会与节点冲突。

### 4.8 身份：文字描述 vs 指向图片

- **结论**：**指向图片**。旧实现逐项写「脸型、五官、发型（中长发）、发色」是官方明确反对的做法（越描述越容易重生成、降低相似度）。推荐句式：「`<image1>` 提供面部身份、发型与发色，面部身份、发型与发色保持与 `<image1>` 一致」。
- 依据：PE-I2I 第 3/4 条（A）；社区经验里人物一致性靠「锁定参考图」而不是文字描述（C）。
- 适用条件：如果用户提供了结构化的发型/服装名称，可以把名称作为**辅助锚点**放在角色声明里（如「`<image2>` 展示的整套服装：灰色针织迷你连衣裙、黑色连裤袜、靴子、毛绒包」），但不要展开外观描述；命名的作用是消歧，不是让模型重画。

### 4.9 Qwen 2.1 与 Qwen-Image-Edit 2509/2511 的契约差异（不能互抄）

| 维度 | Qwen Image 2.1（本项目） | Qwen-Image-Edit 2509 / 2511 |
|---|---|---|
| 文本编码器 | Qwen3-VL 8B（统一生成/编辑） | Qwen2.5-VL 7B |
| 节点 | `TextEncodeQwenImage21` | `TextEncodeQwenImageEditPlus` |
| 多图指代 | **`<imageN>`（强制）** | 官方示例是自然语言：「image 1」「图一」「the input sketch」 |
| 提示词形态 | 单段编辑指令（PE 输出形态）；官方模板内嵌 PE 系统提示词 | 短指令为主（如 2511 模板 "Change the furniture leather difference in image 1 to the fur material in image 2."） |
| 官方参数 | 40–50 步 euler、cfg=1（官方 2.1 路径） | 2509：Qwen 50 步/cfg4.0，Comfy 20 步/cfg2.5，Lightning 4 步/cfg1；2511：40 步/cfg4.0 或 4 步 Lightning |
| 提示词改写 | 官方强烈推荐 PE（T2I/I2I 两套 9B 模型） | 官方也推荐改写（"unstable if prompt rewriting is not used"），但云端/社区多用短指令 |

→ 本项目必须走 **2.1 列**：`<imageN>` + 单段 + PE 输出形态；不要把 2509 的「image 1」短指令写法直接搬过来（R3/R1 变体正是为了量化这个差异）。

### 4.10 与「姿势丢失」相关的三个假设（R2/R3 实测结果见 §4.11 与 §7.4）

1. 「图3」在文本里没有视觉绑定（标签问题，§4.4）→ 姿势指令事实上被当成普通文本。
2. 「图3只是动作示意」这种弱化措辞（加上 cfg=1 无负向）把姿势参考的权重压低了；同时旧提示词没写「身体朝向 / 镜头机位 / 关节」。
3. 分点结构把姿势句夹在中间，且前后都是「真人/比例/不要白模」等强约束，模型优先满足了身份与服装，牺牲了姿势。
→ R2 的写法逐条对冲：`<image3>` 标签绑定 + 独立一句具体动作/朝向/机位 + 明确「`<image3>` 只提供动作与机位」+ 正向关节/结构描述。

---

### 4.11 待实测变量登记（评测结果出来后由 Lead 回填本文）

> 本节登记本轮及下一轮的待验证变量（至少包含中文 vs 英文、长 vs 短、标签 vs 图N 三项），**不是已定论**；当前只给出规范依据与预期，等 `local-eval` 出图后由 Lead 回填结论。

| 变量 | 对比 | 当前依据与预期 | 状态 |
|---|---|---|---|
| `<imageN>` vs 「图N」 | R2 vs R3 | A 级规范要求 `<imageN>`（PE-I2I 强制、模板文档、`qwen_image21.py` 原生拼接）；但 `aiGenerator.ts:148-149` 旧注释记录过自然语言更优（疑为 2509 链路）。预期 R2 > R3，尤其姿势/服装归属 | ✅ 实测：**同种子下几乎同图，二者等价**（3 case 视觉差异仅在边缘细节）。结论：官方规范优先，继续用 `<imageN>`（零成本、与官方一致），但不作为质量杠杆 |
| 长单段 vs 短指令 | R2 vs R1 | PE off 下长段更稳（官方编辑示例 + Qwen-Image-Edit 官方承认不用改写不稳定）；PE on 时短指令可被扩写。预期 R2 > R1（姿势/背景/手部） | ✅ 实测：**长单段整体更好**（2/3 case 总分更高，审美 +0.5~+1.5，场景/布光成立）；短指令的意外优势是更听姿势参考、配饰更全（无场景文本抢戏）。结论：采用长单段，但必须补「机位硬锁 + 配饰穷尽」两条（见 §7 R-4/R-6） |
| 中文 vs 英文 | R2 vs R4 | PE-I2I 决策 A 支持中文（用户中文→描述中文）；PE-T2I 强制英文仅适用 T2I；Qwen3-VL 中英双语。预期接近、中文略优或不显著 | ✅ 实测：**完全等价**（同种子几乎同图）。结论：保持中文，无需双语 |
| 步数 25 vs 40–50 | 同 prompt 两版 | 官方 2.1 推荐 40–50 步 euler（模板原注）；25 步可能限制细节/手部。本轮 12 run 未隔离该变量 | ✅ 实测：**40 步 ≈ 25 步**（几乎无差异，耗时 +30%）。结论：默认保持 25 步；高质量模式仅作可选（负面词 + 更高 CFG），不靠加步数 |
| 参考图顺序：姿势优先 vs 人像优先 | 6 runs（3 case × 2 顺序，语义相同的单段提示词） | 机制推断：官方模板规定「image_1 是编辑目标、其余是参考」，把姿势图放 image_1 似乎应提升姿势/构图跟随 | ✅ 实测：**顺序不是主要变量**——3 个 case 两个顺序的姿势还原都在同一水平（standing：都正确还原跪姿；lying：都接近仰卧抬腿；short_hair 的俯卧俯视两组都失败），身份/服装无明显差异，也未见照搬白模线稿。**结论：不改工作流顺序**，姿势跟随主要取决于提示词是否把动作/朝向/机位写清楚 |
| PE off vs on | 短指令 + PE | PE on 通常更好但 +10 秒级/次（官方 issue #23）；开启后提示词必须切换为短指令（§5.7） | ⏳ 未进入本轮预算 |

回填状态：本表除「PE off vs on」外均已回填实测结论（2026-11-10，27 run）；完整评分矩阵见 `tmp/qwen-prompt-lab/eval-report.md`。

---

## 5. 可直接抄用的《提示词构建规范》（指导代码生成）

> 本节是给 `buildRecipePrompt()` 重构用的规则清单，可直接映射为常量与拼装函数。

### 5.1 语段骨架（仍是一段连续文本，6 个语块按顺序拼接）

| 顺序 | 语块 | 写法 | 示例 |
|---|---|---|---|
| ① 操作指令 | 先写要做什么 | 「以`<image1>`中的人物为主角，生成一张<风格>的<全身/半身>照片：让人物穿上`<image2>`展示的整套服装与配饰，并按`<image3>`中人体模型的动作与镜头机位摆姿势——<具体动作>。」 |
| ② 图像角色声明 | 逐图声明谁提供什么 | 「`<image1>`提供面部身份、发型与发色，`<image2>`提供服装的颜色、款式、面料与全部配饰，`<image3>`只提供动作、身体朝向与镜头机位。」 |
| ③ 场景与布光 | 场景 + 光位 + 光质 + 投影 | 「画面置于<场景>：<背景/环境>，<主光方位+光质>，<轮廓光/补光>，<地面/接触阴影>。」 |
| ④ 构图与镜头 | 焦段 + 视角 + 构图 + 入镜范围 | 「镜头为<焦段/相机>、<平视/俯视/仰视>、<竖/横构图>，人物位于<位置>，<头顶/双脚/双手>完整入镜。」 |
| ⑤ 保留 + 正向人体结构 | 一句肯定式保留 + 一句正向结构 | 「面部身份、发型与发色保持与`<image1>`一致，服装每件单品保持与`<image2>`一致；头部、颈部与肩膀自然连接，双手手指完整、左右手结构正确，膝盖与脚踝自然弯曲，皮肤呈现真实肌肤质感…」 |
| ⑥ 整体收束 | 风格 + 色调一句 | 「整体为<风格>，<光线/色调>统一。」 |

要求：①–⑥ 之间用「；」「，」连接，**全篇一个段落、无换行**；不写「重要」「务必」「注意」；不写「画面中没有任何文字」。

### 5.2 各参考组合的编号规则（必须由代码按实际送图顺序生成）

| 组合 | 参考图槽位（实际送入顺序） | 提示词标签 | 说明 |
|---|---|---|---|
| 三图（人像+服装+姿势） | image_1=人像、image_2=服装、image_3=姿势 | `<image1>`/`<image2>`/`<image3>` | 本项目默认；角色声明按此写 |
| 双图固定模板（人像+姿势） | **image_1=姿势、image_2=人像**（`poseFirst`，见 `aiGenerator.ts:217-223`） | `<image1>`=姿势、`<image2>`=人像 | 提示词必须按「姿势在前、人像在后」写；旧的 `replace(/图1/g...)` 文本交换逻辑要替换为**按槽位映射生成标签** |
| 双图（服装+姿势，无人像） | image_1=姿势、image_2=服装 | `<image1>`=姿势、`<image2>`=服装 | 自由生成面部，需加正向句：「生成一位面部自然、与画风匹配的成年女性，面部五官清晰、左右对称」 |
| 灵活参考（任意张数） | 由 `getFlexReferenceOrder()` 决定 | 按实际顺序动态编号 | 代码里不要硬编码 `<image1>`=人像；用「槽位 → 标签」映射表 |
| 单图（仅姿势） | image_1=姿势 | **不用标签**，自然指代 | 官方：N=1 时 "do NOT use tags — refer to the image naturally"；写「图中的人体模型 / 照片中的人体模型」 |
| 单图（仅人像） | image_1=人像 | 不用标签 | 如果目标是「基于人像生成新图」，按官方单图场景生成规则写自然指代 |

### 5.3 长度、语言与结构

| 项 | 规范 |
|---|---|
| 语言 | 中文（与用户指令语言一致；PE-I2I 决策 A）。全篇单一语言；`<imageN>` 标签保留英文形态 |
| 长度 | 三图合成：350–700 汉字（本机落地实现实测 620–690 字、含机位硬锁与配饰穷尽后仍表现良好）；双图：300–600 汉字；单图：250–500 汉字。硬上限 800 汉字 |
| 句数 | 6–12 句；每句一个功能（操作 / 角色 / 动作 / 场景 / 光 / 构图 / 保留 / 结构 / 收束） |
| 段落 | **1 段，无换行、无分点、无编号、无 markdown**（唯一例外：PE-I2I 允许「图像分成堆叠区域」时按区域分段，本项目不适用） |
| 风格词 | 全篇只出现一次，放在开头（「写实商业摄影 / 35mm 富士胶片 / 2.5D 半写实游戏原画 / 国风工笔」等）或结尾收束，不重复堆叠 |
| 引号 | 只有「要在画面里出现的文字」才用引号；本项目默认不出现文字，全篇不用引号 |

### 5.4 禁用项（代码级 lint，命中即报错）

1. 分辨率 / 比例 / 像素数：`2K` `4K` `8K` `1080p` `1024x1536` `16:9` `3:4` 等。
2. markdown 分点：`•` `-` `1.` `\n` `##`。
3. 多图场景中的「图N」「图一」「第一张图」「the first image」「image A」。
4. 否定式：`不要` `禁止` `避免` `不能` `无` `没有` `no ` `without `（例外：`no` 是英文单词的一部分时不可能出现，因为全中文；「避免」等一律替换）。
5. 质量堆词：`8k` `超清` `高清画质` `masterpiece` `best quality` `award-winning` `极致` `顶级` `大片感`。
6. 空洞抽象词不带具体视觉参数：`高级感` `氛围感` `电影感` `大片感` `质感拉满`。
7. 对身份的逐项外观描写：`脸型` `五官` `发色一致` `发型（中长发）` 等（改为「面部身份、发型与发色保持与 `<image1>` 一致」）。
8. 「重要」「务必」「必须」「切记」「不要忘记」等元话语。
9. 画面文字/水印声明（除非业务需要写字）。
10. 中英混杂的整句（标签除外）。
11. 同一约束重复两遍以上（保留声明只写一次）。
12. 表情包式限制堆叠（一次超过 2 条无关约束）。

### 5.5 正向化改写对照表（旧 → 新）

| 旧（否定式/低效） | 新（肯定式/可观察） |
|---|---|
| 不要照搬人体模型的白模材质、接缝与拼接线 | `<image3>` 只提供动作、身体朝向与镜头机位；人物皮肤呈现真实肌肤质感与自然光泽 |
| 不要断头、颈部错位或头部悬浮 | 头部、颈部与肩膀自然连接 |
| 每只手 5 根手指、不粘连、不多手缺手 | 双手手指完整、左右手结构正确 |
| 不要幼态、过度瘦弱或比例失调 | 成年女性，真实自然的全身比例（约 7.5 头身），肩颈与腰胯曲线自然 |
| 背景不要白底棚拍感 | 画面置于<具体场景>：<具体环境>，<具体光位与光质> |
| 画面中没有任何文字、标志或水印 | （删除；默认不生成文字） |
| 图3只是动作示意 | `<image3>` 只提供动作、身体朝向与镜头机位 |
| 保持其脸型、五官、发型（中长发）和发色一致 | 面部身份、发型与发色保持与 `<image1>` 一致 |
| 每件单品的颜色、款式、面料与配饰都以图2为准 | 服装每件单品保持与 `<image2>` 一致 |
| 避免大头小身 | 头部与肩宽、腰胯、四肢比例协调 |
| 光影统一 | <具体光位>下的自然明暗过渡，整体色调统一 |

### 5.6 场景 + 布光 + 构图段落模板（按风格预设映射）

```text
画面置于{场景描述}：{背景/环境}，{主光方位}{主光光质}作为主光，{轮廓光/补光}，{地面/接触阴影}。
镜头为{焦段或相机质感}、{平视/俯视/仰视}、{竖构图/横构图}，人物位于{画面位置}，{入镜范围}完整入镜。
```

可用预设（与现有风格预设对齐，仅示例，实施时按项目 `STYLE_PRESETS` 补全）：
| 风格预设 | 场景 | 光 | 镜头/构图 |
|---|---|---|---|
| 写实商业摄影（85mm） | 安静的自然光摄影棚，浅灰无缝背景 | 左前方大面积柔光主光 + 右后方冷色轮廓光，地面柔和渐变投影 | 85mm 人像定焦、平视、竖构图、全身入镜 |
| 35mm 富士胶片街拍 | 午后城市街道，人行道与浅色墙面，远处街景虚化 | 侧逆光穿过发丝与衣缘，地面柔和拉长影子 | 35mm、略低机位或平视、竖构图、自然抓拍感 |
| 2.5D 半写实游戏原画 | 柔和渐变背景/虚化场景（不写具体现实地点） | 左上方暖色主光 + 右侧冷色边缘光，布料与金属有明确高光 | 中长焦、平视或微仰、全身/七分身、居中构图 |
| 国风/工笔（若有） | 素色背景或简约庭院 | 均匀柔光、淡雅投影 | 长焦压缩、平视、留白构图 |

**落地补充（2026-11-10 迭代，按需求改为「参考图驱动」）**：实测发现「写实人像写真」原有场景是「浅灰无缝摄影棚」，出图观感等同于没有背景；同时用户不希望用固定场景清单来选背景。最终实现为**背景由参考图自动驱动、无固定选项**：
1. 参考图里带场景（上传的人像 / 服装 / 姿势图）→ 提示词写「画面背景、环境与整体光线参考 `<imageN>`/上传参考图的场景氛围」；若该参考图是纯色或白底，则根据服装风格与姿势自动补协调的真实环境，避免白底空背景。
2. 素材库的素体白模 / 服装人台 / 证件照没有环境信息 → 根据服装分类与标签（泳装→海边、睡衣→卧室、礼服→宴会厅、冬装→暖调室内/雪街等）、姿势族（躺卧→卧室床品）、画风布光（写实窗光、胶片侧逆光等）**自动生成**协调的背景，不写死具体场景选项。
3. 写实类画风（`realistic` / `fashion` / `film` / `none`）不再写固定场景，只保留布光/色调；风格化画风（二次元/漫画/3D/赛博朋克等）仍保留其标志性场景，这是画风本身的一部分。
4. 该背景策略对 qwen21 与 classic 两种范式都生效。

### 5.7 PE on / off 两种调用契约（代码必须区分）

| 模式 | 本机现状 | 提示词形态 | 备注 |
|---|---|---|---|
| PE **off**（当前） | 默认 | 本规范 §5.1 的完整长单段 | 我们自己在代码里完成「改写」 |
| PE **on**（未来可选） | 需接线并开 thinking | 只给短指令（20–60 字：图角色 + 操作 + 关键约束） | 官方模板说 on 通常效果更好但慢（H20 上 +10 秒/次）；`max_length` 官方 24000（edit） |

### 5.8 代码改造清单（不改 `src/`，仅建议）

1. 把 `buildRecipePrompt()` 的输出从 `lines.join('\n')` 改为**单段**拼接：`[opening, roleDecl, poseDetail, sceneLight, composition, preservation, anatomy, style].filter(Boolean).join('')`（中文句间用「。」，最后不加换行）。
2. 新增 `tagOf(role, order)`：根据实际送图顺序返回 `<imageN>`；删除 `text.replace(/图1/g...)` 的 `poseFirst` 文本交换逻辑。
3. 删除 `clauses` 里所有「•」前缀与「（重要）」；删除最后一行「画面中没有任何文字、标志或水印」。
4. 身份句改为指向式：`面部身份、发型与发色保持与${tagOf('portrait')}一致`；不要再拼 `portrait.发型名称`。
5. 服装句保留名称作为消歧（`${tagOf('costume')}展示的整套服装与配饰（灰色针织迷你连衣裙、黑色连裤袜、靴子、毛绒包）`），但去掉「每件单品的颜色、款式、面料与配饰都以图N为准」的复述式长句。
6. 姿势句改为：`人物按${tagOf('pose')}中人体模型的动作与镜头机位摆姿势——{姿势名称}，{角度}` + 独立角色声明 `，${tagOf('pose')}只提供动作、身体朝向与镜头机位`；`freeFace` 分支加正向句「生成一位面部自然、与画风匹配的成年女性，五官清晰、左右对称」。
7. 新增 `SCENE_LIGHTING[stylePreset]` 与 `CAMERA[stylePreset]` 两张映射表（§5.6）。
8. 删除「8k 高清画质」「人物比例协调，手部与五官自然，光影统一」这类泛化正向句，替换为具体材质/光/结构描述。
9. 加一个 `lintPrompt()`（§5.4 的 12 条）在开发模式下断言，防止回归。
10. 双图固定模板的槽位顺序（姿势在前）要写进 `tagOf` 的映射，避免再靠字符串替换。

---

### 5.9 本地 ComfyUI Qwen 2.1 落地规则（必须遵守）

> 本节专门针对本机链路落地：ComfyUI 0.43.0 + `qwen_image_2.1_int8_convrot` + `qwen3vl_8b_bf16` + `TextEncodeQwenImage21`，KSampler euler/simple **25 步、cfg=1.0**，输出约 1152×1536（画布形状来自姿势图，见 §1.2）。前几节的通用规则仍然适用，本节是**本项目特有的 4 个坑**。

#### 5.9.1 与姿势冲突的固定句必须按姿势动态化

现状（`src/services/aiGenerator.ts`）：
- `PROPORTION_FULLBODY_PHOTO`（154–155 行）末尾固定写「头顶与双脚均完整入镜、不被裁切，**站姿与关节自然**」；
- 该句在「上传姿势 / 全身 / 双人」条件下被**无条件追加**（336–338 行）；
- 另有一句与姿势无关的泛化尾句「人物比例协调，手部与五官自然，光影统一」（369–371 行）。

问题：本项目 4 个真实 case 里 3 个不是站姿（跪立、俯卧、仰卧），「站姿与关节自然」会与 `<image3>` 的动作直接打架——模型要么把姿势拉回站姿（姿势丢失），要么出现别扭的膝/髋关节。同理，「头顶与双脚均完整入镜」对俯卧/仰卧/特写不一定成立（俯卧单手托胸时脚可能本就不在画面里；强行要求会换来奇怪构图或人物被缩小）。

改法：把「比例 / 入镜 / 关节」拆成**按姿势族动态生成**的三段，而不是写死：

| 姿势族（`recipe.pose.体系` / 名称关键词） | 比例 + 入镜句（动态部分） | 关节句（动态部分） |
|---|---|---|
| 站立 / 行走 / 奔跑 | 站姿，双膝自然微曲、双脚着地，头顶与双脚完整入镜 | 膝关节与踝关节自然屈伸 |
| 跪立 / 跪坐 | 跪立姿态，膝盖着地、小腿与脚背自然贴地，髋部稳定 | 膝关节弯曲自然、踝关节放松 |
| 坐 / 蹲 | 坐姿（蹲姿），臀部或脚掌承重自然 | 髋、膝、踝三个关节的角度自然 |
| 俯卧 | 俯卧姿态，身体与支撑面自然接触，肘或手支撑稳定；按 `<image3>` 的机位决定入镜范围 | 肩、肘、腕承重自然，膝关节轻屈 |
| 仰卧 / 侧卧 | 仰卧（侧卧）姿态，背部与支撑面自然贴合，身体放松；按 `<image3>` 的机位决定入镜范围 | 髋、膝、踝自然摆放，脚背放松 |
| 双人互动 | 两人均完整入镜且互不遮挡关键部位，相对站位自然 | 两人的关节结构各自独立完整 |
| 半身 / 特写 | 画面聚焦上半身，头顶完整，身体自然延伸到画外 | 颈部、肩、肘、腕自然 |

实现建议：新增 `POSE_PROPORTION[poseClass]` 与 `POSE_JOINTS[poseClass]`；`poseClass` 从现有 `recipe.pose.体系`（如「跪立」「俯卧」「仰卧」「双人」）与 `角度` 映射；**入镜范围**与 `角度`（正面/侧面/俯视/仰视/斜侧）联动，不要永远要求双脚完整。

#### 5.9.2 白模 / 深度图只作为「动作与机位」参考，措辞必须正向

- 现状：`DETAIL_GUARD`（164–165 行）末尾写「**不要照搬**人体模型的白模材质、接缝与拼接线」。cfg=1 时这条否定不生效，反而把「白模 / 接缝」概念带进上下文。
- 推荐句式（可直接抄）：
  - 有 3D 白模时：`把<image3>中的参考姿态迁移到真实人物身上：<image3>只提供动作、身体朝向与镜头机位，人物的皮肤、服装与发色分别来自<image1>与<image2>。`
  - 有深度图时：`<image3>中的深度图只提供空间关系、动作与机位，画面的颜色、材质与光线按参考图与风格生成。`
  - 呼应句放进结构描述：`人物皮肤呈现真实肌肤质感与自然光泽，服装呈现真实面料质感与自然褶皱。`
- 原理：官方规范是「声明来源 + 肯定目标状态」，而不是「禁止某个来源的特征」。白模自带的「无头 / 灰肤 / 接缝」用「角色声明 + 正向材质」对冲即可（§5.5 对照表）。
- 如果加了正向措辞仍明显照搬白模，优先排查 `<image3>` 是否真的被文本绑定（§4.4），而不是继续追加否定句。

#### 5.9.3 场景 / 布光 / 构图段落按画风预设给模板

场景是「开放项」（可以设计），人物/服装属性是「锁定项」（不能发明，§4.6）。下表与 `STYLE_PRESETS`（`aiGenerator.ts:97-146`）对齐，可直接作为 `SCENE_LIGHTING[stylePreset]` 常量：

| 预设 id | 风格 | 场景句 | 布光 + 镜头句 |
|---|---|---|---|
| `realistic` | 写实人像写真 | 安静的自然光摄影棚，浅灰无缝背景，地面干净 | 左前方大面积柔光主光 + 右后方冷色轮廓光，地面柔和渐变投影；85mm 人像定焦、平视、竖构图、全身入镜 |
| `fashion` | 日韩杂志画报 | 极简摄影棚，纯色或浅灰背景，画面整洁 | 均匀柔光 + 轻微轮廓光，色彩干净；中长焦、平视、七分身或全身、居中构图 |
| `film` | 复古胶片写真 | 午后城市街道，人行道与浅色墙面，远处街景虚化 | 侧逆光穿过发丝与衣缘，地面柔和拉长影子；35mm、略低机位、竖构图、自然抓拍感 |
| `semi_real` | 2.5D 游戏原画 | 柔和渐变背景或虚化的奇幻场景 | 左上方暖色主光 + 右侧冷色边缘光，布料与金属有明确高光；中长焦、平视或微仰、全身/七分身、居中 |
| `anime` | 日系二次元插画 | 干净的动漫场景（教室/街道/室内，按姿势语义选择），背景简洁 | 通透柔光 + 发丝与布料高光；平视、全身立绘式构图、主体居中 |
| `cel_anime` | 新海诚感动画电影 | 带天空与城市光影的开阔场景 | 体积光与逆光高光，清澈高饱和；广角到中焦、平视、竖构图、环境占比更高 |
| `manga` | 日式黑白漫画网点 | 网点纸质感背景或白底 | 黑白对比清晰、无彩色光；平视、全身或七分身、主体居中 |
| `render3d` | 3D 次世代角色渲染 | 暗色或中性背景的展示空间 | 电影级三点布光（主光/补光/轮廓光）；中长焦、平视、全身/七分身、细节清晰 |
| `chibi_box` | 3D 潮玩手办质感 | 柔光棚拍台面，浅色无缝背景 | 大面积柔光箱均匀布光、精致高光与微距景深；平视、轻微俯视、主体居中 |
| `cyberpunk` | 赛博朋克霓虹 | 雨夜街道，霓虹招牌与湿地面反光 | 冷暖双色轮廓光 + 环境霓虹补光；中焦、平视或略低机位、竖构图、环境占比高 |
| `concept_sheet` | 角色设定集（纯白底） | 纯白干净背景，无杂物 | 均匀漫反射布光、无强投影；平视、标准站姿、全身入镜、服装结构清晰 |
| `none` | 无预设 | 简洁的环境化背景（浅色墙面 / 柔和室内），避免纯白底棚拍感 | 自然窗光或柔和环境光；平视、中焦、全身入镜 |

要求：场景句不写「画面中没有任何文字」等否定句（默认不生成文字）；场景里若需要招牌/标识，一律按「模糊、不可读」处理（PE-T2I 建议），本项目默认干脆不写。

#### 5.9.4 长度建议与「不要重复堆叠同一约束」的原因

- **长度预算**：三图合成 350–600 汉字（≈ 6–10 句）；双图 300–500 汉字；单图 250–450 汉字；硬上限 800 汉字。参照：云侧 qwen-image-2.0 系列 `text` 上限 1300 Token（官方 API 文档）；PE-T2I 目标约 400–500 英文词（官方 PE 系统提示词）；`TextEncodeQwenImage21.resolution=1024` 是**图像 token 预算**，不是文本长度上限，但文本过长会挤占注意力、稀释关键指令。
- **为什么不能重复堆叠**：
  1. 同一个约束写 2–3 遍会互相稀释（模型对每条指令的权重被分摊）；旧实现 standing_knit 基线共 **697 字**，其中「不要」4 次、「避免」1 次、「比例」5 次、「自然」10 次、「重要」2 次——重复词很多，但真正可执行的视觉信息密度反而低。
  2. 官方要求「prefer one blanket preservation clause over walking the frame」——一条总括保留句优于逐项复述（§2.3 第 3 条）。
  3. 重复句之间容易互相矛盾：例如「双脚完整入镜」与「俯卧单手托胸」冲突、固定「站姿」与跪/卧冲突（§5.9.1）。
  4. cfg=1 时否定句无效，重复否定只增加上下文噪声（§4.5）。
- **建议结构**：每条约束只出现一次，且放在对应语块里——身份→保留句；服装→服装句；姿势→动作句；场景→场景句；结构→结构句；不要跨段重复。

#### 5.9.5 本机参数使用注意（评测时必须固定）

- `cfg` 必须保持 **1.0**（官方 2.1 路径 + 模板原注）；本机负向提示词在 cfg=1 下无效，不要指望它修手/修姿势。
- `applyComfyQualityBoost()`（169–178 行）会把 `steps` 提到 ≥36、`cfg` 提到 ≥1.8 并写入 `ANATOMY_NEGATIVE`——这与「25 步 / cfg=1」的基准不是同一套参数，**A/B 评测必须固定是否启用**，否则结论不可比。
- 官方 2.1 pipeline 建议 40–50 步 euler（模板原注），本机 25 步；步数是待实测变量（§4.11），不要和提示词变量混在同一轮。

---

## 6. 完整中文示例（可直接用）

> 三个示例分别对应：三图合成 / 人像+姿势双图 / 仅姿势单图。均严格遵循 §5 规范：单段、肯定式、无分辨率/否定句；多图示例用 `<imageN>`，单图示例按官方规范不用标签。示例中的服装与姿势取自本项目 `tmp/qwen-prompt-lab/baseline-prompts.md` 的真实 case，便于与基线对照。

### 6.1 示例 A：三图合成（`<image1>` 人像 / `<image2>` 服装 / `<image3>` 姿势）

```text
以<image1>中的人物为唯一主角，生成一张全新的写实商业摄影全身照片：让人物穿上<image2>展示的整套服装与配饰，灰色针织迷你连衣裙、黑色连裤袜、靴子与毛绒包逐件对应<image2>；人物按<image3>中人体模型的动作与机位摆姿势，双膝跪地、上身后仰、双手抱在脑后，身体正面朝向镜头，镜头平视。<image1>提供面部身份、发型与发色，<image2>提供服装的颜色、款式、面料与全部配饰，<image3>只提供动作、身体朝向与镜头机位。画面置于一间安静的自然光摄影棚：浅灰色无缝背景，左前方一盏大面积柔光作为主光，右后方一层冷色轮廓光勾出肩线与发丝，地面呈柔和渐变的投影。镜头为85mm人像定焦、平视、竖构图，人物位于画面中央，双膝与头顶完整入镜。人物为成年女性，真实自然的全身比例；面部身份、发型与发色保持与<image1>一致，服装每件单品保持与<image2>一致；头部、颈部与肩膀自然连接，双手手指完整、左右手结构正确，膝盖与脚踝自然弯曲，皮肤呈现真实肌肤质感与自然光泽，针织、皮革与羊毛呈现真实面料质感。整体为写实商业摄影风格，自然柔光与统一的暖中性色调。
```

**逐句解释（为什么这样写）：**

| 句子 | 作用 | 依据 |
|---|---|---|
| 以`<image1>`中的人物为唯一主角，生成一张全新的写实商业摄影全身照片 | 开端先写**操作**与产物类型（单张新图、全身、写实）；「唯一主角」防止模型因为三张图而生成多人 | PE-I2I 第 12 条（Lead with the operation）；官方 2.1 单图编辑示例开篇即写明产物 |
| 让人物穿上`<image2>`展示的整套服装与配饰，灰色针织迷你连衣裙、黑色连裤袜、靴子与毛绒包逐件对应`<image2>` | 服装迁移用「让…穿上…」动作句；后面用结构化名称**消歧**，不描述外观 | PE-I2I 第 1 条 +「名称仅作辅助锚点」原则 |
| 人物按`<image3>`中人体模型的动作与机位摆姿势，双膝跪地、上身后仰、双手抱在脑后，身体正面朝向镜头，镜头平视 | 姿势独立成句，写清**动作 + 身体朝向 + 机位 + 视角**；把结构化姿势名称翻译成可观察状态 | PE-I2I 第 8 条；社区失败经验（姿势/构图丢失 = 没说清） |
| `<image1>`提供…，`<image2>`提供…，`<image3>`只提供… | 图像角色声明；「只提供」是**范围声明**（正向），不是禁令 | PE-I2I 第 8 条 "State each image's role explicitly" |
| 画面置于…浅灰色无缝背景，左前方柔光主光，右后方冷色轮廓光，地面柔和渐变投影 | 主动构建场景/布光（官方「construct actively」）；布光写清光源方位+光质+投影 | PE-I2I 第 6 条；PE-T2I 第 7 步（布光独立成句） |
| 85mm 人像定焦、平视、竖构图，人物位于画面中央，双膝与头顶完整入镜 | 镜头/构图/入镜范围；替代旧实现里「3:4、1152×1536」这类不能写的参数 | PE-T2I 第 3/5 步（positional phrases）；PE-I2I 第 10 条（不写比例） |
| 人物为成年女性，真实自然的全身比例；面部身份…保持与`<image1>`一致，服装每件单品保持与`<image2>`一致 | 保留声明用**肯定式 + 指向式**，一句覆盖一大类；替代旧实现的「脸型、五官、发型、发色」逐项描述 | PE-I2I 第 3/4/11 条 |
| 头部、颈部与肩膀自然连接，双手手指完整、左右手结构正确，膝盖与脚踝自然弯曲 | 正向人体结构描述；替代「不要断头/不要粘连/5 根手指」等否定句 | PE-I2I 第 11 条；社区 QC（正向状态） |
| 皮肤呈现真实肌肤质感与自然光泽，针织、皮革与羊毛呈现真实面料质感 | 用**材料词**替代质量词（8k/超清），既提质感又不含无效 booster | PE-T2I "Give the material, not just the noun" |
| 整体为写实商业摄影风格，自然柔光与统一的暖中性色调 | 结尾一句收束（风格+光+色调），全篇只出现一次风格词 | PE-T2I 第 8 步（close with the whole frame） |

### 6.2 示例 B：人像 + 姿势双图（固定双图模板：`<image1>`=姿势、`<image2>`=人像）

> ⚠️ 顺序注意：本机双图固定模板编码顺序是「姿势在前、人像/服装在后」（`src/services/aiGenerator.ts:217-223`）。所以双图提示词里 `<image1>` 是姿势、`<image2>` 是人像；旧实现用 `replace(/图1/g…)` 做字符串交换，重构时应改为按槽位生成标签。

```text
以<image2>中的人物为主角，按<image1>中人体模型的动作、身体朝向与镜头机位，生成一张全新的写实商业摄影全身照片：人物双膝跪地、上身后仰、双手抱在脑后，身体正面朝向镜头，镜头平视；<image1>只提供动作、身体朝向与镜头机位，<image2>提供面部身份、发型、发色以及原有可见服装与配饰。画面置于一间安静的自然光摄影棚：浅灰色无缝背景，左前方一盏大面积柔光作为主光，右后方一层冷色轮廓光勾出肩线与发丝，地面呈柔和渐变的投影。镜头为85mm人像定焦、平视、竖构图，人物位于画面中央，双膝与头顶完整入镜。人物为成年女性，真实自然的全身比例；面部身份、发型与发色保持与<image2>一致；头部、颈部与肩膀自然连接，双手手指完整、左右手结构正确，膝盖与脚踝自然弯曲，皮肤呈现真实肌肤质感与自然光泽。整体为写实商业摄影风格，自然柔光与统一的暖中性色调。
```

**逐句解释：**

- 「以`<image2>`中的人物为主角，按`<image1>`中人体模型的动作…」：双图没有服装迁移需求时，第一句就把「身份来自谁、动作来自谁」讲清楚；动作句与人物句绑定在同一句，避免模型只顾身份。
- 「`<image1>`只提供动作、身体朝向与镜头机位」：双图最容易出的问题是**把白模的白色材质/接缝带进画面**。正向的做法是声明来源范围 + 在人体结构句里写「皮肤呈现真实肌肤质感」，而不是写「不要白模」。
- 「`<image2>`提供…原有可见服装与配饰」：人像图里原本的衣服保留（与三图示例不同，三图有专门服装参考）；这是「say what stays without repainting」的最小声明。
- 场景/布光/构图/镜头/结构/收束与示例 A 相同，直接复用 §5.6 模板。

### 6.3 示例 C：仅姿势单图（N=1，官方要求不用标签）

```text
以照片中的人体模型为动作参考，生成一张全新的写实商业摄影全身人物照片：一位成年女性双膝跪地、上身后仰、双手抱在脑后，身体正面朝向镜头，镜头平视；人体模型只提供动作、身体朝向与镜头机位，人物的面部、发型、肤色与服装全部按写实商业摄影风格自然生成。画面置于一间安静的自然光摄影棚：浅灰色无缝背景，左前方一盏大面积柔光作为主光，右后方一层冷色轮廓光勾出肩线与发丝，地面呈柔和渐变的投影。镜头为85mm人像定焦、平视、竖构图，人物位于画面中央，双膝与头顶完整入镜。人物为成年女性，真实自然的全身比例；面部五官清晰、左右对称，头部、颈部与肩膀自然连接，双手手指完整、左右手结构正确，膝盖与脚踝自然弯曲，皮肤呈现真实肌肤质感与自然光泽。整体为写实商业摄影风格，自然柔光与统一的暖中性色调。
```

**逐句解释：**

- 单图按官方规范**不用 `<imageN>` 标签**，用「照片中的人体模型」自然指代（`qwen_image21.py` 在 N=1 时仍会自动插入一个 `<image1><vision>` 占位符，但那是模型侧绑定，不代表文本必须写标签）。
- 「人物…全部按写实商业摄影风格自然生成」：单姿势图没有人脸/服装来源，必须明确「其余属性由模型生成」，否则模型会去描摹白模。
- 「人体模型只提供动作…」：范围声明；配合人体结构句的正向描述，避免白模质感泄漏。
- 场景/光/构图/收束同上；单图没有服装参考时，**不要再写「整套服装与配饰」**，否则模型会去找不存在的服装参考。

### 6.4 示例 D（补充）：服装 + 姿势双图（无人像，自由生成面部）

```text
以<image1>中人体模型的动作、身体朝向与镜头机位为姿势参考，生成一张全新的写实商业摄影全身照片：画面中是一位面部自然、与画风匹配的成年女性，五官清晰、左右对称，穿上<image2>展示的整套服装与配饰，每件单品的颜色、款式、面料与配饰对应<image2>；<image1>只提供动作、身体朝向与镜头机位，<image2>提供服装与配饰。画面置于一间安静的自然光摄影棚：浅灰色无缝背景，左前方一盏大面积柔光作为主光，右后方一层冷色轮廓光勾出肩线与发丝，地面呈柔和渐变的投影。镜头为85mm人像定焦、平视、竖构图，人物位于画面中央，头顶与双脚完整入镜。人物为成年女性，真实自然的全身比例；头部、颈部与肩膀自然连接，双手手指完整、左右手结构正确，膝盖与脚踝自然弯曲，皮肤呈现真实肌肤质感与自然光泽，服装呈现真实面料质感。整体为写实商业摄影风格，自然柔光与统一的暖中性色调。
```

对应旧实现的 `costumeAsPerson`/`freeFace` 分支：核心是**把「自由生成面部」写成正向句**（「一位面部自然、与画风匹配的成年女性，五官清晰、左右对称」），而不是「不要照搬人台的无头构图」。

### 6.5 英文对照版（示例 A 的翻译，用于 R4 / 未来英文用户）

```text
Using the person in <image1> as the sole subject, create a brand-new realistic commercial photography full-body photograph: dress the person in the complete outfit and accessories shown in <image2>, with the grey knit mini dress, black tights, boots and fluffy bag each matching <image2>; pose the person exactly as the mannequin in <image3>, kneeling on both knees with the upper body leaning back and both hands clasped behind the head, body facing the camera, eye-level view. <image1> supplies the facial identity, hairstyle and hair colour; <image2> supplies the colours, cuts, fabrics and every accessory of the outfit; <image3> supplies only the pose, body orientation and camera position. Set the scene in a quiet natural-light photo studio: a light grey seamless backdrop, a large soft light from the front left as the key, a cool rim light from the rear right outlining the shoulders and hair, and a soft graduated shadow on the floor. Shoot with an 85mm portrait lens at eye level in a vertical full-body composition, the person centred in frame with knees and the top of the head fully inside the frame. The subject is an adult woman with realistic natural full-body proportions; her facial identity, hairstyle and hair colour stay consistent with <image1>, and every garment stays consistent with <image2>; the head, neck and shoulders connect naturally, both hands have complete correct finger structure, knees and ankles bend naturally, the skin shows realistic texture and natural sheen, and the knit, leather and wool show real fabric texture. The overall look is realistic commercial photography with soft natural light and a unified warm neutral palette.
```

---

## 7. 评测方案（对应 `prompts/variants.json`，图由 local-eval 跑）

### 7.1 变体矩阵（12 runs，seed 全部沿用各 case 原值）

> 补充：另有一组 `tmp/qwen-prompt-lab/experiments-newbuilder.json`（4 runs）直接跑**重构后 `buildRecipePrompt()` 的实际产出**，用于「最终落地提示词 vs 旧基线」的对照（见 §8 结论）。

| 变体 | 内容 | 隔离的变量 | 预期 |
|---|---|---|---|
| R1 | 单段短指令：`<imageN>` + 只写操作/动作，不写场景、布光、构图 | 短指令上限 | 姿势可能恢复一部分，但背景/构图/结构最弱 |
| R2 | 单段长描述：`<imageN>` + 角色声明 + 主动场景/布光/构图 + 肯定式保留 + 正向结构 | 推荐范式基准 | 综合最佳，尤其姿势/背景/手部 |
| R3 | R2 的「图N」版本，其余逐字一致 | **标签 vs 自然语言** | 预期 R2 明显优于 R3（姿势/服装归属） |
| R4 | R2 的英文版（单段、`<imageN>`） | **中文 vs 英文** | 与 R2 接近；看细节质感/术语词差异 |

3 个 case 覆盖三种最难姿势：站立跪姿（`standing_knit`）、俯卧俯视（`short_hair_casual`）、仰卧仰视（`lying_blue`）；基线均已在这些 case 上出现**姿势丢失**，是很好的判别样本。

### 7.2 判分口径建议（1–5 分）

身份相似度（脸/发）、服装还原（单品/颜色/材质）、姿势还原（动作/朝向/机位）、解剖结构（手/头颈/关节）、画面审美（构图/光/背景/质感）。

### 7.3 已知干扰项（评测时必须固定/记录）

- 步数：本机 25 步（官方 40–50）；R1–R4 全部用 25 步，若要单独验证步数，用同一 prompt 跑一版 40 步，不要混入本轮矩阵。
- 种子：变体不传 seed（脚本用 case 原 seed），与基线可比；单次结果有随机性，建议关键结论至少 2 seed 复核。
- 量化/设备：int8_convrot + bf16 VAE；官方 issue 提到部分量化/设备组合有条纹伪影（§3.3），若出现先确认不是提示词问题。
- PE：本轮全部 PE off；若后续打开 PE，必须换一套短指令提示词重测，不能与 R1–R4 混比。

---

### 7.4 实测结果（2026-11-10，local-eval 27 run，满分 25）

| case | 基线（旧分点） | 新版 N-* | Δ | 关键变化 |
|---|---|---|---|---|
| kneel_velvet | 18.5 | 21.0 | **+2.5** | 风格句前置后 2.5D 半写实画风首次达标，质感/布光提升 |
| short_hair_casual | 18.0 | 19.5 | **+1.5** | 从「完全站姿」改善为「下蹲+俯拍」，街拍胶片场景成立 |
| lying_blue | 20.5 | 21.5 | **+1.0** | 场景质感提升、无多肢畸形（机位漂移已在下轮修复） |
| standing_knit | 22.0 | 20.0 | **−2.0** | 配饰枚举漏项导致围巾/毛绒包消失，已通过「配饰穷尽」修复 |
| **平均** | 19.75 | 20.5 | **+0.75** | 最高分 N-lying_blue 21.5/25 |

变量结论见 §4.11；完整评分矩阵与失败模式见 `tmp/qwen-prompt-lab/eval-report.md`（27 run，含 R1–R4、顺序实验、steps 对照与 4 张对比拼图）。

**修复验证（R-4 配饰穷尽 / R-6 机位与躺卧场景解耦）**：按 §7 规则修正后再跑同种子对照 —— standing 的围巾与毛绒包已回到画面；lying 改用室内床品场景并把机位句硬锁到姿势参考后，出图从「街边侧低机位」变为「室内俯拍抬腿」，且无多肢体。验证图：`tmp/qwen-prompt-lab/outputs/fix/FIX-{standing_knit,lying_blue}.png`。



1. 现在提示词是「列清单 + 编号叫图1图2」，但本地这个模型只认一种写法：**一整段自然语言，用 `<image1>`/`<image2>`/`<image3>` 点名每张图**。
2. 旧提示词反复说「不要这样、不要那样」，这个模型在 cfg=1 时根本收不到「不要」，反而会把要排除的东西画进来；应改成直接说「要什么样」。
3. 旧提示词没写背景和光，模型只能给白底棚拍感；把「场景 + 光从哪来 + 什么镜头 + 人物在画面哪里」写进去，画面质感会立刻不一样。

---

## 9. 检索局限与不确定性（诚实声明）

1. **`web_search` 工具当日不可用**（DeepSeek API 401 认证失败），本报告全部依赖 `web_fetch` 直接抓取 + GitHub Search API；因此没有做「开放关键词检索」，可能遗漏部分社区文章。
2. **HuggingFace 主站直连失败**（fetch failed），改用官方镜像 `hf-mirror.com` 读取模型卡与 `system_prompt.txt`；镜像内容为官方仓文件的镜像，已在上文标注原始 URL 以便核对。
3. **Reddit / 知乎 / CSDN 无法抓取**：Reddit fetch failed；知乎 403；Bing 检索结果泛化，未找到可确认的 Qwen-Image-Edit 中文提示词文章。→ 中文社区与 Reddit 的证据标为「未找到可靠来源」，未编造。
4. **规范性 vs 实证性**：§2/§4 的规则多来自官方 PE 系统提示词——它规定的是「PE 改写模型该怎么写」，而不是「编辑模型收到的提示词必须长这样」。但两者是同一官方链路（PE 的输出就是编辑模型的输入），且 ComfyUI 模板内嵌同一规范，因此作为强依据；最终以 R2/R3/R4 实测为准。
5. 「图N 导致姿势丢失」是机制推断（D 级），R2 vs R3 可直接证伪/证实。
6. 步数 25 vs 官方 40–50 的影响未在本轮矩阵中隔离（Lead 预算 12 runs），建议作为下一轮单变量实验。

---

## 10. 来源清单（全部为实际抓取/可访问地址）

**Qwen 官方**
1. Qwen-Image-2.1 模型卡：<https://huggingface.co/Qwen/Qwen-Image-2.1>（镜像：<https://hf-mirror.com/Qwen/Qwen-Image-2.1>）
2. Qwen-Image-2.1 GitHub：<https://github.com/QwenLM/Qwen-Image-2.1>
3. PE-I2I 系统提示词：<https://huggingface.co/Qwen/Qwen-Image-2.1-PE-I2I/blob/main/system_prompt.txt>（镜像：<https://hf-mirror.com/Qwen/Qwen-Image-2.1-PE-I2I/resolve/main/system_prompt.txt>）
4. PE-T2I 系统提示词：<https://huggingface.co/Qwen/Qwen-Image-2.1-PE-T2I>（镜像：<https://hf-mirror.com/Qwen/Qwen-Image-2.1-PE-T2I/resolve/main/system_prompt.txt>）
5. Qwen-Image（2509/2511）GitHub：<https://github.com/QwenLM/Qwen-Image>
6. 阿里云百炼 · 千问图像编辑使用指南：<https://help.aliyun.com/zh/model-studio/qwen-image-edit-guide>
7. 阿里云百炼 · 图像编辑 API 参考：<https://help.aliyun.com/zh/model-studio/qwen-image-edit-api>

**ComfyUI 官方**
8. Qwen 2.1 Image Edit 模板：<https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_image_edit.json>
9. Qwen 2.1 T2I 模板：<https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_t2i.json>
10. Qwen 2.1 Turbo Edit 模板：<https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_turbo_image_edit.json>
11. workflow_templates PR #1298（PE 接线/参数修正）：<https://github.com/Comfy-Org/workflow_templates/pull/1298>
12. Comfy-Org/Qwen-Image-2.1 模型卡：<https://huggingface.co/Comfy-Org/Qwen-Image-2.1>（镜像：<https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1>）
13. ComfyUI 文档 · Qwen-Image-Edit：<https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit>
14. ComfyUI 文档 · Qwen-Image-Edit-2511：<https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit-2511>
15. workflow_templates issue #1401：<https://github.com/Comfy-Org/workflow_templates/issues/1401>

**社区**
16. 真实 ComfyUI + Qwen-Image-Edit 项目记录（PR #6）：<https://github.com/kelvin78901/AIVideoGenerationAgent/pull/6>
17. image-prompt-skill（SKILL.md，Qwen 提示词工程化实践）：<https://github.com/twj515895394/image-prompt-skill>；PR #4：<https://github.com/twj515895394/image-prompt-skill/pull/4>
18. QwenLM/Qwen-Image-2.1 issue #23（PE 耗时）：<https://github.com/QwenLM/Qwen-Image-2.1/issues/23>
19. QwenLM/Qwen-Image-2.1 issue #19（PE edit 24000 token 上下文）：<https://github.com/QwenLM/Qwen-Image-2.1/issues/19>

**本机材料（非网络）**
- `tmp/qwen-prompt-lab/baseline-prompts.md`（4 个 case 的基线提示词）
- `tmp/qwen-prompt-lab/workflows/result_00089_.json` … `result_00092_.json`（真实出图工作流）
- `tmp/qwen-prompt-lab/template-subgraph.txt`（官方 2.1 模板子图节点与 PE 开关）
- `tmp/qwen-prompt-lab/templates-prompts.txt`（官方模板内嵌系统提示词提取）
- `comfy/text_encoders/qwen_image21.py`（ComfyUI 源码：标签拼接与系统提示）
- `src/services/aiGenerator.ts`（现有 `buildRecipePrompt()`，243–380 行）
