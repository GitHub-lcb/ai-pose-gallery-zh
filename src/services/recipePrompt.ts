import type { ApiConfig, ExtraReferenceImage, PoseItem, PromptVerbosity, RecipeState } from '@/types/gallery'

// ============================================================================
// 提示词构建器（纯函数，无运行时依赖，供 node 直接做快照/ lint 测试）
//
// 两套提示词范式：
//  - qwen21  ：本地 ComfyUI Qwen Image 2.1（TextEncodeQwenImage21）官方范式。
//              单段连续中文、多图用 <imageN> 指向参考图、肯定式保留声明、
//              主动描写场景/布光/构图（PE off，等价于官方 Prompt Enhancer 输出形态）。
//  - classic ：旧版中文分点格式，保留给云端模型（Gemini / GPT / 豆包 / 云端 Qwen）
//              与 Qwen-Image-Edit 2509 链路，避免行为回归。
//
// 规范来源：docs/qwen-image-prompt-research.md（官方 PE-I2I system prompt、
// ComfyUI 2.1 模板说明、comfy/text_encoders/qwen_image21.py 的 <imageN> 拼接机制）。
// ============================================================================

export type PromptProfile = 'qwen21' | 'classic' | 'codex'

export const PROMPT_PROFILE_LABELS: Record<PromptProfile, { label: string; hint: string }> = {
  qwen21: {
    label: 'Qwen 2.1 官方单段指令',
    hint: '单段连续文本 + <image1/2/3> 标签 + 正向保留 + 场景布光，适配本地 Qwen Image 2.1',
  },
  classic: {
    label: '通用分点格式',
    hint: '中文分点约束，适配云端模型与 Qwen-Image-Edit 2509',
  },
  codex: {
    label: 'Codex 订阅安全（中性措辞）',
    hint: '本机 Codex / ChatGPT 订阅网关专用：中性描述身材与皮肤、避免露骨修饰；参考图仍需避开泳装 / 内衣 / 性感类素材',
  },
}

const LOCAL_GATEWAY_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 当前配置是否指向本机 Codex / ChatGPT 订阅生图网关（127.0.0.1 / localhost） */
export function isLocalCodexGateway(config: ApiConfig): boolean {
  if (config.activeProvider !== 'gpt') return false
  const baseUrl = (config.providers.gpt?.baseUrl || '').trim()
  if (!baseUrl) return false
  try {
    return LOCAL_GATEWAY_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl)
  }
}

/** 根据当前接口配置选择提示词范式：本机 Codex 订阅网关走中性措辞，Qwen Image 2.1 走官方范式 */
export function getPromptProfile(config: ApiConfig): PromptProfile {
  if (isLocalCodexGateway(config)) return 'codex'
  if (config.activeProvider !== 'comfyui') return 'classic'
  const preset = config.comfyuiParams.workflowPreset
  return preset === 'qwen21_local_3img' || preset === 'qwen21_local_2img' || preset === 'qwen21_3img' || preset === 'qwen21_2img'
    ? 'qwen21'
    : 'classic'
}

export interface StylePresetInfo {
  label: string
  /** 旧版分点提示词使用的风格关键词（classic 范式） */
  prompt: string
  /** 画风自带的场景句（仅风格化画风使用；写实类画风改为根据参考图自动生成背景，不写死场景） */
  scene?: string
  /** 躺卧类姿势的兼容场景（仅风格化画风使用） */
  lieScene?: string
  /** 写实类画风的布光/色调句（场景由参考图推导，布光跟随画风） */
  light?: string
  /** qwen21 范式：镜头/焦段 */
  lens: string
  /** qwen21 范式：构图（不含入镜范围，入镜范围按姿势动态生成） */
  composition: string
  /** qwen21 范式：产物媒介 */
  medium: 'photo' | 'illustration' | 'comic' | 'render3d' | 'figure'
  /** qwen21 范式：结尾整体风格 + 色调收束 */
  closing: string
}

