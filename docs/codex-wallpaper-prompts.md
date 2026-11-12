# 真人女性角色桌面壁纸提示词库（GPT-Image-2.6 / 本机 Codex 网关实测）

本文是给「**成年女性、真人写实、桌面壁纸（横版 16:9）**」准备的提示词库，风格定位：**微性感、有吸引力，但高级克制**，能通过 ChatGPT/Codex 订阅账号的图片安全审核（`safety_violations=[sexual]` 是高发错误）。

> 提示词来自 GitHub 开源提示词合集（[awesome-gpt-image-2](https://github.com/YouMind-OpenLab/awesome-gpt-image-2) 18k+ 条、[awesome-gptimage2-prompts](https://github.com/gpt-image2/awesome-gptimage2-prompts)、[awesome-gpt-image2.5](https://github.com/xianyu110/awesome-gpt-image2.5)、[female-portrait-director](https://github.com/liyue-aigc/female-portrait-director)、[tigerowo/awesome-gpt-image-2-prompts](https://github.com/tigerowo/awesome-gpt-image-2-prompts)）的壁纸向改写，并由本项目在 2.6 订阅网关上逐条实测。开源库均为竖版人像，**没有现成的 16:9 真人壁纸分类**，横版构图与「可过审措辞」是本文的核心增量。

## 一、实测结论（2026-11，gpt-image-2.6 订阅网关）

- **文字描述过露会被拒**：`form-fitting ... off-shoulder ... high side slit` 三连叠加 → 400 `safety_violations=[sexual]`；`silk midi dress + shawl + 清晨公寓` 组合也被拒。
- **瘦身改写后的「微性感」能过**：单个时装亮点（`sleeveless` / `one-shoulder` / `subtle side slit` / `satin`）+ 优雅姿态 + 电影布光，实测全部通过，且模型会自己补足吸引力（领口、露肩、贴身剪裁会自然出现）。
- **参考图内容比文字更严格**：泳装 / 内衣 / 性感类**参考图**会被直接拒绝（与提示词无关），白模 / 深度图姿势参考可以通过；详见 [codex-image-gateway.md](codex-image-gateway.md)。
- **16:9 原生支持**：`size=2048x1152` 实测通过，上游输出约 1672×941（订阅端点把总像素压在 ~1.57MP）；需要 1080p/4K 壁纸时再本地放大即可。
- **保留角色脸**：1 张人像参考 + 自定义提示词（`/images/edits`）实测成功，脸型/发型/肤色与原角色一致。

## 二、在应用里怎么用

### 方式 A：自动壁纸模式（推荐，三张参考图一键出）

1. 「API 接口配置」→ OpenAI GPT Image → Base URL 指向本机网关（`http://127.0.0.1:8788/v1`）→ 点「启动网关」。
2. 打开「AI 角色合成台」，按平时的流程选好 **人像 + 服装 + 姿势** 三张参考图（避开泳装 / 内衣 / 性感类素材，否则会被上游图片审核直接拒绝）。
3. 「画风预设」选「**桌面壁纸 · 微性感（横版）**」。应用会自动：
   - 生成横版壁纸提示词：三分线构图、大面积负空间、电影感布光、中性克制措辞；
   - 把输出尺寸切成横版（本机 Codex 网关 `2048x1152` ≈16:9；官方 API `1536x1024`）与 `high` 质量。
4. 直接点「生成」即可出桌面壁纸；换服装/姿势就会自动换场景（日常→城市街角/室内，礼服→宴会厅，海边度假→沙滩等）。
5. 若被拒：按「风险词对照表」换掉参考图或改用日常服装；「微性感」来自服装本身（派对礼服、夏季贴身款等 SFW 类别）与布光，不需要改提示词。

> 定时任务里开启「随机画风」时，抽到壁纸预设也会自动切横版尺寸与 high 画质。

### 方式 B：自定义提示词模式（更自由，单张或三张参考图都行）

1. 同上配置网关；合成台选参考图（可以只选 1 张人像固定角色脸）。
2. 「3. 提示词」处选择**自定义提示词**，粘贴下面任一英文提示词。
3. 展开高级参数：**输出尺寸 = 2048x1152（16:9 桌面壁纸）**、质量 = high、端点 = `images_edits_json`，参考图传参 = base64。
4. 若被拒：按「风险词对照表」逐项降级（先删 `silk`，再删 `form-fitting` / `backless`，再把夜景改白天），或换人像参考。

> 注意：自定义提示词会覆盖应用自动生成的 Codex 中性提示词，所以请直接使用本文措辞，不要自己加 `sexy / cleavage / lingerie / bikini` 等词。

## 三、可直接复制的提示词（按推荐度排序，均已实测通过）

### 1. 单肩绿缎礼服 · 夜景（最推荐：微性感 + 高级感）
```text
Cinematic 3:2 landscape desktop wallpaper, photorealistic fashion photography of an elegant adult woman, long hair, confident graceful pose, looking at the camera. She wears an elegant one-shoulder satin evening gown in deep emerald green. City rooftop lounge at night, warm bokeh lights, soft rim light, 85mm lens, shallow depth of field, cinematic teal and amber color grading, ultra-detailed fabric and skin texture, tasteful and elegant, fully clothed, no text, no watermark
```
实测：21s 通过。建议尺寸 `2048x1152` 时把开头改为 `Cinematic 16:9 landscape desktop wallpaper`。

### 2. 海边金色时刻 · 白色吊带长裙
```text
Cinematic 3:2 landscape desktop wallpaper, photorealistic fashion photography of an elegant adult woman, long hair, confident graceful pose, looking at the camera. She wears a flowing white summer maxi dress. Quiet beach at golden hour, gentle waves, warm sunset glow, wind in her hair and dress, 85mm lens, shallow depth of field, golden cinematic color grading, ultra-detailed fabric and skin texture, tasteful and elegant, fully clothed, no text, no watermark
```
实测：21s 通过；成图会自动出现细吊带 / 收腰，氛围接近旅拍壁纸。

### 3. 城市夜景 · 黑色晚礼服（最稳）
```text
Cinematic 3:2 landscape desktop wallpaper, photorealistic fashion photography of an elegant adult woman, long hair, confident graceful pose, looking at the camera. She wears an elegant black evening gown. City rooftop at dusk, glittering skyline bokeh behind her, warm rim light on her hair and shoulders, 85mm lens, shallow depth of field, teal and orange cinematic color grading, ultra-detailed textures, tasteful and elegant, fully clothed, no text, no watermark
```
实测：26s 通过；模型会自然生成荡领/露肩剪裁，风险最低。

### 4. 无袖黑裙 · 侧开衩（微性感边界款）
```text
Cinematic 3:2 landscape desktop wallpaper, photorealistic fashion photography of an elegant adult woman, long hair, confident graceful pose, looking at the camera. She wears an elegant black sleeveless evening gown with a subtle side slit. City rooftop at dusk, glittering skyline bokeh behind her, warm rim light, 85mm lens, shallow depth of field, cinematic color grading, ultra-detailed textures, tasteful and elegant, fully clothed, no text, no watermark
```
实测：37s 通过。只保留一个「开衩」亮点是安全边界，不要把 `form-fitting / off-shoulder / high slit` 叠加。

### 5. 居家窗边 · 针织开衫（温柔氛围）
```text
Cinematic 3:2 landscape desktop wallpaper, photorealistic fashion photography of an elegant adult woman, long hair, confident graceful pose, looking at the camera. She wears a white midi dress with a light knit cardigan. A sunlit cozy living room by a large window, soft morning light, warm neutral tones, 50mm lens, shallow depth of field, warm film color grading, ultra-detailed, tasteful and elegant, fully clothed, no text, no watermark
```
实测：24s 通过（「真丝 + 披肩 + 清晨公寓」的原始写法会被拒，针织开衫 + 客厅是安全替代）。

### 6. 角色一致性版（先选人像参考，再粘贴）
```text
Use the woman in the provided reference image as the character, keep her facial identity, hairstyle and skin tone consistent. Cinematic 16:9 landscape desktop wallpaper, photorealistic fashion photography: she wears an elegant one-shoulder satin evening gown in deep emerald green, seated in a rooftop lounge at night with warm bokeh lights, soft rim light, 85mm lens, shallow depth of field, cinematic teal and amber color grading, ultra-detailed fabric and skin texture, tasteful and elegant, fully clothed, no text, no watermark
```
实测：27s 通过，成图脸型与参考人像一致，适合做「同一个角色」的多张壁纸。

> 想换场景/服装又不想重复写：把上面的 `[场景]`、`[服装]` 段替换即可，其余保持；换服装时**只保留 1 个时装亮点**。

## 四、通用壁纸公式（自造提示词用）

```text
Cinematic 16:9 landscape desktop wallpaper, photorealistic [film / editorial] photography of an elegant adult woman in her late twenties,
she wears [面料 + 剪裁：1 个亮点，如 satin one-shoulder gown / white maxi dress / knit cardigan over midi dress],
[姿势 + 视线：confident graceful pose, looking at the camera / seated by the window, calm gaze],
[场景 50–60% + 光线：city rooftop at dusk, warm bokeh, soft rim light / beach at golden hour / sunlit living room],
[镜头：85mm lens, shallow depth of field] , cinematic [teal & amber / warm film] color grading, ultra-detailed fabric and skin texture,
tasteful and elegant, fully clothed, no text, no watermark
```

壁纸构图要点（开源库都没有、但横版必须考虑）：
- 人物放**左右三分线**，另一侧留大块负空间（放桌面图标）；
- 环境占画面 **50–60%**（天空、城市灯火、海面、窗景）；
- 用 `16:9` / `landscape desktop wallpaper` 明示横构图；API 的 `size` 优先于文字，别依赖 `--ar`（模型不读 Midjourney 参数）。

## 五、风险词对照表（实测 + 开源库标注）

| 高风险写法 | 风险 | 安全改写 |
| --- | --- | --- |
| `sexy` / `seductive` / `sensual` | 高 | `confident` / `editorial poise` / `cinematic allure` |
| `deep cleavage` / `unbuttoned at the top` | 高 | `open collar` / `relaxed fit` |
| `form-fitting` + `high slit` + `off-shoulder` 同现 | 高（实测被拒） | 只保留 1 个：`sleeveless` / `one-shoulder` / `subtle side slit` |
| `backless` / `translucent` / `sheer` | 中高 | `draped` / `layered` / 删除 |
| `silk + 居家卧室 + 清晨` 组合 | 中（实测被拒） | 换 `knit cardigan + sunlit living room` |
| `bikini` / `lingerie` / `swimsuit` / `nude` | 极高 | 永不出现；海边用 `flowing summer maxi dress` / `linen outfit` |
| `bed` / `selfie` / `wet` 与服装暴露词同现 | 中高 | 换 `sofa` / `window seat`，删 selfie 框 |
| `18-year-old` / `teen` / `youthful` | 极高 | `adult woman in her late twenties/thirties` |
| `--ar 9:16`、`Aspect Ratio: 3:4` | 无效 | 正文写 `16:9 landscape`，尺寸用 `size` 参数 |
| `voluptuous` / `curvy figure` 等身材描写 | 高 | `tailored silhouette` / `graceful posture` |

## 六、进阶：把开源库里的提示词改成壁纸安全版

开源库人像提示词 95% 是竖版、且大量含风险词，改造三步：

1. **删**：所有身材/胸臀/腿/性感/透明类描写整句删除；
2. **换**：`sexy → quietly confident`、`high slit → subtle side slit`、`bed → window seat`、`bikini → flowing sundress`；
3. **补**：开头加 `Cinematic 16:9 landscape desktop wallpaper, photorealistic`，结尾加 `fully clothed, no text, no watermark`，并把人物位置/留白写进构图句。

> 本文提示词源自上述开源库（CC BY 4.0 / CC0）的壁纸向改写；保留出处链接，商用前请自行核对各仓库许可证与素材版权。

## 七、常见问题：为什么出现多人？怎么保证单人？

1. **姿势槽显示了「双人」徽标**：你选的是「双人缠绵」系列，提示词会明确要求两位人物。换「全身单人・标准系」或「上半身单人」即可。
2. **三张参考图里有两张是人体**（服装人台 + 姿势白模）：云端模型偶尔会把它们当成额外人物。现已自动追加「单人构图」约束（非双人姿势时）：画面只有一位成年女性，禁止出现第二人物 / 人体模型 / 假人 / 服装展示人台 / 镜像分身。
3. **开启了「附带合成拼图」**：拼图是「人像 / 服装 / 姿势」三格并排，模型可能照搬排版。现已自动在提示词里声明「拼图只说明参考来源，不是成品构图」。
4. **人像 / 上传图 / 附加参考图本身含多人**：换单人图即可。
5. **确实想要多人**：选「双人缠绵」姿势（需关闭安全模式并完成年龄确认），或在自定义提示词里写 `two adult women` / `three adult women`；注意订阅账号的图片审核对多人 + 性感组合更敏感，被拒概率更高。

## 八、群像模式：一张图 2–9 人（服装相似、脸不同、姿势不同）

在合成台「画面人数」里选 **2–9 人**即自动启用群像提示词（默认 1 人为单人）：

- **人数准确**：提示词会写「画面中有且仅有 N 位成年女性，不多不少」；
- **服装相似**：全员穿图2展示的同款/近似款服装与配饰（允许尺码与穿着方式自然差异），不会出现两套风格冲突的服装；
- **人脸不同**：每位女性的脸型、五官、发型都不同，不复制同一张脸、不出现镜像分身（图1只作为整组的气质/发型/肤色参考）；
- **姿势不同**：图3只作为其中一人的动作参考，其余人物姿势自然错落（站/坐/倚靠/回眸等），不排成一行；
- **壁纸构图**：配合「桌面壁纸 · 微性感（横版）」画风 + 16:9，**人物群像自动铺满画面**（占据画面主体、分布饱满均匀，不再留大面积负空间）；单人模式仍保留桌面负空间。

实测（4 人 / 9 人 + 三张参考图 + 壁纸预设 + 16:9）：均一次通过，人数准确、服装统一、脸与姿势各不相同，且群像铺满画面（9 人约 45 秒）。

> 人数上限为 **9 人**（实测 9 人一次通过：9 张不同脸、同款服装、姿势各异）；6 人以上人脸与手指细节难度明显升高，建议 high 画质 + 16:9 宽幅，若人数偶尔偏差（多一人/少一人）重新生成或适当降人数即可。

> 注意：群像 + 性感/暴露类参考图更容易被订阅审核拒绝（泳装/内衣类参考图本身就会被拒）；保持 SFW 日常服装即可。若同时选了「双人缠绵」姿势，以「画面人数」为准（人数 ≥2 时不再按双人姿势逻辑处理）。

## 九、提示词风格：简洁（参考图优先，默认）

既然人脸 / 服装 / 姿势都已经由三张参考图表达，提示词默认使用**简洁范式**，不再复述五官、服装单品、身材、关节比例（长描述容易和参考图互相干扰，也更容易被审核误伤）：

- **保留**：图1（人物）/ 图2（服装）/ 图3（姿势）的必要绑定、单人或群像人数声明、场景、画风关键词；
- **去掉**：发型/肤色长句、服装单品清单、身材偏好、手指/关节/头身比约束、布光长段落；
- 同一张 4 人壁纸：详细版提示词约 **980 字**，简洁版约 **346 字**，两者实测均能正确出 4 人同款服装、不同脸与姿势。

想对比或需要更强约束时，在合成台把「**提示词风格**」切到「详细（保留完整文字约束）」即可；其它画风与 Qwen 2.1 本地链路的详细范式不受影响（Qwen 本地工作流始终用 qwen21 范式）。
