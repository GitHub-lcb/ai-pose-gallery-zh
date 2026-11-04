import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { costumesQuery, isNsfwCostume, isNsfwPose, portraitsQuery, posesQuery } from '@/api/gallery'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { idbGet, idbSet } from '@/lib/idbStorage'
import { checkImageQuality, formatQualityReasons } from '@/lib/imageQuality'
import { parseParameterWorkflow, workflowIdentity } from '@/lib/comfyWorkflowParameters'
import { recipeBackup } from '@/lib/recipeImages'
import {
  abortActiveGeneration,
  buildRecipePrompt,
  COMFYUI_WORKFLOW_TEMPLATES,
  DEFAULT_COMFY_PRESET,
  generateCharacterImage,
  isActiveGenerationAborted,
  type ComfyPresetId,
  type GenerationProgress,
  PROVIDER_META,
  STYLE_PRESETS,
  stitchRecipeCanvas,
} from '@/services/aiGenerator'
import {
  downloadGeneratedImage,
  isSaveFolderSupported,
  loadSaveFolderHandle,
  persistSaveFolderHandle,
  pickSaveFolder,
  querySaveFolderPermission,
  requestSaveFolderPermission,
  saveImageUrlToFolder,
  SAVE_ENABLED_STORAGE_KEY,
  type FsDirectoryHandleLike,
} from '@/lib/outputFolder'
import type {
  AdultGenMode,
  ApiConfig,
  AutoGenConfig,
  AutoGenStatus,
  ComfyUiParams,
  CostumeItem,
  DoubaoParams,
  ExtraReferenceImage,
  GeminiParams,
  GenerationHistoryItem,
  GptParams,
  ImageProviderId,
  PortraitItem,
  PoseItem,
  ProviderEndpointConfig,
  QwenParams,
  RandomCostumeVersion,
  RecipeState,
  SaveLocationState,
} from '@/types/gallery'

const CFG_KEY = 'pose_atlas_api_config_v3'
const RECIPE_KEY = 'pose_atlas_recipe_v3'
const HISTORY_KEY = 'pose_atlas_history_v3'
const SAFE_MODE_KEY = 'pose_atlas_safe_mode_v1'
const AUTOGEN_KEY = 'pose_atlas_autogen_config_v1'
const ADULT_GEN_MODE_KEY = 'pose_atlas_adult_gen_mode_v1'
const RANDOM_COSTUME_KEY = 'pose_atlas_random_costume_version_v1'

// ============================================================================
// 定时任务（自动随机出图）
// ============================================================================
const DEFAULT_AUTOGEN_CONFIG: AutoGenConfig = {
  minIntervalSec: 10,
  maxIntervalSec: 30,
  maxImages: 0,
  randomizeRecipe: true,
  randomizeStyle: true,
  stopOnFailure: true,
  qualityFilter: true,
}