export const STYLE_PRESETS: Record<string, StylePresetInfo> = {
  none: {
    label: '无预设（跟随参考图）',
    prompt: '',
    light: '自然光或柔和环境光，明暗过渡自然',
    lens: '中焦镜头',
    composition: '竖构图，人物居中',
    medium: 'photo',
    closing: '整体风格自然真实，光线与色调统一',
  },
  realistic: {
    label: '写实人像写真',
    prompt: '写实商业摄影级质感，85mm 人像镜头，自然柔和光影，真实肌肤纹理与织物细节，8k 高清画质。',
    light: '左前方大窗的柔和日光作为主光，右后方反光板补光，墙面与地面有自然明暗过渡和柔和投影',
    lens: '85mm 人像定焦',
    composition: '竖构图，人物位于画面中央',
    medium: 'photo',
    closing: '整体为写实商业摄影风格，自然柔光与统一的暖中性色调',
  },
  fashion: {
    label: '日韩杂志画报',
    prompt: '日韩时尚穿搭杂志画报风格，干净极简摄影棚背景，高级色调，突出人物颜值与服装剪裁。',
    light: '均匀柔光与轻微轮廓光，色调干净克制，画面整洁留白',
    lens: '中长焦镜头',
    composition: '竖构图，人物居中，画面留白',
    medium: 'photo',
    closing: '整体为日韩时尚杂志画报风格，色彩干净、色调高级',
  },
  film: {
    label: '复古胶片写真',
    prompt: '35mm 富士胶片摄影质感，轻微胶片颗粒，柔和复古暖调，自然街拍光影与电影呼吸感。',
    light: '侧逆光穿过发丝与衣缘，地面有拉长的影子，带有 35mm 胶片的轻微颗粒与复古暖调',
    lens: '35mm 胶片镜头',
    composition: '竖构图，人物位于画面中央偏一侧，带有自然抓拍感',
    medium: 'photo',
    closing: '整体为 35mm 富士胶片摄影风格，轻微胶片颗粒与柔和复古暖调',
  },
  semi_real: {
    label: '2.5D 游戏原画立绘',
    prompt: '2.5D 半写实高精度游戏角色原画，唯美厚涂光影，精致五官与华丽布料金属质感。',
    scene: '画面为柔和渐变的虚化场景背景，左上方暖色主光与右侧冷色边缘光，布料与金属有明确高光',
    lens: '中长焦镜头',
    composition: '竖构图，角色居中',
    medium: 'illustration',
    closing: '整体为 2.5D 半写实游戏原画风格，厚涂光影与唯美色调',
  },
  anime: {
    label: '日系二次元插画',
    prompt: '日系精致二次元插画风格，细腻赛璐璐与厚涂光影过渡，动漫角色立绘质感，色彩通透干净。',
    scene: '画面为干净的动漫场景背景，光线通透柔和，背景细节简洁，发丝与布料有清晰高光',
    lens: '标准镜头',
    composition: '竖构图，主体居中，立绘式构图',
    medium: 'illustration',
    closing: '整体为日系精致二次元插画风格，色彩通透干净',
  },
  cel_anime: {
    label: '新海诚感动画电影',
    prompt: '动画电影级画面质感，清澈高饱和光影，细腻体积光与发丝高光，干净唯美的动漫色彩。',
    scene: '画面为带天空与城市光影的开阔场景，体积光与逆光高光，色彩清澈高饱和',
    lens: '广角到中焦镜头',
    composition: '竖构图，环境占比更高',
    medium: 'illustration',
    closing: '整体为动画电影级画面风格，清澈高饱和的光影与唯美色彩',
  },
  manga: {
    label: '日式黑白漫画网点',
    prompt: '日本黑白漫画原稿风格，利落精准的G笔线稿，细腻漫画网点纸阴影与层次对比。',
    scene: '画面为黑白漫画原稿背景，网点纸阴影与清晰的黑白对比，无彩色光',
    lens: '标准镜头',
    composition: '竖构图，主体居中',
    medium: 'comic',
    closing: '整体为日式黑白漫画原稿风格，线条利落、网点层次清晰',
  },
  render3d: {
    label: '3D 次世代角色渲染',
    prompt: 'Unreal Engine 5 / Octane Render 次世代 3D 角色渲染，细腻次表面散射肌肤材质，电影级布光。',
    scene: '画面为中性色的展示空间，电影级三点布光（主光、补光、轮廓光），材质高光清晰',
    lens: '中长焦镜头',
    composition: '竖构图，主体居中，细节清晰',
    medium: 'render3d',
    closing: '整体为次世代 3D 角色渲染风格，电影级布光与细腻材质',
  },
  chibi_box: {
    label: '3D 潮玩手办质感',
    prompt: '高品质 PVC 涂装完成品手办质感，柔和摄影棚柔光箱布光，精致材质高光与微距景深。',
    scene: '画面为柔光棚拍台面：浅色无缝背景，大面积柔光箱均匀布光，精致高光与微距景深',
    lens: '微距镜头',
    composition: '紧凑构图，主体居中',
    medium: 'figure',
    closing: '整体为高品质 PVC 潮玩手办质感，柔光与精致材质高光',
  },
  cyberpunk: {
    label: '赛博朋克霓虹',
    prompt: '赛博朋克科幻视觉风格，雨夜霓虹冷暖双色轮廓光，未来感材质反光与电影级氛围。',
    scene: '画面为雨夜霓虹街道：霓虹招牌与湿地面反光，冷暖双色轮廓光与环境霓虹补光，电影氛围',
    lieScene:
      '画面置于昏暗的未来感室内空间：窗外霓虹与广告牌的光映进来，人物身下是柔软的织物表面，冷暖双色光在身体上形成轮廓与阴影',
    lens: '中焦镜头',
    composition: '竖构图，环境占比高',
    medium: 'photo',
    closing: '整体为赛博朋克科幻视觉风格，冷暖霓虹与电影级氛围',
  },
  concept_sheet: {
    label: '角色设定集立绘（纯白底）',
    prompt: '标准角色设定集全身立绘，纯白干净无杂物背景，均匀漫反射布光，清晰展示全身服装结构与配饰细节。',
    scene: '画面为纯白干净背景：均匀漫反射布光，投影柔和，没有杂物',
    lens: '标准镜头',
    composition: '竖构图，全身立绘式构图，人物居中',
    medium: 'illustration',
    closing: '整体为标准角色设定集立绘风格，背景干净、服装结构清晰',
  },
  // 桌面壁纸预设：横版宽幅 + 三分线构图 + 大面积负空间，配真人写实风格；
  // 提示词保持中性克制（避免 form-fitting/high slit/sexy 等触发订阅审核的词）。
  wallpaper: {
    label: '桌面壁纸 · 微性感（横版）',
    prompt:
      '电影感真人时尚摄影，横版宽幅桌面壁纸构图：人物位于左右三分线，另一侧保留大面积干净负空间，背景景深自然虚化、环境占比约一半；整体优雅克制、气质高级、自带吸引力，光影与色调统一，画面中没有文字、标志或水印。',
    light: '柔和电影级侧逆光与暖调轮廓光，勾勒发丝、肩线与服装质感，背景暗部层次丰富并带柔和光斑',
    lens: '85mm 中长焦',
    composition: '横版宽幅构图，人物位于左右三分线，另一侧留出大面积负空间',
    medium: 'photo',
    closing: '整体为电影感真人桌面壁纸风格，氛围优雅克制、光影高级',
  },
}

/** 产物媒介名词（用于 qwen21 开头句） */
const MEDIUM_NOUN: Record<StylePresetInfo['medium'], string> = {
  photo: '真实人物照片',
  illustration: '人物图像',
  comic: '黑白漫画人物图',
  render3d: '3D 角色渲染图',
  figure: '手办风格人物图',
}

/**
 * 背景生成策略（不提供固定场景选项，由参考图驱动）：
 * - 参考图里带场景 → 跟随该参考图的环境氛围（上传的人像/服装/姿势优先）；
 *   若上传参考图本身是纯色/白底，则根据服装风格 + 姿势自动补协调的真实环境，避免出现白底空背景。
 * - 素材库的素体白模 / 服装人台 / 证件照没有环境信息 → 根据服装分类、标签、人物姿势与画风光线自动生成背景。
 */
function pickSceneSource(recipe: RecipeState): 'pose' | 'portrait' | 'costume' | null {
  const pose = recipe.pose
  if (pose && pose.source === 'upload' && !pose.useDepth) return 'pose'
  if (recipe.portrait?.source === 'upload') return 'portrait'
  if (recipe.costume?.source === 'upload') return 'costume'
  return null
}

/** 从服装分类/名称/标签推导环境（参考图内容驱动，不是固定清单） */
export function deriveEnvironment(recipe: RecipeState): string {
  const costume = recipe.costume
  const text = costume ? `${costume.分类} ${costume.服装名称} ${costume.标签.join(' ')}` : ''
  if (/泳装|比基尼|泳衣|沙滩/.test(text)) return '海边沙滩或泳池边的自然场景'
  if (/内衣|睡衣|睡裙|丝袜|蕾丝/.test(text)) return '光线柔和的卧室或私密室内'
  if (/礼服|晚宴|派对|西装/.test(text)) return '酒店宴会厅或典雅的室内空间'
  if (/冬季|冬|毛衣|大衣|羽绒|围巾/.test(text)) return '有暖调灯光的室内空间或冬日城市街道'
  if (/春季|秋季|针织|风衣|牛仔/.test(text)) return '有生活感的城市街角或自然光充盈的室内'
  if (/夏季|短袖|短裤|凉鞋|裙/.test(text)) return '阳光充足的户外街道或庭院'
  return '自然光充盈的真实室内或城市街角'
}

/** 没有可参考的场景时，按服装风格 + 姿势 + 画风布光自动生成背景描述 */
function buildDerivedScene(recipe: RecipeState, poseClass: PoseClass, style: StylePresetInfo): string {
  const lying = poseClass === 'prone' || poseClass === 'supine'
  const env = lying
    ? '光线柔和的卧室床品环境'
    : poseClass === 'pair'
      ? '氛围柔和的室内或户外环境'
      : deriveEnvironment(recipe)
  const light = style.light ?? '自然光或柔和环境光'
  return `画面背景依据参考图中的人物气质、服装风格与姿势自然生成：${env}，${light}，背景有真实的环境层次与景深`
}

const PHOTO_STYLES = new Set(['realistic', 'fashion', 'film', 'wallpaper'])

/**
 * 群像构图：画风预设（尤其壁纸）默认给单人留「左右三分线 + 大面积负空间」，
 * 多人时改为「人物群像铺满画面、占据主体」，避免 4~9 人只占画面一角。
 */
