export interface PoseItem {
  source?: 'upload'
  /** 是否使用灰阶深度图（Depth Map）代替素体白模 */
  useDepth?: boolean
  id: string
  体系: string
  姿势编号: string
  分类: string
  姿势名称: string
  角度: string
  缩略图: string
  原图: string
  检索: string
}

export interface PoseGroup {
  key: string
  system: string
  number: string
  name: string
  category: string
  items: PoseItem[]
  angles: Record<string, PoseItem>
  order: PoseItem[]
}

export interface CostumeItem {
  source?: 'upload'
  id: string
  /** 服装图库版本：真人写实 / 二次元动漫（旧数据缺省按真人处理） */
  版本?: '真人' | '二次元'
  分类: string
  服装名称: string
  标签: string[]
  关键词: string
  缩略图: string
  预览图: string
  原图: string
  检索: string
}

export interface PortraitItem {
  source?: 'upload'
  id: string
  分区: string
  发长: string
  发型名称: string
  标题: string
  宽: number
  高: number
  字节数: number
  精选: boolean
  热门: boolean
  缩略图: string
  原图: string
  检索: string
}

export interface ExtraReferenceImage {
  role?: 'character_sheet'
  id: string
  name: string
  url: string
}

export interface RecipeState {
  portrait: PortraitItem | null
  costume: CostumeItem | null
  pose: PoseItem | null
  workflowImages?: Record<string, ExtraReferenceImage>
  workflowImagesIdentity?: string
  extraImages?: ExtraReferenceImage[]
}

export type ImageProviderId = 'gemini' | 'gpt' | 'qwen' | 'doubao' | 'comfyui'

export interface ProviderEndpointConfig {
  baseUrl: string
  apiKey: string
  model: string
  customModel: string
}

export type ImagePassMode = 'url' | 'base64'

export type WorkflowScalar = string | number | boolean

export interface WorkflowParameterOverrides {
  workflowId: string
  values: Record<string, Record<string, WorkflowScalar>>
}

export interface ComfyUiParams {
  parameterOverrides?: WorkflowParameterOverrides
  workflowPreset:
    | 'qwen2509_3img'
    | 'qwen2509_2img'
    | 'qwen21_3img'
    | 'qwen21_2img'
    | 'qwen21_local_3img'
    | 'qwen21_local_2img'
    | 'custom'
  workflowJson: string
  promptNodeId: string
  portraitNodeId: string
  costumeNodeId: string
  poseNodeId: string
  stitchedNodeId: string
  randomizeSeed: boolean
  /** 单次生成最长等待秒数 */
  timeoutSec: number
  /** 配置结构版本，用于迁移旧版默认值 */
  configVersion?: number
}

export interface GptParams {
  endpointMode: 'images_edits_json' | 'images_edits' | 'responses' | 'chat'
  size: 'auto' | '1024x1536' | '1024x1024' | '1536x1024'
  quality: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  inputFidelity: 'high' | 'low'
  background: 'auto' | 'opaque' | 'transparent'
  outputFormat: 'png' | 'jpeg' | 'webp'
  moderation: 'auto' | 'low'
}

export interface GeminiParams {
  endpointMode: 'native' | 'openai_chat'
  aspectRatio: '3:4' | '1:1' | '4:3' | '9:16' | '16:9'
  imageSize: '1K' | '2K' | '4K'
}

export interface QwenParams {
  size: '1024*1536' | '1328*1328' | '928*1664' | '1664*928'
  promptExtend: boolean
  watermark: boolean
  negativePrompt: string
  n: number
}

export interface DoubaoParams {
  size: '2K' | '4K' | '1K' | '1728x2304' | '2048x2048' | '1440x2560' | '2560x1440'
  sequentialImageGeneration: 'disabled' | 'auto'
  watermark: boolean
  responseFormat: 'b64_json' | 'url'
}

export interface ApiConfig {
  activeProvider: ImageProviderId
  imagePassMode: ImagePassMode
  useProxy: boolean
  stylePreset: string
  sendStitchedSheet: boolean
  providers: Record<ImageProviderId, ProviderEndpointConfig>
  gptParams: GptParams
  geminiParams: GeminiParams
  qwenParams: QwenParams
  doubaoParams: DoubaoParams
  comfyuiParams: ComfyUiParams
}

export interface GenerationHistoryItem {
  id: string
  createdAt: number
  provider: ImageProviderId
  model: string
  prompt: string
  imageUrl: string
  recipeSummary: string
}

/** 定时任务（自动随机出图）配置，保存在 localStorage */
export interface AutoGenConfig {
  /** 两次出图之间的随机间隔下限（秒） */
  minIntervalSec: number
  /** 两次出图之间的随机间隔上限（秒） */
  maxIntervalSec: number
  /** 本轮最多生成多少张，0 表示不限制 */
  maxImages: number
  /** 每次自动随机抽取 人像 + 服装 + 姿势 配方 */
  randomizeRecipe: boolean
  /** 每次自动随机切换画风预设 */
  randomizeStyle: boolean
  /** 连续失败 3 次时自动停止，避免持续消耗 API 额度 */
  stopOnFailure: boolean
  /** 生成后做质量检测，不达标直接丢弃重抽（仅定时任务） */
  qualityFilter: boolean
}

/** 定时任务运行状态（只保存在内存中，刷新页面即停止） */
export interface AutoGenStatus {
  enabled: boolean
  /** 已请求停止并中断了正在进行的生成 */
  stopping: boolean
  /** 当前是否有一张「自动生成」正在进行（区别于用户手动生成） */
  generating: boolean
  successCount: number
  failureCount: number
  consecutiveFailures: number
  /** 质量检测未通过、被直接丢弃的张数 */
  discardedCount: number
  consecutiveDiscards: number
  /** 最近一次质量丢弃原因 */
  lastRejectReason: string
  /** 下一次自动出图的时间戳（等待中才有值） */
  nextRunAt: number | null
  /** 最近一张自动生成结果（用于面板缩略图） */
  lastImageUrl: string
  lastError: string
  lastFinishedAt: number | null
}

/** 生图成人模式：off 关闭（仅 SFW）；mixed 混合（SFW + 18+）；only 仅 18+ 素材 */
export type AdultGenMode = 'off' | 'mixed' | 'only'

/** 随机配方抽取服装的版本范围（手动选择服装不受影响） */
export type RandomCostumeVersion = 'all' | '真人' | '二次元'

/** 生图保存文件夹的授权状态 */
export type SaveFolderPermission = 'granted' | 'prompt' | 'denied'

/** 生图保存位置（本地文件夹自动保存）状态 */
export interface SaveLocationState {
  /** 当前浏览器是否支持 File System Access（选择本地文件夹） */
  supported: boolean
  /** 已选择的文件夹名称，空字符串表示未选择 */
  folderName: string
  permission: SaveFolderPermission
  /** 生成后自动保存到文件夹（不支持文件夹时改为自动下载） */
  enabled: boolean
  /** 最近一次保存的文件名（或下载文件名） */
  lastSavedName: string
  lastSavedAt: number | null
  lastError: string
}