const EMPTY_AUTOGEN_STATUS: AutoGenStatus = {
  enabled: false,
  stopping: false,
  generating: false,
  successCount: 0,
  failureCount: 0,
  consecutiveFailures: 0,
  discardedCount: 0,
  consecutiveDiscards: 0,
  lastRejectReason: '',
  nextRunAt: null,
  lastImageUrl: '',
  lastError: '',
  lastFinishedAt: null,
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

function normalizeAutoGenConfig(patch: Partial<AutoGenConfig>, base: AutoGenConfig): AutoGenConfig {
  const merged = { ...base, ...patch }
  const minIntervalSec = clampInt(merged.minIntervalSec, 1, 7200, base.minIntervalSec)
  return {
    minIntervalSec,
    maxIntervalSec: clampInt(merged.maxIntervalSec, minIntervalSec, 7200, base.maxIntervalSec),
    maxImages: clampInt(merged.maxImages, 0, 100000, base.maxImages),
    randomizeRecipe: Boolean(merged.randomizeRecipe),
    randomizeStyle: Boolean(merged.randomizeStyle),
    stopOnFailure: Boolean(merged.stopOnFailure),
    // 旧配置没有该字段时默认开启质量过滤
    qualityFilter: merged.qualityFilter !== false,
  }
}

function loadAutoGenConfig(): AutoGenConfig {
  try {
    const raw = localStorage.getItem(AUTOGEN_KEY)
    if (!raw) return DEFAULT_AUTOGEN_CONFIG
    return normalizeAutoGenConfig(JSON.parse(raw) as Partial<AutoGenConfig>, DEFAULT_AUTOGEN_CONFIG)
  } catch {
    return DEFAULT_AUTOGEN_CONFIG
  }
}

/** 安全模式开启时强制按「关闭成人模式」处理（双保险，正常流程下二者互斥） */
const effectiveAdultMode = (safeMode: boolean, mode: AdultGenMode): AdultGenMode =>
  safeMode ? 'off' : mode

/** 按成人模式筛选随机池：off 仅 SFW / mixed 全部 / only 仅 18+ */
function filterAdultPools<T>(list: T[], isNsfw: (item: T) => boolean, mode: AdultGenMode): T[] {
  if (mode === 'mixed') return list
  if (mode === 'only') return list.filter(isNsfw)
  return list.filter((item) => !isNsfw(item))
}

/** 随机抽取一套「人像 + 服装 + 姿势」配方（纯函数，不修改入参） */
function pickRandomRecipe(
  base: RecipeState,
  pools: { portraits: PortraitItem[]; costumes: CostumeItem[]; poses: PoseItem[] },
  adultMode: AdultGenMode,
  poseDepthMode: boolean,
  costumeVersion: RandomCostumeVersion
): RecipeState {
  const posePool = filterAdultPools(pools.poses, (item) => isNsfwPose(item), adultMode)
  let costumePool = filterAdultPools(pools.costumes, (item) => isNsfwCostume(item), adultMode)
  // 随机配方的服装版本范围（手动选择服装不受影响）
  if (costumeVersion !== 'all') {
    costumePool = costumePool.filter((item) => (item.版本 ?? '真人') === costumeVersion)
  }
  const pick = <T,>(list: T[]): T | undefined =>
    list.length ? list[Math.floor(Math.random() * list.length)] : undefined
  const pose = pick(posePool)
  return {
    ...base,
    portrait: pick(pools.portraits) ?? base.portrait,
    costume: pick(costumePool) ?? base.costume,
    pose: pose ? { ...pose, useDepth: poseDepthMode } : base.pose,
  }
}

const randomBetween = (min: number, max: number): number =>
  min + Math.floor(Math.random() * (Math.max(min, max) - min + 1))

const COMFY_CONFIG_VERSION = 7

const shouldEnableProxyByDefault = (provider?: ImageProviderId) =>
  provider === 'qwen' || provider === 'doubao'

const DEFAULT_API_CONFIG: ApiConfig = {
  activeProvider: 'gemini',
  imagePassMode: 'url',
  useProxy: false,
  stylePreset: 'realistic',
  sendStitchedSheet: false,
  providers: {
    gemini: {
      baseUrl: PROVIDER_META.gemini.defaultBaseUrl,
      apiKey: '',
      model: PROVIDER_META.gemini.models[0].value,
      customModel: '',
    },
    gpt: {
      baseUrl: PROVIDER_META.gpt.defaultBaseUrl,
      apiKey: '',
      model: PROVIDER_META.gpt.models[0].value,
      customModel: '',
    },
    qwen: {
      baseUrl: PROVIDER_META.qwen.defaultBaseUrl,
      apiKey: '',
      model: PROVIDER_META.qwen.models[0].value,
      customModel: '',
    },
    doubao: {
      baseUrl: PROVIDER_META.doubao.defaultBaseUrl,
      apiKey: '',
      model: PROVIDER_META.doubao.models[0].value,
      customModel: '',
    },
    comfyui: {
      baseUrl: PROVIDER_META.comfyui.defaultBaseUrl,
      apiKey: '',
      model: PROVIDER_META.comfyui.models[0].value,
      customModel: '',
    },
  },
  gptParams: {
    endpointMode: 'images_edits_json',
    size: '1024x1536',
    quality: 'high',
    inputFidelity: 'high',
    background: 'auto',
    outputFormat: 'png',
    moderation: 'auto',
  },
  geminiParams: {
    endpointMode: 'native',
    aspectRatio: '3:4',
    imageSize: '2K',
  },
  qwenParams: {
    size: '1024*1536',
    promptExtend: true,
    watermark: false,
    negativePrompt: '',
    n: 1,
  },
  doubaoParams: {
    size: '2K',
    sequentialImageGeneration: 'disabled',
    watermark: false,
    responseFormat: 'b64_json',
  },
  comfyuiParams: {
    workflowPreset: DEFAULT_COMFY_PRESET,
    workflowJson: JSON.stringify(COMFYUI_WORKFLOW_TEMPLATES[DEFAULT_COMFY_PRESET].workflow, null, 2),
    ...COMFYUI_WORKFLOW_TEMPLATES[DEFAULT_COMFY_PRESET].defaults,
    randomizeSeed: true,
    timeoutSec: 600,
    configVersion: COMFY_CONFIG_VERSION,
  },
}

// v1 → v2：旧版默认的 Qwen 2.1 预设引用了本机通常不存在的模型，自动切换为 Qwen Image Edit 2509
// v3 → v4：本机（ComfyUI 0.42.3 + Qwen-Image 2.1 int8）未安装 2509 模型，默认模板改用 2.1 本机版
// v4 → v5：2.1 本机模板改为「按姿势图比例确定输出尺寸」（约 1152×1536），刷新已保存的工作流
// v5 → v6：2.1 本机模板的 KV cache 改为 int8（实测每张 79s → 60s），刷新已保存的工作流
// v6 → v7：本地 ComfyUI 默认端口改为 8188（pnpm dev 自动探测 8000/8188/8088/8189），旧的 8000 等地址自动迁移
const LEGACY_COMFY_BASE_URLS = [
  'http://127.0.0.1:8000',
  'http://localhost:8000',
  'http://127.0.0.1:8188',
  'http://localhost:8188',
]

// 旧模板 → 本机可用的 Qwen-Image 2.1 模板（模型文件与节点均已在本机安装）
const LEGACY_PRESET_MIGRATIONS: Partial<Record<ComfyUiParams['workflowPreset'], ComfyPresetId>> = {
  qwen2509_3img: 'qwen21_local_3img',
  qwen21_3img: 'qwen21_local_3img',
  qwen2509_2img: 'qwen21_local_2img',
  qwen21_2img: 'qwen21_local_2img',
}

// 内置本机模板升级后，同步刷新已保存的工作流 JSON（自定义导入的 'custom' 不受影响）
const LOCAL_PRESETS: ComfyPresetId[] = ['qwen21_local_3img', 'qwen21_local_2img']

function migrateComfy(
  provider: ApiConfig['providers']['comfyui'],
  params: ApiConfig['comfyuiParams']
): { provider: ApiConfig['providers']['comfyui']; params: ApiConfig['comfyuiParams'] } {
  if ((params.configVersion ?? 1) >= COMFY_CONFIG_VERSION) return { provider, params }
  const nextParams = { ...params, configVersion: COMFY_CONFIG_VERSION }
  const migratedPreset =
    LEGACY_PRESET_MIGRATIONS[params.workflowPreset] ??
    (LOCAL_PRESETS.includes(params.workflowPreset as ComfyPresetId) ? (params.workflowPreset as ComfyPresetId) : undefined)
  if (migratedPreset && COMFYUI_WORKFLOW_TEMPLATES[migratedPreset]) {
    Object.assign(nextParams, {
      workflowPreset: migratedPreset,
      workflowJson: JSON.stringify(COMFYUI_WORKFLOW_TEMPLATES[migratedPreset].workflow, null, 2),
      ...COMFYUI_WORKFLOW_TEMPLATES[migratedPreset].defaults,
    })
  }
  const nextProvider = { ...provider }
  if (!nextProvider.baseUrl.trim() || LEGACY_COMFY_BASE_URLS.includes(nextProvider.baseUrl.trim())) {
    nextProvider.baseUrl = PROVIDER_META.comfyui.defaultBaseUrl
  }
  if (!PROVIDER_META.comfyui.models.some((m) => m.value === nextProvider.model)) {
    nextProvider.model = PROVIDER_META.comfyui.models[0].value
  }
  return { provider: nextProvider, params: nextParams }
}

function mergeStoredConfig(raw: unknown): ApiConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_API_CONFIG
  const obj = raw as Partial<ApiConfig>
  const storedVer = obj.comfyuiParams?.configVersion ?? 1
  const comfy = migrateComfy(
    { ...DEFAULT_API_CONFIG.providers.comfyui, ...obj.providers?.comfyui },
    { ...DEFAULT_API_CONFIG.comfyuiParams, configVersion: 1, ...obj.comfyuiParams }
  )
  const activeProvider = obj.activeProvider ?? DEFAULT_API_CONFIG.activeProvider
  // v3 起服务端 CORS 代理默认关闭，仅在切换到 Qwen / Doubao 时自动关联开启
  const useProxy =
    storedVer < 3
      ? shouldEnableProxyByDefault(activeProvider)
      : (obj.useProxy ?? shouldEnableProxyByDefault(activeProvider))
  return {
    ...DEFAULT_API_CONFIG,
    ...obj,
    activeProvider,
    useProxy,
    providers: {
      gemini: { ...DEFAULT_API_CONFIG.providers.gemini, ...obj.providers?.gemini },
      gpt: { ...DEFAULT_API_CONFIG.providers.gpt, ...obj.providers?.gpt },
      qwen: { ...DEFAULT_API_CONFIG.providers.qwen, ...obj.providers?.qwen },
      doubao: { ...DEFAULT_API_CONFIG.providers.doubao, ...obj.providers?.doubao },
      comfyui: comfy.provider,
    },
    gptParams: { ...DEFAULT_API_CONFIG.gptParams, ...obj.gptParams },
    geminiParams: { ...DEFAULT_API_CONFIG.geminiParams, ...obj.geminiParams },
    qwenParams: { ...DEFAULT_API_CONFIG.qwenParams, ...obj.qwenParams },
    doubaoParams: { ...DEFAULT_API_CONFIG.doubaoParams, ...obj.doubaoParams },
    comfyuiParams: comfy.params,
  }
}

interface GenerationOverrides {
  recipe?: RecipeState
  config?: ApiConfig
}