function stylePromptForCount(promptText: string, multiPerson: boolean): string {
  if (!multiPerson || !promptText) return promptText
  return promptText
    .replace('人物位于左右三分线，另一侧保留大面积干净负空间', '人物群像铺满画面、占据画面主体，分布饱满均匀、前后错落')
    .replace('另一侧保留大面积干净负空间', '人物群像铺满画面、分布饱满均匀')
    .replace('人物位于左右三分线', '人物群像分布在整个画面')
    .replace('环境占比约一半', '环境作为背景衬托')
}

// 3D 素体姿势图自带「大头/长腿」的夸张人偶比例，若不显式约束，成图会照搬导致身材比例失真
// 注意：实测生成结果最典型的问题是「头大身小 / 幼态比例」，因此强化头身比与头部大小的约束
const PROPORTION_FULLBODY_PHOTO =
  '• 人体比例（重要）：成年女性真实自然的全身比例（约 7~7.5 头身），头部不要偏大，头部大小与肩宽、胸腔、腰胯、四肢长度协调；避免大头小身、幼态娃娃比例、躯干过短或四肢过细；头顶与双脚均完整入镜、不被裁切，姿态与关节自然。'
const PROPORTION_FULLBODY_STYLIZED =
  '• 人体比例（重要）：成年角色自然比例（约 7~7.5 头身），头部不要偏大，避免大头小身 / 幼态比例，头部与躯干、四肢长度协调；按该画风的标准人物比例绘制，头顶与双脚完整入镜。'
// 默认身材偏好：成年女性成熟身形、胸部略丰满（不夸张、不低俗），按用户偏好默认启用
const FIGURE_PREFERENCE_PHOTO =
  '• 身材（默认偏好）：成年女性成熟匀称的身材，肩颈与腰胯曲线自然，胸部较丰满但不夸张、与服装版型自然贴合；不要幼态、过度瘦弱或比例失调的身材。'
const FIGURE_PREFERENCE_STYLIZED =
  '• 身材（默认偏好）：成年女性成熟匀称的身材，曲线自然，胸部较丰满但不夸张（符合该画风审美）；不要幼态、过度瘦弱或比例失调的身材。'
// 本地 int8 模型在手/脚/颈部偶发结构崩坏，正向下明确「完整结构」能在一定程度上减少（无法 100% 消除）
const DETAIL_GUARD =
  '• 人体细节（重要）：头部、脖子与肩膀自然连接，不要断头、颈部错位或头部悬浮；双手结构正确，每只手 5 根手指、手指自然弯曲不粘连、不多手缺手；双脚与脚趾结构正确，不融合、不多脚缺脚；膝盖、手肘等关节自然；不要照搬人体模型的白模材质、接缝与拼接线。'

// ----------------------------------------------------------------------------
// Codex 订阅安全范式（profile='codex'）专用中性措辞：
// 订阅账号的图片审核对「胸部 / 裸露 / 腰胯 / 幼态」等字眼更敏感，
// 实测提示词本身不是唯一触发点（泳装类参考图会直接 400），但中性措辞能降低误伤。
// ----------------------------------------------------------------------------
const CODEX_FIGURE_PREFERENCE = '• 身材：成年女性，身材匀称健康，体态自然舒展，比例协调。'
const CODEX_DETAIL_GUARD =
  '• 人体结构（重要）：头部、脖子与肩膀自然连接；双手结构正确，每只手 5 根手指、手指自然弯曲、不粘连不多手缺手；双脚与脚趾结构正确，不融合不多脚缺脚；膝盖、手肘等关节自然；不要照搬人体模型的白模材质、接缝与拼接线。'
const CODEX_SKIN_TONE = '人物的肤色与图1中人物一致，脸部、颈部与手部等可见皮肤的肤色自然统一，按画风要求呈现质感。'
const CODEX_PROPORTION_FULLBODY =
  '• 人体比例（重要）：成年女性真实自然的全身比例（约 7~7.5 头身），头部大小与肩宽、躯干、四肢长度协调；避免大头小身、躯干过短或四肢过细；头顶与双脚均完整入镜、不被裁切，姿态与关节自然。'
const CODEX_PROPORTION_STYLIZED =
  '• 人体比例（重要）：成年角色自然比例（约 7~7.5 头身），头部大小与躯干、四肢长度协调；按该画风的标准人物比例绘制，头顶与双脚完整入镜。'
const CODEX_TONE_CLOSING = '画面人物着装完整得体，整体氛围优雅自然。'

export interface RecipePromptOptions {
  /** 双图模式：使用「服装图」作为人物/服装参考（不选人像，脸部由模型自由生成） */
  costumeAsPerson?: boolean
  /** 双图模式：服装槽不参与当前工作流（已选人像时忽略服装引用） */
  ignoreCostume?: boolean
  /** 无人物面部参考时，是否让模型自由生成面部（默认 true） */
  freeFace?: boolean
  /** 双图固定模板内部顺序为「姿势在前」，classic 范式据此交换「图1/图2」 */
  poseFirst?: boolean
  /** 实际送入模型的参考图角色顺序（qwen21 范式据此生成 <imageN> 编号） */
  imageOrder?: Array<'portrait' | 'costume' | 'pose'>
  /** 提示词范式：qwen21 = 官方单段指令；classic = 旧版分点 */
  profile?: PromptProfile
  /** 是否额外发送了三合一参考拼图（多格并排），需在提示词中说明它只是参考、不是成品构图 */
  stitchedSheet?: boolean
  /** 画面人数：1 = 单人（默认）；2~9 = 群像模式（服装相似、人脸不同、姿势不同） */
  characterCount?: number
  /** 提示词风格：concise = 参考图优先（只写必要绑定，默认）；detailed = 保留完整约束 */
  verbosity?: PromptVerbosity
}