interface StudioContextValue {
  recipe: RecipeState
  apiConfig: ApiConfig
  history: GenerationHistoryItem[]
  safeMode: boolean
  toggleSafeMode: () => void
  requestUnlockNsfw: (onUnlocked?: () => void) => void
  /** 生图成人模式（仅影响「随机配方」与定时任务，不影响图库浏览） */
  adultGenMode: AdultGenMode
  requestAdultGenMode: (mode: AdultGenMode) => void
  /** 随机配方抽取服装的版本范围（手动选择服装不受影响） */
  randomCostumeVersion: RandomCostumeVersion
  setRandomCostumeVersion: (version: RandomCostumeVersion) => void
  poseDepthMode: boolean
  setPoseDepthMode: (val: boolean) => void
  toggleRecipePoseDepth: () => void
  // 全局持久化的合成台状态（切换页面不丢失、不断开请求）
  customPrompt: string | null
  setCustomPrompt: (val: string | null) => void
  previewUrl: string
  setPreviewUrl: (url: string) => void
  isGenerating: boolean
  generatingModel: string
  generationProgress: GenerationProgress | null
  generationError: string
  startGeneration: (
    overridePrompt?: string,
    overrides?: GenerationOverrides
  ) => Promise<{
    ok: boolean
    imageUrl?: string
    busy?: boolean
    rejected?: boolean
    rejectReasons?: string[]
  }>
  refreshStitchPreview: () => Promise<void>
  // 定时任务（自动随机出图，可随时停止）
  autoGenConfig: AutoGenConfig
  updateAutoGenConfig: (patch: Partial<AutoGenConfig>) => void
  autoGenStatus: AutoGenStatus
  startAutoGen: () => void
  stopAutoGen: () => void
  // 生图保存位置（本地文件夹自动保存）
  saveLocation: SaveLocationState
  chooseSaveFolder: () => Promise<void>
  authorizeSaveFolder: () => Promise<void>
  clearSaveFolder: () => Promise<void>
  toggleAutoSave: (enabled: boolean) => void
  saveCurrentImage: () => Promise<void>
  setPortrait: (item: PortraitItem | null) => void
  setCostume: (item: CostumeItem | null) => void
  setPose: (item: PoseItem | null) => void
  togglePortrait: (item: PortraitItem) => void
  toggleCostume: (item: CostumeItem) => void
  togglePose: (item: PoseItem) => void
  addExtraImage: (item: { name: string; url: string }) => void
  removeExtraImage: (id: string) => void
  updateExtraImageName: (id: string, name: string) => void
  setWorkflowImage: (nodeId: string, image: ExtraReferenceImage | null, identity: string) => void
  clearRecipe: () => void
  randomizeRecipe: (pools: { portraits?: PortraitItem[]; costumes?: CostumeItem[]; poses?: PoseItem[] }) => void
  updateApiConfig: (patch: Partial<ApiConfig>) => void
  updateProviderConfig: (provider: ImageProviderId, patch: Partial<ProviderEndpointConfig>) => void
  updateGptParams: (patch: Partial<GptParams>) => void
  updateGeminiParams: (patch: Partial<GeminiParams>) => void
  updateQwenParams: (patch: Partial<QwenParams>) => void
  updateDoubaoParams: (patch: Partial<DoubaoParams>) => void
  updateComfyUiParams: (patch: Partial<ComfyUiParams>) => void
  addHistory: (item: Omit<GenerationHistoryItem, 'id' | 'createdAt'>) => void
  removeHistoryItem: (id: string) => void
  clearHistory: () => void
}

const StudioContext = createContext<StudioContextValue | null>(null)

export function StudioProvider({ children }: { children: ReactNode }) {
  const [recipe, setRecipe] = useState<RecipeState>(() => {
    try {
      const raw = localStorage.getItem(RECIPE_KEY)
      if (!raw) return { portrait: null, costume: null, pose: null, extraImages: [] }
      const parsed = JSON.parse(raw)
      return {
        portrait: parsed.portrait ?? null,
        costume: parsed.costume ?? null,
        pose: parsed.pose ?? null,
        extraImages: Array.isArray(parsed.extraImages) ? parsed.extraImages : [],
      }
    } catch {
      return { portrait: null, costume: null, pose: null, extraImages: [] }
    }
  })

  const [apiConfig, setApiConfig] = useState<ApiConfig>(() => {
    try {
      const raw = localStorage.getItem(CFG_KEY)
      return raw ? mergeStoredConfig(JSON.parse(raw)) : DEFAULT_API_CONFIG
    } catch {
      return DEFAULT_API_CONFIG
    }
  })

  const [history, setHistory] = useState<GenerationHistoryItem[]>(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })

  const [safeMode, setSafeMode] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(SAFE_MODE_KEY)
      return raw === null ? true : raw !== 'false'
    } catch {
      return true
    }
  })
  const [adultGenMode, setAdultGenModeState] = useState<AdultGenMode>(() => {
    try {
      // 安全模式开启时不允许保留成人生图模式（双保险）
      if (localStorage.getItem(SAFE_MODE_KEY) !== 'false') return 'off'
      const raw = localStorage.getItem(ADULT_GEN_MODE_KEY)
      return raw === 'mixed' || raw === 'only' ? raw : 'off'
    } catch {
      return 'off'
    }
  })
  const [ageGateOpen, setAgeGateOpen] = useState(false)
  const pendingUnlockCbRef = useRef<(() => void) | null>(null)
  const [randomCostumeVersion, setRandomCostumeVersionState] = useState<RandomCostumeVersion>(() => {
    try {
      const raw = localStorage.getItem(RANDOM_COSTUME_KEY)
      // 默认「仅真人写实」：避免随机/定时任务把真人脸与动漫服装混搭出违和感；需要动漫服装时可手动切换
      return raw === 'all' || raw === '二次元' || raw === '真人' ? raw : '真人'
    } catch {
      return '真人'
    }
  })
  const [poseDepthMode, setPoseDepthModeState] = useState<boolean>(() => Boolean(recipe.pose?.useDepth))

  // 提升到根部 Provider 的生成状态，路由切换不会卸载或中断
  const [customPrompt, setCustomPrompt] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string>(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      const list = raw ? JSON.parse(raw) : []
      return list[0]?.imageUrl || ''
    } catch {
      return ''
    }
  })
  const [isGenerating, setIsGenerating] = useState(false)
  const [generatingModel, setGeneratingModel] = useState('')
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null)
  const [generationError, setGenerationError] = useState('')
  const isGeneratingRef = useRef(false)
  const [idbHydrated, setIdbHydrated] = useState(false)

  // 定时任务：配置持久化（localStorage），运行状态只保存在内存中（刷新/关页即停止）
  const qc = useQueryClient()
  const [autoGenConfig, setAutoGenConfig] = useState<AutoGenConfig>(loadAutoGenConfig)
  const [autoGenStatus, setAutoGenStatus] = useState<AutoGenStatus>(EMPTY_AUTOGEN_STATUS)
  const autoGenConfigRef = useRef<AutoGenConfig>(autoGenConfig)
  const autoGenStatusRef = useRef<AutoGenStatus>(autoGenStatus)
  const autoGenEnabledRef = useRef(false)
  const autoGenSessionRef = useRef(0)
  const autoGenTimerRef = useRef<number | null>(null)
  // 当前「自动生成」的 token（0 = 没有自动生成在跑）；用于区分新旧 cycle 的收尾
  const autoGenGeneratingRef = useRef(0)
  const lastGenerationErrorRef = useRef('')
  const recipeStateRef = useRef({
    recipe,
    apiConfig,
    safeMode,
    poseDepthMode,
    adultGenMode,
    randomCostumeVersion,
  })

  useEffect(() => {
    autoGenConfigRef.current = autoGenConfig
  }, [autoGenConfig])

  useEffect(() => {
    autoGenStatusRef.current = autoGenStatus
  }, [autoGenStatus])

  useEffect(() => {
    recipeStateRef.current = {
      recipe,
      apiConfig,
      safeMode,
      poseDepthMode,
      adultGenMode,
      randomCostumeVersion,
    }
  }, [recipe, apiConfig, safeMode, poseDepthMode, adultGenMode, randomCostumeVersion])

  useEffect(() => {
    try {
      localStorage.setItem(AUTOGEN_KEY, JSON.stringify(autoGenConfig))
    } catch {}
  }, [autoGenConfig])

  useEffect(
    () => () => {
      if (autoGenTimerRef.current !== null) window.clearTimeout(autoGenTimerRef.current)
      // Provider 卸载（如 HMR）时停止定时任务并中断在途请求，避免旧实例继续写状态
      autoGenEnabledRef.current = false
      abortActiveGeneration()
    },
    []
  )

  // 生图保存位置：文件夹句柄存 IndexedDB，自动保存开关存 localStorage
  const [saveLocation, setSaveLocation] = useState<SaveLocationState>(() => ({
    supported: isSaveFolderSupported(),
    folderName: '',
    permission: 'prompt',
    enabled: (() => {
      try {
        return localStorage.getItem(SAVE_ENABLED_STORAGE_KEY) === '1'
      } catch {
        return false
      }
    })(),
    lastSavedName: '',
    lastSavedAt: null,
    lastError: '',
  }))
  const saveDirHandleRef = useRef<FsDirectoryHandleLike | null>(null)
  const saveLocationRef = useRef(saveLocation)

  useEffect(() => {
    saveLocationRef.current = saveLocation
  }, [saveLocation])

  useEffect(() => {
    let active = true
    void (async () => {
      const handle = await loadSaveFolderHandle()
      if (!active || !handle) return
      saveDirHandleRef.current = handle
      const permission = await querySaveFolderPermission(handle)
      if (!active) return
      setSaveLocation((prev) => ({ ...prev, folderName: handle.name, permission }))
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SAVE_ENABLED_STORAGE_KEY, saveLocation.enabled ? '1' : '0')
    } catch {}
  }, [saveLocation.enabled])

  // 从 IndexedDB 异步恢复大容量历史记录与含附图的配方
  useEffect(() => {
    let active = true
    Promise.all([
      idbGet<RecipeState>(RECIPE_KEY),
      idbGet<GenerationHistoryItem[]>(HISTORY_KEY),
    ]).then(([savedRecipe, savedHistory]) => {
      if (!active) return
      if (savedRecipe) {
        if (savedRecipe.pose?.useDepth !== undefined) {
          setPoseDepthModeState(Boolean(savedRecipe.pose.useDepth))
        }
        setRecipe({
          portrait: savedRecipe.portrait ?? null,
          costume: savedRecipe.costume ?? null,
          pose: savedRecipe.pose ?? null,
          workflowImages: savedRecipe.workflowImages ?? {},
          workflowImagesIdentity: savedRecipe.workflowImagesIdentity,
          extraImages: Array.isArray(savedRecipe.extraImages) ? savedRecipe.extraImages : [],
        })
      }
      if (Array.isArray(savedHistory) && savedHistory.length > 0) {
        setHistory(savedHistory)
        setPreviewUrl((prev) => prev || savedHistory[0]?.imageUrl || '')
      }
      setIdbHydrated(true)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!idbHydrated) return
    void idbSet(RECIPE_KEY, recipe)
    try {
      // 上传图片和附图完整保存在 IndexedDB，轻量备份不包含它们。
      localStorage.setItem(
        RECIPE_KEY,
        JSON.stringify(recipeBackup(recipe))
      )
    } catch {}
  }, [recipe, idbHydrated])

  useEffect(() => {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(apiConfig))
    } catch {}
  }, [apiConfig])

  useEffect(() => {
    try {
      localStorage.setItem(SAFE_MODE_KEY, String(safeMode))
    } catch {}
  }, [safeMode])

  useEffect(() => {
    try {
      localStorage.setItem(RANDOM_COSTUME_KEY, randomCostumeVersion)
    } catch {}
  }, [randomCostumeVersion])

  useEffect(() => {
    try {
      localStorage.setItem(ADULT_GEN_MODE_KEY, adultGenMode)
    } catch {}
  }, [adultGenMode])

  const requestUnlockNsfw = (onUnlocked?: () => void) => {
    if (!safeMode) {
      onUnlocked?.()
      return
    }
    pendingUnlockCbRef.current = onUnlocked || null
    setAgeGateOpen(true)
  }

  const confirmUnlockNsfw = () => {
    setSafeMode(false)
    setAgeGateOpen(false)
    toast.success('已解锁 18+ 完整图库模式')
    const cb = pendingUnlockCbRef.current
    pendingUnlockCbRef.current = null
    cb?.()
  }

  const toggleSafeMode = () => {
    if (safeMode) {
      requestUnlockNsfw()
    } else {
      setSafeMode(true)
      setAdultGenModeState('off')
      toast.success('已开启安全模式（已隐藏 18+ 敏感分类，生图成人模式已关闭）')
    }
  }

  // 生图成人模式：关闭 / 混合 / 仅 18+（仅影响随机配方与定时任务，不影响图库浏览）
  const applyAdultGenMode = (mode: AdultGenMode) => {
    setAdultGenModeState(mode)
    if (mode === 'off') {
      toast.success('已关闭生图成人模式：随机配方仅使用 SFW 素材')
    } else if (mode === 'only') {
      toast.success('已开启生图成人模式（仅 18+）：随机配方只从性感 / 内衣分类抽取')
    } else {
      toast.success('已开启生图成人模式（混合）：随机配方会混合 18+ 素材')
    }
  }

  const requestAdultGenMode = (mode: AdultGenMode) => {
    if (mode === adultGenMode) return
    // 开启成人模式需先通过 18+ 年龄确认（同时解锁图库敏感分类，避免图库与生图状态不一致）
    if (mode !== 'off' && safeMode) {
      requestUnlockNsfw(() => applyAdultGenMode(mode))
      return
    }
    applyAdultGenMode(mode)
  }

  const setRandomCostumeVersion = (version: RandomCostumeVersion) => {
    setRandomCostumeVersionState(version)
    toast.success(
      version === 'all'
        ? '随机配方服装：全部版本（真人 + 二次元）'
        : version === '真人'
          ? '随机配方服装：仅真人写实（避免与真人脸混搭二次元服装）'
          : '随机配方服装：仅二次元动漫（建议搭配二次元 / 2.5D 画风）'
    )
  }

  useEffect(() => {
    if (!idbHydrated) return
    void idbSet(HISTORY_KEY, history.slice(0, 30))
  }, [history, idbHydrated])

  const setPortrait = (portrait: PortraitItem | null) => setRecipe((r) => ({ ...r, portrait }))
  const setCostume = (costume: CostumeItem | null) => setRecipe((r) => ({ ...r, costume }))
  const setPose = (pose: PoseItem | null) => setRecipe((r) => ({ ...r, pose }))

  const setPoseDepthMode = (val: boolean) => {
    setPoseDepthModeState(val)
    setRecipe((r) => {
      if (!r.pose || r.pose.source === 'upload' || Boolean(r.pose.useDepth) === val) return r
      return { ...r, pose: { ...r.pose, useDepth: val } }
    })
  }

  const toggleRecipePoseDepth = () => {
    const next = !(recipe.pose?.useDepth ?? poseDepthMode)
    setPoseDepthMode(next)
    toast.success(next ? '已切换姿势图为：深度图 (Depth)' : '已切换姿势图为：素体白模')
  }

  const togglePortrait = (item: PortraitItem) => {
    setRecipe((r) => {
      const remove = r.portrait?.id === item.id
      toast.success(remove ? '已移除人像' : `已选人像：${item.发型名称}`)
      return { ...r, portrait: remove ? null : item }
    })
  }

  const toggleCostume = (item: CostumeItem) => {
    setRecipe((r) => {
      const remove = r.costume?.id === item.id
      const isPhotoStyle = ['realistic', 'fashion', 'film'].includes(apiConfig.stylePreset)
      toast.success(
        remove
          ? '已移除服装'
          : item.版本 === '二次元'
            ? `已选动漫服装：${item.服装名称}（${isPhotoStyle ? '写实画风下将转译为真实材质' : '将按当前画风统一渲染'}）`
            : `已选服装：${item.服装名称}`
      )
      return { ...r, costume: remove ? null : item }
    })
  }

  const togglePose = (item: PoseItem) => {
    const useDepth = item.source === 'upload' ? false : (item.useDepth ?? poseDepthMode)
    setRecipe((r) => {
      const remove = r.pose?.id === item.id && Boolean(r.pose?.useDepth) === useDepth
      toast.success(
        remove
          ? '已移除姿势'
          : `已选姿势：${item.姿势名称}（${item.角度}${useDepth ? ' · 深度图' : ''}）`
      )
      return { ...r, pose: remove ? null : { ...item, useDepth } }
    })
  }

  const addExtraImage = (item: { name: string; url: string }) => {
    const newImg: ExtraReferenceImage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: item.name || '附加参考',
      url: item.url,
    }
    setRecipe((r) => ({
      ...r,
      extraImages: [...(r.extraImages || []), newImg],
    }))
    toast.success('已添加附加参考图')
  }

  const removeExtraImage = (id: string) => {
    setRecipe((r) => ({
      ...r,
      extraImages: (r.extraImages || []).filter((x) => x.id !== id),
    }))
  }

  const updateExtraImageName = (id: string, name: string) => {
    setRecipe((r) => ({
      ...r,
      extraImages: (r.extraImages || []).map((x) => (x.id === id ? { ...x, name } : x)),
    }))
  }

  const setWorkflowImage = (nodeId: string, image: ExtraReferenceImage | null, identity: string) => {
    if (identity !== workflowIdentity(apiConfig.comfyuiParams.workflowJson)) return
    setRecipe((r) => {
      const workflowImages = r.workflowImagesIdentity === identity ? { ...r.workflowImages } : {}
      if (image) workflowImages[nodeId] = image
      else delete workflowImages[nodeId]
      return { ...r, workflowImages, workflowImagesIdentity: identity }
    })
  }

  const activeComfyParams = apiConfig.comfyuiParams
  useEffect(() => {
    if (!idbHydrated) return
    const cp = activeComfyParams
    const identity = workflowIdentity(cp.workflowJson)
    const workflow = parseParameterWorkflow(cp.workflowJson)
    const mapped = [cp.portraitNodeId, cp.costumeNodeId, cp.poseNodeId, cp.stitchedNodeId]
    const ids = new Set(Object.entries(workflow || {}).filter(([id, node]) => !mapped.includes(id) && typeof node.inputs.image === 'string').map(([id]) => id))
    // IndexedDB 恢复与工作流变更同步时清理失效映射。
    // oxlint-disable-next-line react/set-state-in-effect
    setRecipe((r) => {
      const entries = Object.entries(r.workflowImages || {})
      const kept = r.workflowImagesIdentity === identity ? entries.filter(([id]) => ids.has(id)) : []
      if (entries.length === kept.length && r.workflowImagesIdentity === identity) return r
      return { ...r, workflowImages: Object.fromEntries(kept), workflowImagesIdentity: identity }
    })
  }, [activeComfyParams, idbHydrated])

  const clearRecipe = () => {
    setRecipe({ portrait: null, costume: null, pose: null, extraImages: [] })
    toast.success('已清空配方')
  }

  const randomizeRecipe = (pools: { portraits?: PortraitItem[]; costumes?: CostumeItem[]; poses?: PoseItem[] }) => {
    const mode = effectiveAdultMode(safeMode, adultGenMode)
    const posePool = filterAdultPools(pools.poses || [], (item) => isNsfwPose(item), mode)
    let costumePool = filterAdultPools(pools.costumes || [], (item) => isNsfwCostume(item), mode)
    if (randomCostumeVersion !== 'all') {
      costumePool = costumePool.filter((item) => (item.版本 ?? '真人') === randomCostumeVersion)
    }
    const portraitPool = pools.portraits || []

    setRecipe((prev) => ({
      ...prev,
      portrait: portraitPool.length
        ? portraitPool[Math.floor(Math.random() * portraitPool.length)]
        : prev.portrait,
      costume: costumePool.length
        ? costumePool[Math.floor(Math.random() * costumePool.length)]
        : prev.costume,
      pose: posePool.length
        ? { ...posePool[Math.floor(Math.random() * posePool.length)], useDepth: poseDepthMode }
        : prev.pose,
    }))
    toast.success(
      mode === 'off'
        ? safeMode
          ? '已随机抽取一套角色配方（安全模式）'
          : '已随机抽取一套角色配方（仅 SFW 素材）'
        : mode === 'only'
          ? '已随机抽取一套 18+ 角色配方（仅 18+ 素材）'
          : '已随机抽取一套角色配方（含 18+ 素材）'
    )
  }

  const updateApiConfig = (patch: Partial<ApiConfig>) => {
    setApiConfig((prev) => {
      const next = { ...prev, ...patch }
      if (patch.activeProvider && patch.useProxy === undefined) {
        next.useProxy = shouldEnableProxyByDefault(patch.activeProvider)
      }
      return next
    })
  }

  const updateProviderConfig = (provider: ImageProviderId, patch: Partial<ProviderEndpointConfig>) => {
    setApiConfig((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [provider]: {
          ...prev.providers[provider],
          ...patch,
        },
      },
    }))
  }

  const updateGptParams = (patch: Partial<GptParams>) => {
    setApiConfig((prev) => ({ ...prev, gptParams: { ...prev.gptParams, ...patch } }))
  }

  const updateGeminiParams = (patch: Partial<GeminiParams>) => {
    setApiConfig((prev) => ({ ...prev, geminiParams: { ...prev.geminiParams, ...patch } }))
  }

  const updateQwenParams = (patch: Partial<QwenParams>) => {
    setApiConfig((prev) => ({ ...prev, qwenParams: { ...prev.qwenParams, ...patch } }))
  }

  const updateDoubaoParams = (patch: Partial<DoubaoParams>) => {
    setApiConfig((prev) => ({ ...prev, doubaoParams: { ...prev.doubaoParams, ...patch } }))
  }

  const updateComfyUiParams = (patch: Partial<ComfyUiParams>) => {
    setApiConfig((prev) => ({ ...prev, comfyuiParams: { ...prev.comfyuiParams, ...patch } }))
  }

  const addHistory = (item: Omit<GenerationHistoryItem, 'id' | 'createdAt'>) => {
    setHistory((prev) => [
      { ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() },
      ...prev.slice(0, 29),
    ])
  }

  const removeHistoryItem = (id: string) => {
    setHistory((prev) => prev.filter((x) => x.id !== id))
    toast.success('已删除该条记录')
  }

  const clearHistory = () => {
    setHistory([])
    void idbSet(HISTORY_KEY, [])
    try {
      localStorage.removeItem(HISTORY_KEY)
    } catch {}
    toast.success('已清空记录')
  }

  const refreshStitchPreview = async () => {
    try {
      const url = await stitchRecipeCanvas(recipe)
      setPreviewUrl(url)
      toast.success('已合成参考拼图')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '拼图失败')
    }
  }

  // ==========================================================================
  // 生图保存位置：选择本地文件夹 → 生成后自动写入（浏览器授权范围内）
  // 不支持 File System Access 的浏览器回退为「自动下载到默认下载目录」
  // ==========================================================================
  const chooseSaveFolder = async () => {
    if (!isSaveFolderSupported()) {
      toast.error('当前浏览器不支持选择文件夹（需 Chrome / Edge 桌面版），可开启「生成后自动下载」')
      return
    }
    try {
      const handle = await pickSaveFolder()
      if (!handle) return
      saveDirHandleRef.current = handle
      await persistSaveFolderHandle(handle)
      const permission = await querySaveFolderPermission(handle)
      setSaveLocation((prev) => ({ ...prev, folderName: handle.name, permission, enabled: true, lastError: '' }))
      toast.success(`已选择保存位置：${handle.name}（生成后自动保存已开启）`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '选择文件夹失败')
    }
  }

  const authorizeSaveFolder = async () => {
    const handle = saveDirHandleRef.current
    if (!handle) {
      await chooseSaveFolder()
      return
    }
    try {
      const granted = await requestSaveFolderPermission(handle)
      if (!granted) {
        toast.error('未获得文件夹权限，请点击「更换」重新选择保存位置')
        return
      }
      setSaveLocation((prev) => ({ ...prev, permission: 'granted', enabled: true, lastError: '' }))
      toast.success('已获得保存文件夹读写权限')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '授权失败')
    }
  }

  const clearSaveFolder = async () => {
    saveDirHandleRef.current = null
    await persistSaveFolderHandle(null)
    setSaveLocation((prev) => ({
      ...prev,
      folderName: '',
      permission: 'prompt',
      enabled: false,
      lastSavedName: '',
      lastError: '',
    }))
    toast.success('已清除保存位置')
  }

  const toggleAutoSave = (enabled: boolean) => {
    if (enabled && !saveDirHandleRef.current) {
      if (isSaveFolderSupported()) {
        // 没有文件夹时直接拉起选择器，选择成功后自动开启
        void chooseSaveFolder()
        return
      }
      setSaveLocation((prev) => ({ ...prev, enabled: true }))
      toast.success('已开启生成后自动下载（浏览器默认下载目录）')
      return
    }
    setSaveLocation((prev) => ({ ...prev, enabled }))
    toast.success(enabled ? '已开启生成后自动保存' : '已关闭生成后自动保存')
  }

  /** 写入所选文件夹并更新状态；失败会抛错由调用方处理 */
  const writeImageToFolder = async (imageUrl: string, prefix: string): Promise<string> => {
    const handle = saveDirHandleRef.current
    if (!handle) throw new Error('尚未选择保存文件夹')
    let permission = await querySaveFolderPermission(handle)
    if (permission === 'prompt') {
      const granted = await requestSaveFolderPermission(handle)
      permission = granted ? 'granted' : 'prompt'
    }
    if (permission !== 'granted') {
      setSaveLocation((prev) => ({ ...prev, permission }))
      throw new Error('保存文件夹未授权：请点击「重新授权」')
    }
    const { fileName } = await saveImageUrlToFolder(handle, imageUrl, prefix)
    setSaveLocation((prev) => ({
      ...prev,
      permission: 'granted',
      lastSavedName: fileName,
      lastSavedAt: Date.now(),
      lastError: '',
    }))
    return fileName
  }

  /** 生成成功后自动保存（不阻塞生图流程，错误只记录在保存位置条上） */
  const autoSaveGeneratedImage = async (imageUrl: string, prefix: string) => {
    if (!saveLocationRef.current.enabled || !imageUrl) return
    try {
      if (!saveDirHandleRef.current) {
        if (!isSaveFolderSupported()) {
          const fileName = await downloadGeneratedImage(imageUrl, prefix)
          setSaveLocation((prev) => ({ ...prev, lastSavedName: fileName, lastSavedAt: Date.now(), lastError: '' }))
        }
        return
      }
      await writeImageToFolder(imageUrl, prefix)
    } catch (error) {
      const message = error instanceof Error ? error.message : '自动保存失败'
      setSaveLocation((prev) => ({ ...prev, lastError: message }))
      if (!autoGenGeneratingRef.current) toast.error(`自动保存失败：${message}`)
    }
  }

  /** 手动把当前预览结果保存到所选文件夹 */
  const saveCurrentImage = async () => {
    if (!previewUrl) return
    try {
      if (!saveDirHandleRef.current) {
        await chooseSaveFolder()
        if (!saveDirHandleRef.current) return
      }
      const fileName = await writeImageToFolder(previewUrl, 'manual')
      toast.success(`已保存到文件夹：${fileName}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  const startGeneration = async (
    overridePrompt?: string,
    overrides?: GenerationOverrides
  ): Promise<{
    ok: boolean
    imageUrl?: string
    busy?: boolean
    rejected?: boolean
    rejectReasons?: string[]
  }> => {
    if (isGeneratingRef.current) return { ok: false, busy: true }
    const recipeSnapshot = overrides?.recipe ?? recipe
    const configSnapshot = overrides?.config ?? apiConfig
    const pCfg = configSnapshot.providers[configSnapshot.activeProvider]
    const modelName = configSnapshot.activeProvider === 'comfyui'
      ? 'ComfyUI 工作流'
      : pCfg.model === 'custom' ? pCfg.customModel || 'custom' : pCfg.model
    const finalPrompt =
      overridePrompt ?? customPrompt ?? buildRecipePrompt(recipeSnapshot, configSnapshot.stylePreset, configSnapshot.activeProvider === 'comfyui' && recipeSnapshot.workflowImagesIdentity === workflowIdentity(configSnapshot.comfyuiParams.workflowJson) ? Object.values(recipeSnapshot.workflowImages || {}) : [])

    isGeneratingRef.current = true
    setIsGenerating(true)
    setGeneratingModel(modelName)
    setGenerationError('')
    setGenerationProgress(null)
    lastGenerationErrorRef.current = ''

    try {
      const { imageUrl, modelUsed, providerUsed } = await generateCharacterImage({
        recipe: recipeSnapshot,
        prompt: finalPrompt,
        config: configSnapshot,
        onProgress: setGenerationProgress,
      })

      // 质量检测：定时任务不达标直接丢弃重抽；手动生成仅提醒、结果仍保留
      const isAutoGeneration = autoGenGeneratingRef.current > 0
      const quality = await checkImageQuality(imageUrl).catch(() => null)
      if (quality && !quality.ok) {
        const reasons = formatQualityReasons(quality)
        if (isAutoGeneration && autoGenConfigRef.current.qualityFilter) {
          lastGenerationErrorRef.current = `质量过滤：${reasons}`
          return { ok: false, rejected: true, rejectReasons: quality.reasons }
        }
        if (!isAutoGeneration) {
          toast.warning(`质量检测提醒：${reasons}（结果已保留，可自行判断是否使用）`, { duration: 8000 })
        }
      }

      setPreviewUrl(imageUrl)
      const extraCount = (recipeSnapshot.extraImages || []).length
      const summary = [
        recipeSnapshot.portrait?.发型名称,
        recipeSnapshot.costume?.source === 'upload' ? recipeSnapshot.costume.服装名称 : recipeSnapshot.costume?.分类,
        recipeSnapshot.pose ? `${recipeSnapshot.pose.姿势名称}${recipeSnapshot.pose.角度 ? `(${recipeSnapshot.pose.角度})` : ''}` : null,
        extraCount ? `+${extraCount}附图` : null,
        ...(configSnapshot.activeProvider === 'comfyui' && recipeSnapshot.workflowImagesIdentity === workflowIdentity(configSnapshot.comfyuiParams.workflowJson)
          ? Object.values(recipeSnapshot.workflowImages || {}).filter((image) => image?.url).map((image) => image.role === 'character_sheet' ? '角色设定集' : image.name)
          : []),
      ]
        .filter(Boolean)
        .join(' + ')
      addHistory({
        provider: providerUsed,
        model: modelUsed,
        prompt: finalPrompt,
        imageUrl,
        recipeSummary: summary || '自定义合成',
      })
      // 自动出图时不在每张成功时弹 toast（面板里有统计），避免刷屏
      if (!autoGenGeneratingRef.current) toast.success(`角色图生成完成 (${modelUsed})`)
      // 若已选择保存位置并开启自动保存，异步写入本地文件夹（不阻塞结果展示）
      void autoSaveGeneratedImage(imageUrl, autoGenGeneratingRef.current ? 'auto' : 'gen')
      return { ok: true, imageUrl }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '调用失败'
      // 浏览器 fetch 中止抛出的是 DOMException（不是 Error 子类），必须按 name 判断；
      // generateCharacterImage 的 wrapper 已把被 abort 的错误统一成 name='AbortError'
      const aborted = (e as { name?: string } | null)?.name === 'AbortError' || isActiveGenerationAborted()
      lastGenerationErrorRef.current = aborted ? '' : msg
      setGenerationError(aborted ? '' : msg)
      // 自动出图的失败 toast 由定时任务面板统一提示，避免重复弹窗
      if (!aborted && !autoGenGeneratingRef.current) toast.error(msg.split('\n')[0])
      return { ok: false }
    } finally {
      isGeneratingRef.current = false
      setIsGenerating(false)
      setGenerationProgress(null)
    }
  }

  // ==========================================================================
  // 定时任务：自动随机出图（开始 / 随时停止）
  // ==========================================================================
  const clearAutoGenTimer = () => {
    if (autoGenTimerRef.current !== null) {
      window.clearTimeout(autoGenTimerRef.current)
      autoGenTimerRef.current = null
    }
  }

  const stopAutoGen = (message?: string) => {
    const wasEnabled = autoGenEnabledRef.current
    autoGenEnabledRef.current = false
    autoGenSessionRef.current += 1
    clearAutoGenTimer()
    // 立即中断正在进行的自动生成（不会影响用户手动发起的生成）
    if (autoGenGeneratingRef.current) {
      abortActiveGeneration()
      autoGenGeneratingRef.current = 0
    }
    setAutoGenStatus((prev) => ({ ...prev, enabled: false, stopping: false, generating: false, nextRunAt: null }))
    // 防御：直接作为 onClick 传入时 React 会把事件对象当第一个参数
    if (wasEnabled) toast.success(typeof message === 'string' && message ? message : '定时任务已停止')
  }

  function scheduleAutoGenNext(session: number, delayMs: number) {
    if (!autoGenEnabledRef.current || session !== autoGenSessionRef.current) return
    clearAutoGenTimer()
    const safeDelay = Math.max(200, delayMs)
    setAutoGenStatus((prev) => ({ ...prev, nextRunAt: Date.now() + safeDelay }))
    autoGenTimerRef.current = window.setTimeout(() => {
      autoGenTimerRef.current = null
      void runAutoGenCycle(session)
    }, safeDelay)
  }

  async function runAutoGenCycle(session: number) {
    const active = () => autoGenEnabledRef.current && session === autoGenSessionRef.current
    if (!active()) return
    setAutoGenStatus((prev) => ({ ...prev, nextRunAt: null }))

    // 用户手动生成进行中：不抢占，稍后再试
    if (isGeneratingRef.current) {
      scheduleAutoGenNext(session, 3000)
      return
    }

    let engaged = false
    let token = 0
    let success = false
    let busy = false
    let rejected = false
    let rejectReasons: string[] = []
    let errorText = ''
    let generatedImageUrl = ''

    try {
      let cfg = autoGenConfigRef.current
      let snapshot = recipeStateRef.current
      let pools: { portraits: PortraitItem[]; costumes: CostumeItem[]; poses: PoseItem[] } | null = null

      if (cfg.randomizeRecipe) {
        const [posesRes, costumes, portraits] = await Promise.all([
          qc.ensureQueryData(posesQuery),
          qc.ensureQueryData(costumesQuery),
          qc.ensureQueryData(portraitsQuery),
        ])
        // await 期间可能被停止 / 配置被修改：先检查再重读最新状态，避免旧快照覆盖用户操作
        if (!active()) return
        cfg = autoGenConfigRef.current
        snapshot = recipeStateRef.current
        pools = { portraits, costumes, poses: posesRes.items }
      }

      let nextRecipe = snapshot.recipe
      let nextConfig = snapshot.apiConfig

      if (cfg.randomizeRecipe && pools) {
        nextRecipe = pickRandomRecipe(
          nextRecipe,
          pools,
          effectiveAdultMode(snapshot.safeMode, snapshot.adultGenMode),
          snapshot.poseDepthMode,
          snapshot.randomCostumeVersion
        )
      }

      if (cfg.randomizeStyle) {
        const styleKeys = Object.keys(STYLE_PRESETS).filter((key) => key !== 'none')
        if (styleKeys.length) {
          nextConfig = { ...nextConfig, stylePreset: styleKeys[Math.floor(Math.random() * styleKeys.length)] }
        }
      }

      // 用户手动生成恰好开始：本轮让路，不计数
      if (isGeneratingRef.current) {
        scheduleAutoGenNext(session, 3000)
        return
      }

      // 应用到界面，用户可以看到自动切换的配方与画风
      setRecipe(nextRecipe)
      setApiConfig(nextConfig)

      const workflowImages =
        nextConfig.activeProvider === 'comfyui' &&
        nextRecipe.workflowImagesIdentity === workflowIdentity(nextConfig.comfyuiParams.workflowJson)
          ? Object.values(nextRecipe.workflowImages || {})
          : []
      const prompt = buildRecipePrompt(nextRecipe, nextConfig.stylePreset, workflowImages)

      engaged = true
      token = autoGenGeneratingRef.current + 1
      autoGenGeneratingRef.current = token
      setAutoGenStatus((prev) => ({ ...prev, generating: true }))
      const result = await startGeneration(prompt, { recipe: nextRecipe, config: nextConfig })
      if (result.busy) {
        busy = true
      } else if (result.rejected) {
        rejected = true
        rejectReasons = result.rejectReasons || []
      } else {
        success = result.ok
        generatedImageUrl = result.imageUrl || ''
        if (!success) errorText = lastGenerationErrorRef.current || '生成失败'
      }
    } catch (error) {
      errorText = error instanceof Error ? error.message : '自动生成失败'
    } finally {
      // 只有本次 cycle 仍是 token 持有者时才清理，避免旧 cycle 清掉新 cycle 的“自动生成中”标志
      if (engaged && autoGenGeneratingRef.current === token) {
        autoGenGeneratingRef.current = 0
        setAutoGenStatus((prev) => ({ ...prev, generating: false }))
      }
    }

    // 已被停止 / 中断：不统计、不排期
    if (!active()) return
    if (busy) {
      scheduleAutoGenNext(session, 3000)
      return
    }
    // 质量检测未通过：直接丢弃（不写入历史 / 不落盘 / 不占预览），立即重抽
    if (rejected) {
      const previous = autoGenStatusRef.current
      const consecutiveDiscards = previous.consecutiveDiscards + 1
      const reasonText = rejectReasons.join('、') || '质量检测未通过'
      setAutoGenStatus({
        ...previous,
        enabled: true,
        stopping: false,
        discardedCount: previous.discardedCount + 1,
        consecutiveDiscards,
        lastRejectReason: reasonText,
        lastError: '',
        lastFinishedAt: Date.now(),
        nextRunAt: null,
      })
      if (autoGenConfigRef.current.qualityFilter && consecutiveDiscards >= 5) {
        stopAutoGen(`连续 ${consecutiveDiscards} 张质量检测未通过（${reasonText}），定时任务已自动停止`)
        return
      }
      scheduleAutoGenNext(session, 1200)
      return
    }

    const latestCfg = autoGenConfigRef.current
    const previous = autoGenStatusRef.current
    if (success) {
      const successCount = previous.successCount + 1
      setAutoGenStatus({
        ...previous,
        enabled: true,
        stopping: false,
        successCount,
        consecutiveFailures: 0,
        consecutiveDiscards: 0,
        lastRejectReason: '',
        lastError: '',
        lastImageUrl: generatedImageUrl || previous.lastImageUrl,
        lastFinishedAt: Date.now(),
        nextRunAt: null,
      })
      if (latestCfg.maxImages > 0 && successCount >= latestCfg.maxImages) {
        stopAutoGen(`定时任务已完成 ${latestCfg.maxImages} 张，已自动停止`)
        return
      }
    } else {
      const consecutiveFailures = previous.consecutiveFailures + 1
      setAutoGenStatus({
        ...previous,
        enabled: true,
        failureCount: previous.failureCount + 1,
        consecutiveFailures,
        consecutiveDiscards: 0,
        lastError: errorText || '生成失败',
        lastFinishedAt: Date.now(),
        nextRunAt: null,
      })
      toast.error(`自动生成失败：${errorText.split('\n')[0] || '未知错误'}`)
      if (latestCfg.stopOnFailure && consecutiveFailures >= 3) {
        stopAutoGen(`连续 ${consecutiveFailures} 次生成失败，定时任务已自动停止`)
        return
      }
    }

    scheduleAutoGenNext(session, randomBetween(latestCfg.minIntervalSec, latestCfg.maxIntervalSec) * 1000)
  }

  const startAutoGen = () => {
    if (autoGenEnabledRef.current) return
    const cfg = autoGenConfigRef.current
    const snapshot = recipeStateRef.current
    const provider = snapshot.apiConfig.activeProvider
    const hasReference = Boolean(
      snapshot.recipe.portrait ||
        snapshot.recipe.costume ||
        snapshot.recipe.pose ||
        (snapshot.recipe.extraImages || []).length > 0
    )
    if (!cfg.randomizeRecipe && !hasReference) {
      toast.error('当前没有参考图：请先选择参考图，或开启「随机配方」')
      return
    }
    if (provider !== 'comfyui' && !snapshot.apiConfig.providers[provider].apiKey.trim()) {
      toast.error(`请先在「API 接口配置」中填写 ${PROVIDER_META[provider].name} 的 API Key`)
      return
    }
    autoGenEnabledRef.current = true
    autoGenSessionRef.current += 1
    setAutoGenStatus({ ...EMPTY_AUTOGEN_STATUS, enabled: true })
    toast.success(
      cfg.randomizeRecipe ? '定时任务已启动：将持续随机抽取配方自动出图' : '定时任务已启动：将按当前配方自动出图'
    )
    scheduleAutoGenNext(autoGenSessionRef.current, 1200)
  }

  const updateAutoGenConfig = (patch: Partial<AutoGenConfig>) => {
    const next = normalizeAutoGenConfig(patch, autoGenConfigRef.current)
    autoGenConfigRef.current = next
    setAutoGenConfig(next)
    // 正在等待下一张时，按新间隔重新排期
    if (autoGenEnabledRef.current && autoGenTimerRef.current !== null) {
      scheduleAutoGenNext(autoGenSessionRef.current, randomBetween(next.minIntervalSec, next.maxIntervalSec) * 1000)
    }
  }

  return (
    <StudioContext.Provider
      value={{
        recipe,
        apiConfig,
        history,
        safeMode,
        toggleSafeMode,
        requestUnlockNsfw,
        adultGenMode,
        requestAdultGenMode,
        randomCostumeVersion,
        setRandomCostumeVersion,
        poseDepthMode,
        setPoseDepthMode,
        toggleRecipePoseDepth,
        customPrompt,
        setCustomPrompt,
        previewUrl,
        setPreviewUrl,
        isGenerating,
        generatingModel,
        generationProgress,
        generationError,
        startGeneration,
        refreshStitchPreview,
        autoGenConfig,
        updateAutoGenConfig,
        autoGenStatus,
        startAutoGen,
        stopAutoGen,
        saveLocation,
        chooseSaveFolder,
        authorizeSaveFolder,
        clearSaveFolder,
        toggleAutoSave,
        saveCurrentImage,
        setPortrait,
        setCostume,
        setPose,
        togglePortrait,
        toggleCostume,
        togglePose,
        addExtraImage,
        removeExtraImage,
        updateExtraImageName,
        setWorkflowImage,
        clearRecipe,
        randomizeRecipe,
        updateApiConfig,
        updateProviderConfig,
        updateGptParams,
        updateGeminiParams,
        updateQwenParams,
        updateDoubaoParams,
        updateComfyUiParams,
        addHistory,
        removeHistoryItem,
        clearHistory,
      }}
    >
      {children}

      <AlertDialog open={ageGateOpen} onOpenChange={setAgeGateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>🔞 年龄确认与免责声明（NSFW 18+）</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-left leading-relaxed">
              <span className="block">
                关闭「安全模式 (SFW)」后，图库将显示包含成人向艺术参考的敏感分类：
              </span>
              <span className="block rounded-lg bg-muted p-2.5 text-xs text-foreground">
                • <strong>动作姿势库</strong>：全身单人・性感系（399 张）、双人缠绵（275 张）
                <br />• <strong>服装穿搭库</strong>：内衣・睡衣（199 套）、性感穿搭（140 套）
                <br />• <strong>生图成人模式</strong>：确认后可在合成台把「随机配方 / 定时任务」设为
                <strong>混合</strong>或<strong>仅 18+</strong> 素材出图（可随时改回关闭）
              </span>
              <span className="block text-xs">
                <strong>免责声明</strong>：
                <br />1. <strong>年龄限制</strong>：未满 18 周岁的未成年人严禁关闭安全模式或浏览上述敏感分类。
                <br />2. <strong>来源说明</strong>：图鉴素材源自原作者 ギア（@giaaibusi）公开分享，仅供个人学习交流，严禁商业倒卖。
                <br />3. <strong>合法使用</strong>：本工具与素材<strong>仅供 AI 绘画学习与合法艺术创作使用，严禁用于任何违法违规、色情传播或侵害他人肖像权（如未经授权的真人换脸）等用途</strong>，使用者须自行承担一切法律责任。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                pendingUnlockCbRef.current = null
              }}
            >
              保持安全模式
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmUnlockNsfw}>
              我已年满 18 岁并同意免责声明
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StudioContext.Provider>
  )
}

// oxlint-disable-next-line react/only-export-components
export function useStudio() {
  const ctx = useContext(StudioContext)
  if (!ctx) throw new Error('useStudio must be used within StudioProvider')
  return ctx
}