// ----------------------------------------------------------------------------
// classic 范式（旧版分点，行为与原实现保持一致，仅修复与姿势冲突的固定句）
// ----------------------------------------------------------------------------
function buildClassicPrompt(
  recipe: RecipeState,
  stylePreset: string,
  workflowImages: ExtraReferenceImage[],
  options: RecipePromptOptions,
  safe = false
): string {
  const { costumeAsPerson = false, ignoreCostume = false, freeFace: freeFaceOption = true, poseFirst = false } = options
  const portrait = costumeAsPerson ? null : recipe.portrait
  const costume = ignoreCostume ? null : recipe.costume
  const styleInfo = STYLE_PRESETS[stylePreset] ?? STYLE_PRESETS.realistic
  const isPhoto = PHOTO_STYLES.has(stylePreset)
  // 没有人物面部参考时让模型自由生成面部（不再默认生成无脸人台）
  const freeFace = freeFaceOption && !portrait && !workflowImages.some((image) => image.role === 'character_sheet') && Boolean(costume || recipe.pose)
  // 「双人缠绵」姿势参考里是两位人物，提示词必须显式要求画出两个人，否则模型容易合并成单人
  const isPairPose = Boolean(recipe.pose && recipe.pose.source !== 'upload' && recipe.pose.体系.includes('双人'))
  // 群像模式（画面人数 2~9）：服装同款/近似、人脸各不相同、姿势各不相同；1 = 默认单人
  const characterCount = Math.min(9, Math.max(1, Math.round(Number(options.characterCount) || 1)))
  const multiPerson = characterCount >= 2
  // 双人姿势逻辑只在非群像模式下生效（群像以「画面人数」为准）
  const pairMode = isPairPose && !multiPerson
  const clauses: string[] = []
  let idx = 1
  let costumeIdx = 0

  workflowImages.filter((image) => image.role === 'character_sheet').forEach(() => {
    clauses.push('• 角色设定参考：提供的设定集展示同一角色的多个视角与细节，不是多个不同人物。保持角色的脸型、五官、发型、发色、肤色及服装配饰一致；只把它作为角色参考，成品布局遵循当前工作流的输出设置。')
    idx++
  })

  if (portrait) {
    const hairDesc = portrait.发型名称 && portrait.发型名称 !== '标准基础款' ? portrait.标题 : portrait.发长
    const skin = safe
      ? CODEX_SKIN_TONE
      : '人物的肤色必须与图一人物一致，所有裸露皮肤（包括服装镂空处露出的皮肤）必须与脸部肤色统一，统一后的肤色与质感按风格要求呈现。'
    const outfit = costume ? '' : '保留图1人物原有可见服装与配饰，不复制姿势参考图的服装或白模外观。'
    if (multiPerson) {
      clauses.push(
        `• 人物：图${idx}中的人物仅作为整组人物的气质、发型与肤色参考，不是画面中的唯一人物；画面中每一位成年女性的脸型、五官、发型都要彼此不同，不要复制同一张脸、不要出现镜像分身。${skin}`
      )
    } else {
      clauses.push(
        portrait.source === 'upload'
          ? `• 人物：图${idx}中的人物，保持其脸型、五官、发型和发色一致。${skin}${outfit}`
          : `• 人物：图${idx}中的人物，保持其脸型、五官、发型（${hairDesc}）和发色一致。${skin}${outfit}`
      )
    }
    idx++
  }
  if (costume) {
    costumeIdx = idx
    if (costumeAsPerson) {
      clauses.push(
        multiPerson
          ? `• 服装（图${idx}，作为整组人物与服装参考）：图${idx} 没有人脸，仅展示整套服装与配饰（参考名称：${costume.服装名称}）；请生成 ${characterCount} 位成年女性，每人都穿上图${idx}展示的整套服装和配饰（同款服装，允许尺码与穿着方式自然差异），每件单品的颜色、款式、面料与配饰都以图${idx}为准。`
          : costume.source === 'upload'
            ? `• 服装（图${idx}，作为人物与服装参考）：图${idx} 没有人脸，仅展示整套服装与配饰；请生成一位成年女性穿上图${idx}展示的整套服装和配饰，每件单品的颜色、款式、面料与配饰都以图${idx}为准。`
            : `• 服装（图${idx}，作为人物与服装参考）：图${idx} 没有人脸，仅展示整套服装与配饰（参考名称：${costume.服装名称}）；请生成一位成年女性穿上图${idx}展示的整套服装和配饰，每件单品的颜色、款式、面料与配饰都以图${idx}为准，名称仅作辅助说明。`
      )
      clauses.push(
        multiPerson
          ? `• 人物（自由生成）：本组合不提供人脸参考；请为画面中的 ${characterCount} 位成年女性分别生成自然、彼此不同的面部（五官清晰、左右对称、比例自然、肤色统一）；每个人物都要有完整的头部、脸部和脖子，头部与身体自然连接，不要照搬服装参考图/人台的无头构图，不要出现重复的脸。`
          : '• 人物（自由生成）：本组合不提供人脸参考；请为这套服装生成一位面部自然、与画风匹配的成年女性（五官清晰、左右对称、比例自然、肤色统一）；画面必须包含完整的头部、脸部和脖子，头部与身体自然连接，不要照搬服装参考图/人台的无头构图，也不要只画身体或服装展示。'
      )
    } else {
      clauses.push(
        multiPerson
          ? `• 服装：让画面中的 ${characterCount} 位人物都穿上图${idx}展示的整套服装与配饰（同款或近似款，允许尺码与穿着方式自然差异，整体风格统一，不要出现风格突兀的第二套服装），每件单品的颜色、款式、面料与配饰都以图${idx}为准。`
          : costume.source === 'upload'
            ? `• 服装：让人物穿上图${idx}中展示的整套服装和配饰，每件单品的颜色、款式、面料与配饰都以图${idx}为准。`
            : `• 服装：让人物穿上图${idx}中展示的整套服装和配饰（参考名称：${costume.服装名称}），每件单品的颜色、款式、面料与配饰都以图${idx}为准，名称仅作辅助说明。`
      )
    }
    // 动漫库服装是 2D 线稿/插画，真人照片风格下需转译为真实材质，避免「真人脸 + 动漫平涂服装」拼贴感
    if (costume.版本 === '二次元' && costume.source !== 'upload') {
      clauses.push(
        isPhoto
          ? `• 动漫服装转译（重要）：图${costumeIdx} 是二次元动漫风格的服装插画，仅用于参考套装的设计、配色、图案与配饰；请把它转译为真实面料、真实剪裁与自然褶皱的成品服装穿在人物身上，保留款式、颜色与配饰；不要保留动漫线稿、黑色描边、平涂色块或 2D 插画质感，也不要照搬图中人台的灰色假人肤色，整体以人物照片与画风要求为准。`
          : `• 动漫服装参考：图${costumeIdx} 是二次元服装插画，仅参考款式、配色与配饰；请按当前画风统一渲染为服装成品，避免线稿拼贴感，不要照搬图中人台外观。`
      )
    }
    idx++
  }
  if (recipe.pose) {
    const wear = costumeIdx ? `，穿着图${costumeIdx}的服装` : ''
    const body = isPhoto ? `最终画面中的人物是真人，皮肤真实自然${wear}` : `人物的肤色与质感按风格要求呈现${wear}`
    const poseActor = recipe.pose.source === 'upload' ? '人物' : '人体模型'
    clauses.push(
      multiPerson
        ? `• 姿势（群像）：图${idx} 中${poseActor}的动作只作为其中一位人物的参考；画面中 ${characterCount} 位人物的姿势必须各不相同、自然错落（例如站立、侧身、坐姿、倚靠、回眸等），避免排成一行、避免复制同一个动作、避免互相遮挡；图${idx} 只是动作示意。${body}。`
        : isPairPose
          ? `• 姿势（双人）：图${idx} 是双人姿势参考，画面中必须同时出现两位人物；严格按照图中两人的相对站位、肢体互动与镜头角度摆姿势（${recipe.pose.姿势名称}，${recipe.pose.角度}）；图${idx} 只是动作示意，不要把两位人物合并成一个人、不要裁掉其中一人，${body}。`
          : recipe.pose.source === 'upload'
            ? `• 姿势：按照图${idx}中的人物动作和镜头角度摆姿势；仅参考姿势与构图，不复制图${idx}人物的外观与服装，${body}。`
            : `• 姿势：按照图${idx}中人体模型的动作和镜头角度摆姿势（${recipe.pose.姿势名称}，${recipe.pose.角度}）；图${idx}只是动作示意，${body}。`
    )
    idx++
    if (pairMode) {
      const faceRef = portrait
        ? '两位人物的脸型、五官与发型均以图1为面部参考（可呈现为同一角色的两个角度或双胞胎设定，不要重复粘贴完全相同的脸）。'
        : '两位人物均为成年女性，面部自然生成且气质相近，不要重复同一张脸。'
      const pairWear = costumeIdx
        ? `两位人物都穿上图${costumeIdx}展示的整套服装与配饰（同一套装扮，按两人分别自然贴合）。`
        : '两位人物穿着风格统一的服装。'
      clauses.push(
        `• 双人构图（重要）：画面中必须同时出现两位成年女性人物，两人均完整入镜、不被裁切；${faceRef}${pairWear}两人的头部与颈部、肩膀自然连接，不要头部拼接/悬浮；两人的腿脚分别完整，不要多脚、融合脚或共用肢体；两人的身高与体型比例协调，肢体互动自然，手部与肢体互不粘连。`
      )
    }
    // 仅对「全身 / 双人」姿势追加完整头身比约束（半身/特写通常不会整体比例失真；群像构图不强制全身入镜）
    if (!multiPerson && (recipe.pose.source === 'upload' || /全身|双人/.test(recipe.pose.体系))) {
      if (safe) clauses.push(isPhoto ? CODEX_PROPORTION_FULLBODY : CODEX_PROPORTION_STYLIZED)
      else clauses.push(isPhoto ? PROPORTION_FULLBODY_PHOTO : PROPORTION_FULLBODY_STYLIZED)
    }
  }
  // 默认身材偏好：所有带人物的生成都追加（胸部略丰满、成熟匀称），更符合用户默认期望
  if (portrait || costume || recipe.pose) {
    if (safe) {
      clauses.push(CODEX_FIGURE_PREFERENCE)
      clauses.push(CODEX_DETAIL_GUARD)
    } else {
      clauses.push(isPhoto ? FIGURE_PREFERENCE_PHOTO : FIGURE_PREFERENCE_STYLIZED)
      clauses.push(DETAIL_GUARD)
    }
  }
  // 人物数量约束：群像（2~9 人）要求人数准确、脸与姿势各不相同；单人要显式禁止额外人物；
  // 双人姿势由上面的双人分支负责，不能加单人约束。
  if (multiPerson) {
    clauses.push(
      `• 群像构图（重要）：画面中有且仅有 ${characterCount} 位成年女性，人数准确、不多不少；每个人的脸型、五官、发型都不同，不要重复同一张脸或镜像分身；每个人的姿势与站位各不相同、自然错落有层次，不要排成一行、不要互相遮挡；所有人服装风格统一（同款或近似款），不要出现风格突兀的第二套服装。人物群像铺满画面、占据画面主体，分布饱满均匀，不要留大面积空白或空置背景。`
    )
  } else if (!isPairPose) {
    clauses.push(
      '• 单人构图（重要）：画面中只有一位成年女性，构图聚焦单人；不要出现第二位人物、人体模型、假人、服装展示人台或镜像分身。'
    )
  }
  if (options.stitchedSheet) {
    clauses.push(
      '• 参考拼图：若另附多格并排的参考拼图，它只说明人像/服装/姿势的来源，不是成品构图；不要照搬拼图排版，也不要因此输出多个人物。'
    )
  }
  if (freeFace && !costumeAsPerson) {
    clauses.push(
      multiPerson
        ? `• 人物（自由生成）：本组合不提供人脸参考；请为画面中的 ${characterCount} 位成年女性分别生成自然、彼此不同的面部（五官清晰、左右对称、比例自然、肤色统一），每人都要有完整的头部、脸部和脖子，头部与身体自然连接，不要照搬服装参考图/人台的无头构图，不要出现重复的脸。`
        : '• 人物（自由生成）：本组合不提供人脸参考；请生成一位面部自然、与画风匹配的成年女性（五官清晰、左右对称、比例自然、肤色统一）；画面必须包含完整的头部、脸部和脖子，头部与身体自然连接，不要照搬服装参考图/人台的无头构图，也不要只画身体或服装展示。'
    )
  }
  // 背景由参考图驱动：上传参考图带场景就跟随；否则按服装风格 + 姿势 + 画风光线自动生成
  const sceneSource = pickSceneSource(recipe)
  if (sceneSource) {
    clauses.push('• 背景：画面背景与场景氛围参考上传的参考图；若该参考图为纯色或白底，则根据服装风格与姿势生成协调的真实环境背景。')
  } else {
    const poseClass = recipe.pose ? getPoseClass(recipe.pose) : 'stand'
    const lying = poseClass === 'prone' || poseClass === 'supine'
    const sceneText = styleInfo.scene ? (lying && styleInfo.lieScene ? styleInfo.lieScene : styleInfo.scene) : buildDerivedScene(recipe, poseClass, styleInfo)
    clauses.push(`• 场景：${sceneText}。`)
  }
  for (const reference of workflowImages.filter((image) => image.role !== 'character_sheet')) {
    clauses.push(`• 工作流参考：参考图${idx}（${reference.name || '补充参考'}）中的相关元素，具体用途以工作流要求为准。`)
    idx++
  }
  for (const extra of recipe.extraImages || []) {
    clauses.push(`• 附加参考：融合图${idx}（${extra.name || '补充元素'}）中的元素、配饰、背景或光影细节。`)
    idx++
  }

  if (clauses.length === 0) {
    return '请先选择人像/服装/姿势或上传附加参考图。'
  }

  const lines = [
    `请根据${workflowImages.some((image) => image.role === 'character_sheet') ? '提供的角色设定参考' : `提供的 ${idx - 1} 张参考图`}，生成一张${multiPerson ? `包含 ${characterCount} 位成年女性的` : isPairPose ? '包含两位人物的' : ''}完整的${isPhoto ? '真实人物照片' : '人物图像'}：`,
    ...clauses,
  ]
  if (styleInfo.prompt) {
    lines.push(`• 风格：${stylePromptForCount(styleInfo.prompt, multiPerson)} 人物比例协调，手部与五官自然，光影统一。`)
  }
  if (safe) lines.push(CODEX_TONE_CLOSING)
  lines.push('画面中没有任何文字、标志或水印。')
  const text = lines.join('\n')
  // 双图固定模板内部按「图1=姿势、图2=人物/服装」编码，这里交换提示词编号以匹配实际送图顺序
  if (poseFirst && recipe.pose && (portrait || costume)) {
    return text.replace(/图1/g, '\u0000').replace(/图2/g, '图1').replace(/\u0000/g, '图2')
  }
  return text
}

// qwen21 范式（官方 PE-I2I 落地产物：单段连续、<imageN> 标签、肯定式、主动构建场景）
// ----------------------------------------------------------------------------

/** 参考图角色 → 提示词指代（多图 <imageN>；单图按官方要求自然指代） */
type Role = 'portrait' | 'costume' | 'pose'

function roleRefs(
  order: Role[]
): { tag: Record<Role, string>; isMulti: boolean; count: number } {
  const isMulti = order.length >= 2
  const natural: Record<Role, string> = {
    portrait: '画面中的人物',
    costume: '图中展示的整套服装与配饰',
    pose: '图中的人体模型',
  }
  const tag = { ...natural }
  order.forEach((role, index) => {
    tag[role] = isMulti ? `<image${index + 1}>` : natural[role]
  })
  return { tag, isMulti, count: order.length }
}

type PoseClass = 'stand' | 'kneel' | 'sit' | 'prone' | 'supine' | 'pair' | 'upper' | 'custom'

function getPoseClass(pose: PoseItem): PoseClass {
  // 用户上传的姿势图没有结构化姿势信息，不做姿势族断言，按参考图为准
  if (pose.source === 'upload' || pose.体系 === '上传') return 'custom'
  const text = `${pose.体系} ${pose.分类} ${pose.姿势名称}`
  if (pose.体系.includes('双人')) return 'pair'
  // 先判仰卧/侧卧：库里存在「分类=趴卧、名称=仰卧…」的数据（如 full_sexy_P055），名称优先
  if (/仰卧|侧卧|躺卧|平躺/.test(text)) return 'supine'
  if (/俯卧|趴/.test(text)) return 'prone'
  if (/跪/.test(text)) return 'kneel'
  if (/坐|蹲/.test(text)) return 'sit'
  if (/卧/.test(text)) return /仰|侧/.test(text) ? 'supine' : 'prone'
  if (pose.体系.includes('上半身')) return 'upper'
  return 'stand'
}

const POSE_PROPORTION: Record<PoseClass, string> = {
  stand: '站姿自然，双膝微曲、双脚着地',
  kneel: '跪立姿态，膝盖着地、小腿与脚背自然贴地，髋部稳定',
  sit: '坐姿自然承重',
  prone: '俯卧姿态，身体与支撑面自然接触',
  supine: '仰卧姿态，背部与支撑面自然贴合，身体放松',
  pair: '两位人物的相对站位自然、互不遮挡',
  upper: '上半身构图，身体自然延伸到画外',
  custom: '身体姿态自然舒展',
}

const POSE_JOINTS: Record<PoseClass, string> = {
  stand: '膝关节与踝关节自然屈伸',
  kneel: '膝关节弯曲自然，踝关节放松',
  sit: '髋、膝、踝三个关节的角度自然',
  prone: '肩、肘、腕承重自然，膝关节轻屈',
  supine: '髋、膝、踝自然摆放，脚背放松',
  pair: '两人的关节结构各自独立完整，手部与肢体互不粘连',
  upper: '颈部、肩、肘、腕自然',
  custom: '肩、肘、腕、髋、膝、踝关节自然',
}

const POSE_INGRESS: Record<PoseClass, string> = {
  stand: '头顶与双脚完整入镜',
  kneel: '头顶与膝盖完整入镜',
  sit: '头部与双脚完整入镜',
  prone: '按姿势参考的机位完整呈现人物身体',
  supine: '按姿势参考的机位完整呈现人物身体',
  pair: '两位人物均完整入镜、互不遮挡',
  upper: '头顶完整，身体自然延伸到画外',
  custom: '按参考图的构图完整呈现人物',
}

/** 姿势硬锁：把姿势名翻译成「身体轴 + 支撑点」的可观察状态（只写「俯卧」会被模型降级成坐/蹲/站） */
const POSE_AXIS: Record<PoseClass, string> = {
  stand: '双脚着地、身体自然站立',
  kneel: '双膝着地承重、小腿贴地',
  sit: '臀部或脚掌承重',
  prone: '身体水平趴伏在地面上',
  supine: '身体平躺在地面上、背部贴合支撑面',
  pair: '两人相互配合',
  upper: '',
  custom: '',
}

/** 水平朝向：来自姿势元数据，仅正面/斜前/侧面/背面可信（俯视/仰视与画面对应关系易错，不写入） */
const POSE_ORIENTATION: Record<string, string> = {
  正面: '身体正面朝向镜头',
  斜前: '身体略侧向镜头',
  侧面: '侧身朝向镜头',
  背面: '背对镜头',
}

function costumeNameHint(costume: RecipeState['costume']): string {
  if (!costume || costume.source === 'upload') return ''
  const name = costume.服装名称?.trim()
  return name ? `（${name.replace(/・/g, '、')}）` : ''
}

function buildQwen21Prompt(recipe: RecipeState, stylePreset: string, options: RecipePromptOptions): string {
  const style = STYLE_PRESETS[stylePreset] ?? STYLE_PRESETS.realistic
  const isPhoto = style.medium === 'photo'
  const portrait = options.costumeAsPerson ? null : recipe.portrait
  const costume = options.ignoreCostume ? null : recipe.costume
  const pose = recipe.pose
  // 实际送图顺序优先取工作流推导结果（双图固定模板姿势在前、灵活参考按所选槽位排序）
  const fallbackOrder: Role[] = ([] as Role[]).concat(
    portrait ? (['portrait'] as Role[]) : [],
    costume ? (['costume'] as Role[]) : [],
    pose ? (['pose'] as Role[]) : []
  )
  const order = (options.imageOrder?.length ? options.imageOrder : fallbackOrder).filter(
    (role) => (role === 'portrait' && portrait) || (role === 'costume' && costume) || (role === 'pose' && pose)
  ) as Role[]
  const { tag, isMulti } = roleRefs(order)
  const hasPortrait = Boolean(portrait)
  const hasCostume = Boolean(costume)
  const hasPose = Boolean(pose)
  const costumeIsAnime = Boolean(costume && costume.版本 === '二次元' && costume.source !== 'upload')
  const isPairPose = Boolean(hasPose && pose && pose.source !== 'upload' && pose.体系.includes('双人'))
  const poseClass: PoseClass = hasPose && pose ? getPoseClass(pose) : 'stand'
  // 姿势参考可能是素材库白模（人体模型）或用户上传的真实照片，措辞需要区分
  const poseSourceIsUpload = Boolean(pose && pose.source === 'upload')
  const poseRefActor = isMulti ? tag.pose : poseSourceIsUpload ? '图中的人物' : '图中的人体模型'
  const poseActionPhrase = isMulti
    ? `${tag.pose}中${poseSourceIsUpload ? '人物' : '人体模型'}的动作`
    : poseSourceIsUpload
      ? '图中人物的动作'
      : '图中人体模型的动作'
  const stylePhrase = `一张${isPairPose ? '包含两位人物的' : ''}全新的${style.label}风格${MEDIUM_NOUN[style.medium]}`
  const wear = costume ? `穿上${tag.costume}展示的整套服装与配饰${costumeNameHint(costume)}` : ''
  const protagonist = `${tag.portrait}中的人物`
  // 背景由参考图驱动：上传参考图带场景就跟随；否则按服装风格 + 姿势 + 画风光线自动生成背景
  const sceneSource = pickSceneSource(recipe)
  const sceneSourceLabel =
    sceneSource === 'pose'
      ? isMulti
        ? tag.pose
        : '上传的姿势参考图'
      : sceneSource === 'portrait'
        ? isMulti
          ? tag.portrait
          : '上传的人像参考图'
        : isMulti
          ? tag.costume
          : '上传的服装参考图'
  const isLyingPose = poseClass === 'prone' || poseClass === 'supine'
  const scene = sceneSource
    ? `画面背景、环境与整体光线参考${sceneSourceLabel}的场景氛围；若该参考图为纯色或白底，则依据人物气质、服装风格与姿势生成协调的真实环境背景`
    : style.scene
      ? isLyingPose && style.lieScene
        ? style.lieScene
        : style.scene
      : buildDerivedScene(recipe, poseClass, style)
  const costumeRef = isMulti ? tag.costume : '参考图'
  const poseRef = isMulti ? tag.pose : '参考图'

  const sentences: string[] = []

  // ① 操作指令（先写要做什么；参考组合决定句式）
  if (hasPortrait && hasCostume && hasPose) {
    sentences.push(
      isPairPose
        ? `以${protagonist}为面部参考，生成${stylePhrase}：让两位人物分别${wear}，并按照${poseActionPhrase}、身体朝向与镜头机位摆出双人姿势`
        : `以${protagonist}为唯一主角，生成${stylePhrase}：让${protagonist}${wear}，并按照${poseActionPhrase}、身体朝向与镜头机位摆姿势`
    )
  } else if (hasPortrait && hasPose) {
    sentences.push(
      isPairPose
        ? `以${protagonist}为面部参考，生成${stylePhrase}：按照${poseActionPhrase}、身体朝向与镜头机位摆出双人姿势，两位人物保留${protagonist}原有的可见服装与配饰`
        : `以${protagonist}为唯一主角，生成${stylePhrase}：按照${poseActionPhrase}、身体朝向与镜头机位摆姿势，保留${protagonist}原有的可见服装与配饰`
    )
  } else if (hasCostume && hasPose) {
    sentences.push(
      isPairPose
        ? `生成${stylePhrase}：两位面部自然、气质相近的成年女性分别${wear}，并按照${poseActionPhrase}、身体朝向与镜头机位摆出双人姿势`
        : `生成${stylePhrase}：一位面部自然、与画风匹配的成年女性${wear}，并按照${poseActionPhrase}、身体朝向与镜头机位摆姿势`
    )
  } else if (hasPortrait && hasCostume) {
    sentences.push(`以${protagonist}为唯一主角，生成${stylePhrase}：让${protagonist}${wear}`)
  } else if (hasPose) {
    sentences.push(
      isPairPose
        ? `以${poseRefActor}为动作参考，生成${stylePhrase}：两位面部自然、气质相近的成年女性；${tag.pose}只提供动作、身体朝向与镜头机位，人物的面部、发型、肤色与服装按该画风自然生成`
        : `以${poseRefActor}为动作参考，生成${stylePhrase}：一位面部自然、与画风匹配的成年女性；${tag.pose}只提供动作、身体朝向与镜头机位，人物的面部、发型、肤色与服装按该画风自然生成`
    )
  } else if (hasCostume) {
    sentences.push(
      `以${tag.costume}为服装参考，生成${stylePhrase}：一位面部自然、与画风匹配的成年女性，五官清晰、左右对称，穿上参考图中展示的整套服装与配饰${costumeNameHint(costume)}`
    )
  } else if (hasPortrait) {
    sentences.push(`以${tag.portrait}为主角，生成${stylePhrase}：人物保留原有的可见服装与配饰，面部身份、发型与发色保持不变`)
  } else {
    return '请先选择人像/服装/姿势或上传附加参考图。'
  }

  // ② 姿势细节（姿势名 → 身体轴 + 支撑点 + 朝向 + 机位硬锁；双人单独声明人数）
  if (hasPose && pose) {
    if (pose.source === 'upload') {
      sentences.push(`人物的姿态、身体朝向与镜头机位以${poseRef}为准`)
    } else {
      const poseName = pose.姿势名称?.replace(/・/g, '、') ?? ''
      const axis = POSE_AXIS[poseClass]
      const orientation = POSE_ORIENTATION[pose.角度] ?? ''
      // 机位锁定放在第⑥句（镜头/构图）里统一表达，这里只写动作与身体轴，避免重复约束互相稀释
      const lock = [poseName, axis, orientation].filter(Boolean).join('，')
      if (isPairPose) {
        sentences.push(`动作是${lock}，两人均完整入镜且互不遮挡，两人的面部相近但不完全重复`)
      } else {
        sentences.push(`人物的动作是${lock}`)
      }
    }
  }

  // ③ 图像角色声明（多图必须逐图声明来源，这是官方硬规则）
  if (isMulti) {
    const declarations: string[] = []
    if (hasPortrait) declarations.push(`${tag.portrait}提供面部身份、发型与发色`)
    if (hasCostume) declarations.push(`${tag.costume}提供服装的颜色、款式、面料与全部配饰`)
    if (hasPose) declarations.push(`${tag.pose}只提供动作、身体朝向与镜头机位`)
    sentences.push(declarations.join('，'))
  }

  // ③b 配饰穷尽：少列一项就丢一项（实测丢围巾/毛绒包），名称只作锚点、以参考图为准
  if (hasCostume) {
    sentences.push(`完整保留${costumeRef}中展示的每一件单品与配饰，上述名称仅作辅助说明、以参考图为准`)
  }

  // ④ 服装转译（动漫服装插画 → 真实面料；真人照片风格下必须显式转译，避免 2D 拼贴感）
  if (costumeIsAnime) {
    sentences.push(
      isPhoto
        ? `把${tag.costume}中的二次元服装插画转译为真实面料、真实剪裁与自然褶皱的成品服装，保留原有款式、配色、图案与配饰`
        : `按当前画风统一渲染${tag.costume}中的二次元服装设计，保留原有款式、配色与配饰`
    )
  }

  // ⑤ 场景 + 布光（专业场景设计，替代模型默认的白底棚拍；躺卧类用兼容场景）
  sentences.push(scene)

  // ⑥ 镜头 + 构图 + 入镜范围：机位必须由姿势参考决定，不能由风格模板默认机位覆盖（实测机位漂移主因）
  if (hasPose) {
    sentences.push(`镜头为${style.lens}、${style.composition}，${POSE_INGRESS[poseClass]}，镜头机位与${poseRef}完全一致`)
  } else {
    sentences.push(`镜头为${style.lens}、平视视角、${style.composition}，${POSE_INGRESS[poseClass]}`)
  }

  // ⑦ 肯定式保留声明 + 正向人体结构（身份只指向参考图，不用文字描述五官）
  const preservation: string[] = []
  if (hasPortrait) preservation.push('面部身份、发型与发色保持与参考图一致')
  if (hasCostume) preservation.push('服装每件单品的款式、颜色、面料与配饰保持与参考图一致')
  if (hasPose) preservation.push('人物姿态、身体朝向与镜头机位保持与参考图一致')
  const figure = isPhoto
    ? '成年女性真实自然的身材比例，成熟匀称，肩颈与腰胯曲线自然，胸部较丰满且自然不夸张'
    : '成年女性真实自然的身材比例，曲线自然，胸部较丰满且自然不夸张'
  const skin = isPhoto ? '皮肤呈现真实肌肤质感与自然光泽' : '皮肤与材质按该画风呈现自然质感'
  const fabric = isPhoto ? '服装呈现真实面料质感与自然褶皱' : '服装与配饰呈现统一的画风质感'
  const structure = `${figure}，${POSE_PROPORTION[poseClass]}；头部、颈部与肩膀自然连接，${POSE_JOINTS[poseClass]}，双手手指完整、左右手结构正确；${skin}，${fabric}`
  sentences.push(`${preservation.join('，')}；${structure}`)

  // ⑧ 画面洁净 + 整体收束（风格 + 色调，全篇只出现一次风格词）
  sentences.push('画面干净，只有人物与场景，没有文字、标志或水印')
  sentences.push(style.closing)

  return sentences.join('。') + '。'
}

// ----------------------------------------------------------------------------
// 简洁范式（参考图优先）：人脸 / 服装 / 姿势已经由三张参考图表达，
// 提示词只写「哪张图做什么 + 人数 + 场景 + 风格」，不再复述五官、服装细节、
// 身材、关节比例等长描述——避免和参考图互相干扰，也降低订阅审核误伤。
// ----------------------------------------------------------------------------
function buildConcisePrompt(
  recipe: RecipeState,
  stylePreset: string,
  workflowImages: ExtraReferenceImage[],
  options: RecipePromptOptions,
  safe = false
): string {
  const { costumeAsPerson = false, ignoreCostume = false } = options
  const portrait = costumeAsPerson ? null : recipe.portrait
  const costume = ignoreCostume ? null : recipe.costume
  const style = STYLE_PRESETS[stylePreset] ?? STYLE_PRESETS.realistic
  const isPhoto = PHOTO_STYLES.has(stylePreset)
  const characterCount = Math.min(9, Math.max(1, Math.round(Number(options.characterCount) || 1)))
  const multiPerson = characterCount >= 2
  const isPairPose = Boolean(recipe.pose && recipe.pose.source !== 'upload' && recipe.pose.体系.includes('双人'))
  const pairMode = isPairPose && !multiPerson

  // 参考图编号（与实际送图顺序一致：设定图 → 人像 → 服装 → 姿势）
  let idx = 1
  const lines: string[] = []
  for (let i = 0; i < workflowImages.filter((image) => image.role === 'character_sheet').length; i++) {
    lines.push(`图${idx}为角色设定参考（同一角色，不是多人）`)
    idx++
  }
  const portraitIdx = portrait ? idx++ : 0
  const costumeIdx = costume ? idx++ : 0
  const poseIdx = recipe.pose ? idx++ : 0

  const countText = multiPerson ? `包含 ${characterCount} 位成年女性的` : pairMode ? '包含两位人物的' : ''
  lines.push(`请根据提供的 ${idx - 1} 张参考图，生成一张${countText}${isPhoto ? '真实人物照片' : '人物图像'}：`)

  // 人脸：只说“用哪张图保持一致”，不描述具体五官
  if (portrait) {
    lines.push(
      multiPerson
        ? `图${portraitIdx}只作整组人物的气质与发型参考，每个人的脸型、五官必须不同。`
        : `以图${portraitIdx}为人物参考，保持脸型、五官、发型与发色一致。`
    )
  }
  // 服装：只说“穿上图N的服装”，不列单品名称/材质细节
  if (costume) {
    lines.push(
      multiPerson
        ? `画面中每人都穿图${costumeIdx}的服装与配饰（同款或近似款，整体风格统一）。`
        : `让人物穿上图${costumeIdx}的服装与配饰。`
    )
    if (costume.版本 === '二次元' && costume.source !== 'upload' && isPhoto) {
      lines.push(`把图${costumeIdx}的二次元服装转译为真实面料。`)
    }
  }
  // 姿势：只说“按图N的动作”，不写关节/比例/入镜范围
  if (recipe.pose) {
    if (multiPerson) {
      lines.push(`图${poseIdx}只作其中一人的动作参考；${characterCount} 人的姿势与站位各不相同、自然错落。`)
    } else if (pairMode) {
      lines.push(`按图${poseIdx}中两人的相对站位与镜头角度摆姿势，画面中必须有两位人物。`)
    } else {
      lines.push(`按图${poseIdx}的动作与镜头角度摆姿势；图${poseIdx}只作动作示意。`)
    }
  }
  // 人数声明（防止参考图被理解成多人）
  if (multiPerson) {
    lines.push(
      `画面中有且仅有 ${characterCount} 位成年女性；每人的脸型、五官、发型都不同，不要重复同一张脸或镜像分身；不要出现风格不同的第二套服装。人物群像铺满画面、占据画面主体，分布饱满均匀，不要留大面积空白或空置背景。`
    )
  } else if (!pairMode) {
    lines.push('画面中只有一位成年女性，不要出现第二个人物、人体模型或服装展示人台。')
  }
  if (!portrait && !costumeAsPerson && (costume || recipe.pose)) {
    lines.push('人物面部自然生成，与画风匹配。')
  }
  // 场景：有上传参考图就跟随，否则按服装推导；不做长段落布光描写
  if (pickSceneSource(recipe)) {
    lines.push('背景与光线参考上传的参考图。')
  } else {
    lines.push(`场景：${deriveEnvironment(recipe)}。`)
  }
  // 风格：沿用画风预设自带的风格关键词（含壁纸预设的横版构图；多人时改为铺满画面）
  if (style.prompt) lines.push(stylePromptForCount(style.prompt, multiPerson))
  if (safe) lines.push('人物着装完整得体。')
  // 部分画风（如壁纸预设）的风格句里已经写了「没有文字/水印」，避免重复
  if (!/没有文字|水印/.test(style.prompt || '')) lines.push('画面中没有文字、标志或水印。')
  return lines.join('\n')
}

/** 按当前范式构建提示词 */
export function buildRecipePrompt(
  recipe: RecipeState,
  stylePreset = 'realistic',
  workflowImages: ExtraReferenceImage[] = [],
  options: RecipePromptOptions = {}
): string {
  const profile = options.profile ?? 'classic'
  if (profile === 'qwen21') return buildQwen21Prompt(recipe, stylePreset, options)
  const safe = profile === 'codex'
  if (options.verbosity === 'concise') return buildConcisePrompt(recipe, stylePreset, workflowImages, options, safe)
  return buildClassicPrompt(recipe, stylePreset, workflowImages, options, safe)
}

// ----------------------------------------------------------------------------
// qwen21 提示词 lint（供 scripts/check-prompts.mjs 做回归断言）
// ----------------------------------------------------------------------------
const LINT_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: '不能有换行/分点/markdown', pattern: /[\n•]|^\s*[-*]\s|##/m },
  { rule: '多图不能用「图N」自然语言指代', pattern: /图[1-9](?!\d)|图一(?!致)|第一张图/ },
  { rule: '不能用否定式指令', pattern: /不要|禁止|避免|不能|切勿/ },
  { rule: '不能写分辨率/比例/像素', pattern: /\d+\s*[x×]\s*\d+|(?:2K|4K|8K|1080p|16:9|9:16|3:4|4:3)/i },
  { rule: '不能堆砌质量词', pattern: /高清|超清|极致|大片感|masterpiece|best quality|award-winning/i },
  { rule: '不能出现元话语', pattern: /重要|务必|切记|注意：/ },
]

export interface PromptLintIssue {
  rule: string
  match: string
}

/** 对 qwen21 提示词做机械规则检查（仅用于开发/测试断言，不阻塞生成） */
export function lintQwen21Prompt(text: string, imageCount: number): PromptLintIssue[] {
  const issues: PromptLintIssue[] = []
  for (const { rule, pattern } of LINT_RULES) {
    const hit = text.match(pattern)
    if (hit) issues.push({ rule, match: hit[0] })
  }
  if (imageCount >= 2 && !/<image1>/.test(text)) {
    issues.push({ rule: '多图必须使用 <imageN> 标签', match: '缺少 <image1>' })
  }
  if (imageCount === 1 && /<image1>/.test(text)) {
    issues.push({ rule: '单图不要使用 <imageN> 标签', match: '<image1>' })
  }
  return issues
}
