import type { ApiConfig, ImageProviderId, RecipeState } from '@/types/gallery'
import { applyWorkflowOverrides, getWorkflowImages, validateReferenceCombinations, workflowIdentity, type ComfyObjectInfo } from '@/lib/comfyWorkflowParameters'
import { poseImagePath } from '@/lib/recipeImages'
import qwen2509ThreeImageWorkflow from '@/workflows/qwen_image_edit_2509_3img.api.json'
import { getPromptProfile, type RecipePromptOptions } from './recipePrompt'

// 提示词构建逻辑已抽到独立的纯函数模块（便于 node 直接做快照/lint 回归测试）
export { STYLE_PRESETS, buildRecipePrompt } from './recipePrompt'
export type { RecipePromptOptions } from './recipePrompt'

export interface ProviderModelOption {
  value: string
  label: string
}

export const PROVIDER_META: Record<
  ImageProviderId,
  {
    id: ImageProviderId
    name: string
    shortName: string
    defaultBaseUrl: string
    docUrl: string
    models: ProviderModelOption[]
  }
> = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    shortName: 'Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    docUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
    models: [
      { value: 'gemini-3.1-flash-image-preview', label: 'gemini-3.1-flash-image-preview' },
      { value: 'gemini-3-pro-image-preview', label: 'gemini-3-pro-image-preview' },
      { value: 'gemini-2.5-flash-image', label: 'gemini-2.5-flash-image' },
      { value: 'gemini-2.5-flash-image-preview', label: 'gemini-2.5-flash-image-preview' },
      { value: 'custom', label: '自定义模型 ID' },
    ],
  },
  gpt: {
    id: 'gpt',
    name: 'OpenAI GPT Image',
    shortName: 'GPT',
    defaultBaseUrl: 'https://api.openai.com/v1',
    docUrl: 'https://platform.openai.com/docs/guides/image-generation',
    models: [
      { value: 'gpt-image-2.6', label: 'gpt-image-2.6（最新 · 更快）' },
      { value: 'gpt-image-2.5', label: 'gpt-image-2.5' },
      { value: 'gpt-image-2.5-sunburst', label: 'gpt-image-2.5-sunburst' },
      { value: 'gpt-image-2.5-flare', label: 'gpt-image-2.5-flare' },
      { value: 'gpt-image-2', label: 'gpt-image-2' },
      { value: 'gpt-image-1.5', label: 'gpt-image-1.5' },
      { value: 'gpt-image-1', label: 'gpt-image-1' },
      { value: 'custom', label: '自定义模型 ID' },
    ],
  },
  qwen: {
    id: 'qwen',
    name: '阿里云百炼 Qwen',
    shortName: 'Qwen',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    docUrl: 'https://help.aliyun.com/zh/model-studio/qwen-image-edit-api',
    models: [
      { value: 'qwen-image-3.0-pro', label: 'qwen-image-3.0-pro' },
      { value: 'qwen-image-2.1-pro', label: 'qwen-image-2.1-pro' },
      { value: 'qwen-image-2.1-turbo', label: 'qwen-image-2.1-turbo' },
      { value: 'qwen-image-2.0-pro', label: 'qwen-image-2.0-pro' },
      { value: 'qwen-image-edit-plus', label: 'qwen-image-edit-plus' },
      { value: 'custom', label: '自定义模型 ID' },
    ],
  },
  doubao: {
    id: 'doubao',
    name: '字节火山方舟 Doubao',
    shortName: 'Doubao',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
    docUrl: 'https://www.volcengine.com/docs/82379/1541523',
    models: [
      { value: 'doubao-seedream-5-0', label: 'doubao-seedream-5-0' },
      { value: 'doubao-seedream-5-0-lite', label: 'doubao-seedream-5-0-lite' },
      { value: 'doubao-seedream-4-5-251128', label: 'doubao-seedream-4-5-251128' },
      { value: 'doubao-seedream-4-0-250828', label: 'doubao-seedream-4-0-250828' },
      { value: 'doubao-seededit-3-0-i2i-250628', label: 'doubao-seededit-3-0-i2i-250628' },
      { value: 'custom', label: '自定义模型 ID / Endpoint' },
    ],
  },
  comfyui: {
    id: 'comfyui',
    name: '本地 ComfyUI',
    shortName: 'ComfyUI',
    // 本地开发时走 /comfy 同源代理（由 vite.config.ts 自动探测端口）；线上站点直连本机 ComfyUI（默认 8188）
    defaultBaseUrl: defaultComfyBaseUrl(),
    docUrl: 'https://docs.comfy.org/essentials/comfyui_server',
    models: [
      { value: 'qwen_image_edit_2509', label: 'qwen_image_edit_2509（由工作流决定）' },
      { value: 'custom', label: '自定义名称（仅用于记录显示）' },
    ],
  },
}

const ANATOMY_NEGATIVE =
  '畸形的手, 多余手指, 缺失手指, 手部融合, 多余手臂, 断肢, 多脚, 缺脚, 脚部融合, 断头, 颈部错位, 头部与身体分离, 肢体粘连, 关节扭曲, 身体比例失调, 画质模糊, 低分辨率, 文字, 水印'

/** 高质量模式：提高采样步数与 CFG，并启用解剖结构负面词（更慢，但复杂姿势下手/脚/颈部更稳） */
function applyComfyQualityBoost(workflow: ComfyWorkflow): void {
  for (const node of Object.values<any>(workflow)) {
    if (!node?.inputs) continue
    if (typeof node.class_type === 'string' && /KSampler/.test(node.class_type)) {
      if (typeof node.inputs.steps === 'number') node.inputs.steps = Math.max(node.inputs.steps, 36)
      if (typeof node.inputs.cfg === 'number') node.inputs.cfg = Math.max(node.inputs.cfg, 1.8)
    }
    if (typeof node.inputs.negative_prompt === 'string') node.inputs.negative_prompt = ANATOMY_NEGATIVE
  }
}

/** 灵活参考工作流中参考图的送入顺序：无人物头像时优先把姿势图作为构图底图（避免服装无头人台当底图导致成图无头） */
export function getFlexReferenceOrder(recipe: RecipeState): Array<'portrait' | 'costume' | 'pose'> {
  if (!recipe.portrait && recipe.pose) {
    return recipe.costume ? ['pose', 'costume'] : ['pose']
  }
  const order: Array<'portrait' | 'costume' | 'pose'> = []
  if (recipe.portrait) order.push('portrait')
  if (recipe.costume) order.push('costume')
  if (recipe.pose) order.push('pose')
  return order
}

export function getRecipePromptOptions(config: ApiConfig, recipe: RecipeState): RecipePromptOptions {
  const freeFace = !recipe.portrait
  const profile = getPromptProfile(config)
  if (config.activeProvider !== 'comfyui') return { freeFace, profile }
  const cp = config.comfyuiParams
  if (isComfyFlexibleLayout(config, recipe)) {
    // 灵活参考：实际送图顺序由 getFlexReferenceOrder 决定，提示词按该顺序生成 <imageN> 标签
    const order = getFlexReferenceOrder(recipe)
    return { freeFace, profile, imageOrder: order, poseFirst: order.length > 1 && order[0] === 'pose' }
  }
  // 本机/bf16 的 Qwen 2.1 双图模板：编码顺序是「图1=姿势、图2=人物/服装」
  const twoImagePoseFirst =
    (cp.workflowPreset === 'qwen21_local_2img' || cp.workflowPreset === 'qwen21_2img') && Boolean(recipe.pose)
  if (twoImagePoseFirst) {
    if (!recipe.portrait && recipe.costume) {
      return { costumeAsPerson: true, freeFace: true, poseFirst: true, profile, imageOrder: ['pose', 'costume'] }
    }
    if (recipe.portrait) {
      return { poseFirst: true, profile, imageOrder: ['pose', 'portrait'] }
    }
  }
  // 固定模板：三张参考图按节点 1/2/3（人像 / 服装 / 姿势）编码
  const imageOrder: Array<'portrait' | 'costume' | 'pose'> = []
  if (recipe.portrait) imageOrder.push('portrait')
  if (recipe.costume) imageOrder.push('costume')
  if (recipe.pose) imageOrder.push('pose')
  const options: RecipePromptOptions = { freeFace, profile, imageOrder }
  if (cp.costumeNodeId === 'none' && Boolean(cp.portraitNodeId && cp.portraitNodeId !== 'none')) {
    if (!recipe.portrait && recipe.costume) {
      options.costumeAsPerson = true
      options.freeFace = true
    } else if (recipe.portrait && recipe.costume) {
      options.ignoreCostume = true
    }
  }
  return options
}

/** 本机 Qwen 2.1 双图/三图模板仅在参考组合不匹配固定节点时才改用「灵活参考工作流」 */
export function isComfyFlexibleLayout(config: ApiConfig, recipe: RecipeState): boolean {
  if (config.activeProvider !== 'comfyui') return false
  const cp = config.comfyuiParams
  if (cp.workflowPreset !== 'qwen21_local_3img' && cp.workflowPreset !== 'qwen21_local_2img') return false
  const count = [recipe.portrait, recipe.costume, recipe.pose].filter(Boolean).length
  if (count === 0) return false
  if (cp.workflowPreset === 'qwen21_local_3img') return count < 3
  // 双图固定模板支持「人像+姿势」或「服装+姿势」；其余组合（0/1 张、人像+服装、三张全选）走灵活参考
  return count < 2 || count > 2 || (count === 2 && Boolean(recipe.portrait && recipe.costume))
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const maxSide = 1024
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.round(img.width * scale)
        c.height = Math.round(img.height * scale)
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/png'))
      }
      img.onerror = () => reject(new Error('解析图片失败'))
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    // 超时保护：避免远端参考图一直不返回时生成流程永久挂起（isGenerating 无法复位）
    const timer = window.setTimeout(() => reject(new Error(`加载参考图超时（20 秒）: ${src.slice(0, 120)}`)), 20000)
    img.onload = () => {
      window.clearTimeout(timer)
      resolve(img)
    }
    img.onerror = () => {
      window.clearTimeout(timer)
      reject(new Error(`加载图片失败: ${src}`))
    }
    if (src.startsWith('data:') || /^https?:\/\//i.test(src) || src.startsWith('/')) {
      img.src = src
    } else {
      img.src = `/${src}`
    }
  })
}

export async function stitchRecipeCanvas(recipe: RecipeState): Promise<string> {
  const list: Array<{ tag: string; sub: string; src: string }> = []
  let idx = 1

  if (recipe.portrait) {
    list.push({
      tag: `图${idx++} · 人像`,
      sub: recipe.portrait.标题,
      src: recipe.portrait.原图 || recipe.portrait.缩略图,
    })
  }
  if (recipe.costume) {
    list.push({
      tag: `图${idx++} · 服装`,
      sub: `${recipe.costume.分类} · ${recipe.costume.服装名称}`,
      src: recipe.costume.预览图 || recipe.costume.原图 || recipe.costume.缩略图,
    })
  }
  if (recipe.pose) {
    list.push({
      tag: `图${idx++} · 姿势`,
      sub: `${recipe.pose.姿势名称}（${recipe.pose.角度}${recipe.pose.useDepth ? ' · 深度图' : ''}）`,
      src: poseImagePath(recipe.pose),
    })
  }
  for (const extra of recipe.extraImages || []) {
    list.push({
      tag: `图${idx++} · 附加`,
      sub: extra.name || '自定义参考图',
      src: extra.url,
    })
  }

  if (!list.length) {
    throw new Error('请至少选择或上传 1 张参考图')
  }

  const imgs = await Promise.all(list.map((x) => loadImage(x.src)))
  const cardW = 480
  const cardH = 640
  const pad = 20
  const headH = 62
  const canvas = document.createElement('canvas')
  canvas.width = list.length * cardW + (list.length + 1) * pad
  canvas.height = cardH + headH + pad * 2
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#111318'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  imgs.forEach((img, i) => {
    const x = pad + i * (cardW + pad)
    const y = pad
    ctx.fillStyle = '#1e222b'
    ctx.fillRect(x, y, cardW, cardH + headH)
    ctx.fillStyle = '#f4f5f7'
    ctx.fillRect(x, y + headH, cardW, cardH)

    const scale = Math.min(cardW / img.width, cardH / img.height)
    const dw = img.width * scale
    const dh = img.height * scale
    ctx.drawImage(img, x + (cardW - dw) / 2, y + headH + (cardH - dh) / 2, dw, dh)

    ctx.fillStyle = '#a1a1aa'
    ctx.font = '600 12px Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    ctx.fillText(list[i].tag, x + 14, y + 23)

    ctx.fillStyle = '#ffffff'
    ctx.font = '700 15px Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    ctx.fillText(list[i].sub.slice(0, 26), x + 14, y + 46)
  })

  return canvas.toDataURL('image/jpeg', 0.92)
}

// 将本地相对路径自动解析为公网可访问的 HTTPS URL
// - 若当前站点已部署在公网 HTTPS 域名，优先使用当前站点 URL
// - 若在 localhost 本地开发，自动映射为三大图库对应的 Cloudflare Pages 公网源站 CDN URL
export function toPublicHttpsUrl(src: string): string {
  if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return src
  const clean = src.replace(/^\/+/, '')

  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    !['localhost', '127.0.0.1'].includes(window.location.hostname)
  ) {
    return `${window.location.origin}/${clean}`
  }

  // 本地开发态自动映射为源站 Cloudflare Pages 公网 HTTPS 地址，方便云端生图接口直接拉取
  if (clean.startsWith('img/portrait/')) {
    const filename = clean.slice('img/portrait/'.length).replace(/\.webp$/i, '.png')
    return `https://ai-portrait-gallery.pages.dev/img/${filename}`
  }
  if (clean.startsWith('thumbs/portrait/')) {
    return `https://ai-portrait-gallery.pages.dev/thumbs/${clean.slice('thumbs/portrait/'.length)}`
  }
  if (clean.startsWith('img/costume/') || clean.startsWith('thumbs/costume/')) {
    return `https://ai-costume-gallery.pages.dev/${clean}`
  }
  if (clean.startsWith('img/depth/')) {
    const filename = clean.slice('img/depth/'.length).replace(/\.webp$/i, '.png')
    return `https://ai-pose-depth-gallery.pages.dev/img/${filename}`
  }
  if (clean.startsWith('thumbs/depth/')) {
    const filename = clean.slice('thumbs/depth/'.length).replace(/\.webp$/i, '.jpg')
    return `https://ai-pose-depth-gallery.pages.dev/thumbs/${filename}`
  }
  return `https://ai-pose-gallery.pages.dev/${clean}`
}

async function srcToPngDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:image/')) return src
  throwIfAborted()
  const img = await loadImage(src)
  throwIfAborted()
  const maxSide = 1024
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale)
  c.height = Math.round(img.height * scale)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = head.match(/:(.*?);/)?.[1] || 'image/png'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// ============================================================================
// 可中断生成：定时任务「立即停止」/ 手动中断共用同一个 AbortController
// - 云端协议：signal 直接透传给 fetch，请求立刻中断
// - 本地 ComfyUI：轮询循环每 1.5s 检查一次，中断后调用 /interrupt 取消队列任务
// ============================================================================
let activeGenerationController: AbortController | null = null

/** 中断当前正在进行的生图请求（若没有正在进行的生成则无副作用） */
export function abortActiveGeneration(): void {
  activeGenerationController?.abort()
}

/** 当前生成是否已被手动中断 */
export function isActiveGenerationAborted(): boolean {
  return Boolean(activeGenerationController?.signal.aborted)
}

/** 已被中断时抛出 name 为 AbortError 的错误，供上层统一识别「主动停止」 */
function throwIfAborted(): void {
  if (!isActiveGenerationAborted()) return
  const error = new Error('已手动停止当前生成')
  error.name = 'AbortError'
  throw error
}

async function smartFetch(
  targetUrl: string,
  init: RequestInit,
  useProxy: boolean
): Promise<Response> {
  const signal = init.signal ?? activeGenerationController?.signal
  if (!useProxy) {
    return fetch(targetUrl, { ...init, signal })
  }
  const headers = new Headers(init.headers)
  headers.set('x-target-url', targetUrl)
  return fetch('/api/proxy', {
    method: init.method || 'POST',
    headers,
    body: init.body,
    signal,
  })
}

/** 根据 Base64 头部识别图片格式，避免把 GIF / WebP 动图硬编码成 PNG 导致无法预览 */
function base64ImageDataUrl(b64: string): string {
  const head = String(b64 || '').slice(0, 32)
  let mime = 'image/png'
  if (head.startsWith('R0lGOD')) mime = 'image/gif'
  else if (head.startsWith('/9j/')) mime = 'image/jpeg'
  else if (head.startsWith('UklGR')) mime = 'image/webp'
  return `data:${mime};base64,${b64}`
}

function extractUniversalImage(json: any): string | null {
  // 1. OpenAI / Doubao Seedream standard: data[0].b64_json or data[0].url
  if (json?.data?.[0]?.b64_json) return base64ImageDataUrl(json.data[0].b64_json)
  if (json?.data?.[0]?.url) return json.data[0].url

  // 2. OpenAI Responses API output[].result
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (item?.type === 'image_generation_call' && item?.result) {
        return base64ImageDataUrl(item.result)
      }
    }
  }

  // 3. Alibaba DashScope Qwen-Image: output.choices[0].message.content[].image or output.results[0].url
  const dashContent = json?.output?.choices?.[0]?.message?.content
  if (Array.isArray(dashContent)) {
    for (const part of dashContent) {
      if (part?.image) return part.image
    }
  }
  if (json?.output?.results?.[0]?.url) return json.output.results[0].url

  // 4. Google Gemini generateContent: candidates[0].content.parts[].inlineData
  const parts = json?.candidates?.[0]?.content?.parts || []
  for (const p of parts) {
    if (p.inlineData?.data) return `data:${p.inlineData.mimeType || 'image/png'};base64,${p.inlineData.data}`
    if (p.inline_data?.data) return `data:${p.inline_data.mime_type || 'image/png'};base64,${p.inline_data.data}`
  }

  // 5. OpenAI Chat Completions multimodal / markdown image
  const msg = json?.choices?.[0]?.message
  if (Array.isArray(msg?.images) && msg.images[0]?.image_url?.url) return msg.images[0].image_url.url
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content) {
      if (part.type === 'image_url' && part.image_url?.url) return part.image_url.url
      if (part.inlineData?.data) return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`
    }
  }
  const text = typeof msg?.content === 'string' ? msg.content : ''
  const mdMatch = text.match(/!\[.*?\]\((data:image\/[^)]+|https?:\/\/[^\s)]+)\)/)
  if (mdMatch) return mdMatch[1]
  const urlMatch = text.match(/(https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp)[^\s"'<>]*)/i)
  if (urlMatch) return urlMatch[1]

  return null
}

// ============================================================================
// 本地 ComfyUI API 工作流模板与节点解析工具
// ============================================================================

type ComfyNode = { class_type: string; inputs: Record<string, any>; _meta?: { title?: string; studio?: { imageRole?: string } } }
type ComfyWorkflow = Record<string, ComfyNode>

export type ComfyPresetId =
  | 'qwen2509_3img'
  | 'qwen2509_2img'
  | 'qwen21_3img'
  | 'qwen21_2img'
  | 'qwen21_local_3img'
  | 'qwen21_local_2img'

export interface ComfyNodeMappings {
  promptNodeId: string
  portraitNodeId: string
  costumeNodeId: string
  poseNodeId: string
  stitchedNodeId: string
}

/** 本地开发 / 本地预览时使用的同源代理前缀（见 vite.config.ts），可绕开 ComfyUI 的 CORS 白名单限制 */
export const COMFY_DEV_PROXY = '/comfy'

export function isLocalDevHost(): boolean {
  return (
    typeof window !== 'undefined' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  )
}

/** 本机 ComfyUI 常见端口：便携版 / 源码版默认 8188，Desktop 旧版默认 8000，另兼容 8088 / 8189 / 8080 */
export const LOCAL_COMFY_PORTS = [8188, 8000, 8088, 8189, 8080] as const
export const DEFAULT_COMFY_LOCAL_URL = 'http://127.0.0.1:8188'

// 注意：PROVIDER_META 在模块初始化时就会调用本函数，这里不能引用后面定义的 const
export function defaultComfyBaseUrl(): string {
  return isLocalDevHost() ? '/comfy' : DEFAULT_COMFY_LOCAL_URL
}

export function comfyCandidateUrls(current = ''): string[] {
  const list = [
    current.trim(),
    isLocalDevHost() ? defaultComfyBaseUrl() : '',
    ...LOCAL_COMFY_PORTS.map((port) => `http://127.0.0.1:${port}`),
  ]
    .map((x) => x.replace(/\/+$/, ''))
    .filter(Boolean)
  return Array.from(new Set(list))
}

function cloneWorkflow<T>(wf: T): T {
  return JSON.parse(JSON.stringify(wf))
}

// 双图版：图1 = 人物（含服装），图2 = 姿势（姿势图只送入视觉语言编码器，不作为像素参考）
function buildQwen2509TwoImage(): ComfyWorkflow {
  const wf = cloneWorkflow(qwen2509ThreeImageWorkflow) as ComfyWorkflow
  for (const id of ['2', '22', '23', '25', '27']) delete wf[id]
  wf['1']._meta = { title: '图1：人物/服装参考 (Person)' }
  wf['3']._meta = { title: '图2：姿势参考 (Pose)' }
  for (const id of ['12', '13']) {
    wf[id].inputs.image2 = ['3', 0]
    delete wf[id].inputs.image3
  }
  wf['14'].inputs.positive = ['24', 0]
  wf['14'].inputs.negative = ['26', 0]
  return wf
}

// 旧版 Qwen-Image 2.1 预设（需要另行安装 2.1 模型；默认已改用本机可用的 Edit 2509）
function buildQwen21Workflow(threeImages: boolean): ComfyWorkflow {
  const wf: ComfyWorkflow = {
    '1': {
      inputs: { image: 'portrait_ref.png' },
      class_type: 'LoadImage',
      _meta: { title: threeImages ? '图1：人像参考 (Portrait)' : '图2：人物/服装参考图 (Person)' },
    },
    '4': {
      inputs: { unet_name: 'image2image/qwen_image_2.1_bf16.safetensors', weight_dtype: 'default' },
      class_type: 'UNETLoader',
      _meta: { title: '加载 Qwen Image 2.1 基础模型' },
    },
    '5': {
      inputs: {
        model: ['4', 0],
        lora_name: 'qwen2.1/动作编辑VNCCS_QI2_PoseStudioV2_3294845.safetensors',
        strength_model: 1.0,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: '加载姿态编辑 LoRA 适配器 (Qwen 2.1 专用)' },
    },
    '6': {
      inputs: { device: 'auto', dtype: 'default', model: ['5', 0] },
      class_type: 'QwenImage21Cache',
      _meta: { title: 'Qwen Image 2.1 条件缓存' },
    },
    '7': {
      inputs: { clip_name: 'text_encoders/qwen3vl_8b_bf16.safetensors', type: 'qwen_image', device: 'default' },
      class_type: 'CLIPLoader',
      _meta: { title: '加载 Qwen3-VL 8B 编码器' },
    },
    '8': {
      inputs: { vae_name: 'vae/qwen_image_2.1_vae_bf16.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: '加载 Qwen Image 2.1 VAE' },
    },
    '9': {
      inputs: {
        prompt: '',
        negative_prompt: '',
        resolution: 1024,
        clip: ['7', 0],
        vae: ['8', 0],
      },
      class_type: 'TextEncodeQwenImage21',
      _meta: { title: '正向提示词与多图编码 (Qwen 2.1)' },
    },
    '10': {
      inputs: {
        seed: 20261031,
        steps: 25,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1.0,
        model: ['6', 0],
        positive: ['9', 0],
        negative: ['9', 1],
        latent_image: ['9', 2],
      },
      class_type: 'KSampler',
      _meta: { title: 'KSampler 采样器' },
    },
    '11': {
      inputs: { samples: ['10', 0], vae: ['8', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'VAE 解码' },
    },
    '12': {
      inputs: { filename_prefix: 'pose_studio/result', images: ['11', 0] },
      class_type: 'SaveImage',
      _meta: { title: '保存生成结果' },
    },
  }
  if (threeImages) {
    wf['2'] = { inputs: { image: 'costume_ref.png' }, class_type: 'LoadImage', _meta: { title: '图2：服装参考 (Costume)' } }
    wf['3'] = { inputs: { image: 'pose_ref.png' }, class_type: 'LoadImage', _meta: { title: '图3：姿势参考 (Pose)' } }
    Object.assign(wf['9'].inputs, { 'images.image_1': ['1', 0], 'images.image_2': ['2', 0], 'images.image_3': ['3', 0] })
  } else {
    wf['2'] = { inputs: { image: 'pose_reference.png' }, class_type: 'LoadImage', _meta: { title: '图1：姿势参考图 (Pose)' } }
    Object.assign(wf['9'].inputs, { 'images.image_1': ['2', 0], 'images.image_2': ['1', 0] })
  }
  return wf
}

// 本机版 Qwen-Image 2.1：使用本机已安装的 int8 量化模型，且不依赖姿态编辑 LoRA
// （官方 2.1 工作流另有一套 bf16 模型与「动作编辑」LoRA，文件不存在时无法生成）
const LOCAL_QWEN21_MODELS = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_bf16.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
} as const

function buildQwen21LocalWorkflow(threeImages: boolean): ComfyWorkflow {
  const wf = buildQwen21Workflow(threeImages)
  // 去掉本机没有的姿态编辑 LoRA，模型直连条件缓存节点
  delete wf['5']
  wf['6'].inputs.model = ['4', 0]
  // KV cache 用 int8 存储：12GB 显存下省显存且实测每张 79s → 60s（精度约等于 bf16）
  wf['6'].inputs.dtype = 'int8'
  wf['4'] = {
    inputs: { unet_name: LOCAL_QWEN21_MODELS.unet, weight_dtype: 'default' },
    class_type: 'UNETLoader',
    _meta: { title: '加载 Qwen Image 2.1 模型（本机 int8）' },
  }
  wf['7'].inputs = { clip_name: LOCAL_QWEN21_MODELS.clip, type: 'qwen_image', device: 'default' }
  wf['8'].inputs = { vae_name: LOCAL_QWEN21_MODELS.vae }

  // 出图尺寸跟随「姿势参考图」的比例（与 2509 模板一致）：
  // TextEncodeQwenImage21 自带的 latent 取的是第一张参考图（人像 4:5）的尺寸，
  // 会让成图构图/画幅跟着人像图跑；这里改为用姿势图缩放后的画布作为 latent，
  // 输出约 1.69 MP，3:4 姿势图即 1152×1536，全身姿势不会被裁脚。
  const poseNodeId = threeImages ? '3' : '2'
  wf['13'] = {
    inputs: { image: [poseNodeId, 0], upscale_method: 'lanczos', megapixels: 1.6875, resolution_steps: 32 },
    class_type: 'ImageScaleToTotalPixels',
    _meta: { title: '按姿势图比例确定输出尺寸 (megapixels ≈ 1152×1536)' },
  }
  wf['14'] = {
    inputs: { pixels: ['13', 0], vae: ['8', 0] },
    class_type: 'VAEEncode',
    _meta: { title: '输出画布 Latent' },
  }
  wf['10'].inputs.latent_image = ['14', 0]
  return wf
}

export interface FlexReference {
  role: 'portrait' | 'costume' | 'pose'
  /** 上传后的 ComfyUI input 文件名（生成前为占位名，仅用于结构预检） */
  name: string
}

/**
 * 灵活参考工作流：把「人像 / 服装 / 姿势」中被选中的 1~3 张图按顺序接入 Qwen 2.1 编码器，
 * 输出画布比例优先跟随姿势图（没有姿势则跟随人像 / 服装），用于任意参考组合出图。
 */
export function buildFlexQwen21LocalWorkflow(refs: FlexReference[]): ComfyWorkflow {
  if (refs.length === 0) throw new Error('灵活参考工作流至少需要 1 张参考图')
  const roleLabel = (role: FlexReference['role']) => (role === 'portrait' ? '人像' : role === 'costume' ? '服装' : '姿势')
  const wf: ComfyWorkflow = {}
  refs.forEach((ref, index) => {
    wf[String(index + 1)] = {
      inputs: { image: ref.name },
      class_type: 'LoadImage',
      _meta: { title: `图${index + 1}：${roleLabel(ref.role)}参考` },
    }
  })
  wf['4'] = {
    inputs: { unet_name: LOCAL_QWEN21_MODELS.unet, weight_dtype: 'default' },
    class_type: 'UNETLoader',
    _meta: { title: '加载 Qwen Image 2.1 模型（本机 int8）' },
  }
  wf['6'] = { inputs: { device: 'auto', dtype: 'int8', model: ['4', 0] }, class_type: 'QwenImage21Cache' }
  wf['7'] = { inputs: { clip_name: LOCAL_QWEN21_MODELS.clip, type: 'qwen_image', device: 'default' }, class_type: 'CLIPLoader' }
  wf['8'] = { inputs: { vae_name: LOCAL_QWEN21_MODELS.vae }, class_type: 'VAELoader' }
  wf['9'] = {
    inputs: {
      prompt: '',
      negative_prompt: '',
      resolution: 1024,
      clip: ['7', 0],
      vae: ['8', 0],
      ...Object.fromEntries(refs.map((_, index) => [`images.image_${index + 1}`, [String(index + 1), 0]])),
    },
    class_type: 'TextEncodeQwenImage21',
    _meta: { title: '提示词与多图参考编码 (Qwen 2.1 · 灵活参考)' },
  }
  // 画布比例优先跟随姿势图；没有姿势时依次用 人像 / 服装 的比例
  const poseIndex = refs.findIndex((ref) => ref.role === 'pose')
  const portraitIndex = refs.findIndex((ref) => ref.role === 'portrait')
  const costumeIndex = refs.findIndex((ref) => ref.role === 'costume')
  const latentIndex = poseIndex >= 0 ? poseIndex : portraitIndex >= 0 ? portraitIndex : costumeIndex
  wf['13'] = {
    inputs: { image: [String(latentIndex + 1), 0], upscale_method: 'lanczos', megapixels: 1.6875, resolution_steps: 32 },
    class_type: 'ImageScaleToTotalPixels',
    _meta: { title: '按参考图比例确定输出尺寸 (megapixels ≈ 1152×1536)' },
  }
  wf['14'] = { inputs: { pixels: ['13', 0], vae: ['8', 0] }, class_type: 'VAEEncode' }
  wf['10'] = {
    inputs: {
      seed: 0,
      steps: 25,
      cfg: 1.0,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1.0,
      model: ['6', 0],
      positive: ['9', 0],
      negative: ['9', 1],
      latent_image: ['14', 0],
    },
    class_type: 'KSampler',
  }
  wf['15'] = { inputs: { samples: ['10', 0], vae: ['8', 0] }, class_type: 'VAEDecode' }
  wf['16'] = { inputs: { filename_prefix: 'pose_studio/result', images: ['15', 0] }, class_type: 'SaveImage' }
  return wf
}

export const DEFAULT_COMFY_PRESET: ComfyPresetId = 'qwen21_local_3img'

export const COMFYUI_WORKFLOW_TEMPLATES: Record<
  ComfyPresetId,
  { label: string; workflow: ComfyWorkflow; defaults: ComfyNodeMappings }
> = {
  qwen21_local_3img: {
    label: 'Qwen Image 2.1 灵活参考（本机 int8 模型）· 推荐',
    workflow: buildQwen21LocalWorkflow(true),
    defaults: { promptNodeId: '9', portraitNodeId: '1', costumeNodeId: '2', poseNodeId: '3', stitchedNodeId: 'none' },
  },
  qwen21_local_2img: {
    label: 'Qwen Image 2.1 灵活参考（本机 int8 模型·双图兼容）',
    workflow: buildQwen21LocalWorkflow(false),
    defaults: { promptNodeId: '9', portraitNodeId: '1', costumeNodeId: 'none', poseNodeId: '2', stitchedNodeId: 'none' },
  },
  qwen2509_3img: {
    label: 'Qwen Image Edit 2509 三图合成（人像+服装+姿势）',
    workflow: qwen2509ThreeImageWorkflow as ComfyWorkflow,
    defaults: { promptNodeId: '12', portraitNodeId: '1', costumeNodeId: '2', poseNodeId: '3', stitchedNodeId: 'none' },
  },
  qwen2509_2img: {
    label: 'Qwen Image Edit 2509 双图姿态迁移（人物+姿势）',
    workflow: buildQwen2509TwoImage(),
    defaults: { promptNodeId: '12', portraitNodeId: '1', costumeNodeId: 'none', poseNodeId: '3', stitchedNodeId: 'none' },
  },
  qwen21_3img: {
    label: 'Qwen-Image 2.1 三图合成（需另装 2.1 模型）',
    workflow: buildQwen21Workflow(true),
    defaults: { promptNodeId: '9', portraitNodeId: '1', costumeNodeId: '2', poseNodeId: '3', stitchedNodeId: 'none' },
  },
  qwen21_2img: {
    label: 'Qwen-Image 2.1 双图姿态迁移（需另装 2.1 模型）',
    workflow: buildQwen21Workflow(false),
    defaults: { promptNodeId: '9', portraitNodeId: '1', costumeNodeId: 'none', poseNodeId: '2', stitchedNodeId: 'none' },
  },
}

export interface ComfyParsedNodes {
  valid: boolean
  isUiFormat: boolean
  error?: string
  imageNodes: Array<{ id: string; title: string; classType: string; currentImage: string; emptyValue?: string; role?: 'character_sheet' }>
  promptNodes: Array<{ id: string; title: string; classType: string; field: string }>
}

export function parseComfyWorkflowNodes(workflowJson: string): ComfyParsedNodes {
  if (!workflowJson.trim()) {
    return { valid: false, isUiFormat: false, error: '工作流 JSON 为空', imageNodes: [], promptNodes: [] }
  }
  try {
    const parsed = JSON.parse(workflowJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { valid: false, isUiFormat: false, error: '无效的 JSON 对象', imageNodes: [], promptNodes: [] }
    }
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.links)) {
      return {
        valid: false,
        isUiFormat: true,
        error: '检测到普通画布格式 JSON，请在 ComfyUI 中使用「工作流 → 导出 (API)」得到 API 格式 JSON',
        imageNodes: [],
        promptNodes: [],
      }
    }

    const imageNodes: ComfyParsedNodes['imageNodes'] = []
    const promptNodes: ComfyParsedNodes['promptNodes'] = []

    for (const [id, node] of Object.entries<any>(parsed)) {
      if (!node || typeof node !== 'object' || !node.class_type) continue
      const classType = String(node.class_type)
      const title = String(node._meta?.title || classType)
      const inputs = node.inputs || {}

      if (classType === 'LoadImage' || typeof inputs.image === 'string') {
        imageNodes.push({ id, title, classType, currentImage: String(inputs.image || ''), ...(classType === 'LoadImageGoohai' ? { emptyValue: '无' } : {}), ...(node._meta?.studio?.imageRole === 'character_sheet' ? { role: 'character_sheet' as const } : {}) })
      }

      for (const field of ['prompt', 'text', 'string', 'positive']) {
        if (Array.isArray(node._meta?.studio?.hiddenInputs) && node._meta.studio.hiddenInputs.includes(field)) continue
        if (typeof inputs[field] === 'string') {
          promptNodes.push({ id, title, classType, field })
          break
        }
      }
    }

    if (imageNodes.length === 0 && promptNodes.length === 0) {
      return { valid: false, isUiFormat: false, error: '未在 JSON 中找到任何 ComfyUI 节点', imageNodes, promptNodes }
    }
    return { valid: true, isUiFormat: false, imageNodes, promptNodes }
  } catch (err: any) {
    return {
      valid: false,
      isUiFormat: false,
      error: `JSON 解析失败: ${err?.message || '语法错误'}`,
      imageNodes: [],
      promptNodes: [],
    }
  }
}

export function autoDetectComfyMappings(workflowJson: string): ComfyNodeMappings {
  const parsed = parseComfyWorkflowNodes(workflowJson)
  let promptNodeId = 'none'
  let portraitNodeId = 'none'
  let costumeNodeId = 'none'
  let poseNodeId = 'none'
  let stitchedNodeId = 'none'

  const posPrompt =
    parsed.promptNodes.find((n) => !/negative|反向|负面/i.test(n.title)) || parsed.promptNodes[0]
  if (posPrompt) promptNodeId = posPrompt.id

  const usedIds = new Set<string>()
  const slotImages = parsed.imageNodes.filter((node) => node.role !== 'character_sheet')
  for (const n of slotImages) {
    if (/人像|脸|人物|portrait|face|person/i.test(n.title) && portraitNodeId === 'none') {
      portraitNodeId = n.id
      usedIds.add(n.id)
    } else if (/服装|衣|穿搭|costume|cloth|outfit/i.test(n.title) && costumeNodeId === 'none') {
      costumeNodeId = n.id
      usedIds.add(n.id)
    } else if (/姿势|动作|骨架|pose/i.test(n.title) && poseNodeId === 'none') {
      poseNodeId = n.id
      usedIds.add(n.id)
    } else if (/拼图|合成|stitch/i.test(n.title) && stitchedNodeId === 'none') {
      stitchedNodeId = n.id
      usedIds.add(n.id)
    }
  }

  const remaining = slotImages.filter((n) => !usedIds.has(n.id))
  if (portraitNodeId === 'none' && remaining[0]) portraitNodeId = remaining.shift()!.id
  if (costumeNodeId === 'none' && remaining[0]) costumeNodeId = remaining.shift()!.id
  if (poseNodeId === 'none' && remaining[0]) poseNodeId = remaining.shift()!.id

  return { promptNodeId, portraitNodeId, costumeNodeId, poseNodeId, stitchedNodeId }
}

// ---------------------------------------------------------------------------
// 网络请求与中文错误
// ---------------------------------------------------------------------------

function normalizeComfyBase(baseUrl: string): string {
  return (baseUrl.trim() || defaultComfyBaseUrl()).replace(/\/+$/, '')
}

function describeComfyNetworkError(baseUrl: string, timedOut: boolean): string {
  if (timedOut) {
    return `[ComfyUI] 请求 ${baseUrl} 超时：ComfyUI 可能正忙或无响应，请查看 ComfyUI 终端日志。`
  }
  if (baseUrl.startsWith('/')) {
    return (
      `[ComfyUI] 本地代理 ${baseUrl} 无法连通 ComfyUI：请确认 ComfyUI 已启动（默认端口 8188；` +
      `pnpm dev 启动时会自动探测 ${LOCAL_COMFY_PORTS.join(' / ')}）。` +
      `若 ComfyUI 端口不同，请在启动网页前设置 COMFYUI_URL，例如：$env:COMFYUI_URL="http://127.0.0.1:8188"; pnpm dev`
    )
  }
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const reasons = [
    `① ComfyUI 未启动，或地址/端口不对（默认 8188；Desktop 旧版为 8000；可在「接口配置」点击「检测本机模型」自动识别）`,
    `② 跨域 (CORS) 被拦截：ComfyUI 启动参数需包含 --enable-cors-header "${origin}"（该参数只能填一个来源）`,
  ]
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    reasons.push('③ 浏览器「本地网络访问」权限被拒绝：请点击地址栏左侧图标允许访问本地设备')
    if (/^http:/i.test(baseUrl) && !/\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(baseUrl)) {
      reasons.push('④ HTTPS 页面不能访问局域网 HTTP 地址（混合内容限制），请改用 127.0.0.1 或本地运行本站')
    }
  }
  return `[ComfyUI] 无法连接 ${baseUrl}。可能原因：\n${reasons.join('\n')}`
}

async function comfyFetch(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  apiKey = '',
  timeoutMs = 30000
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (apiKey.trim()) headers.set('Authorization', `Bearer ${apiKey.trim()}`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: ctrl.signal })
  } catch (e: any) {
    throw new Error(describeComfyNetworkError(baseUrl, e?.name === 'AbortError'))
  } finally {
    clearTimeout(timer)
  }
  // 开发代理连不上后端时会返回非 JSON 的 5xx
  if (
    baseUrl.startsWith('/') &&
    res.status >= 500 &&
    !(res.headers.get('content-type') || '').includes('json')
  ) {
    throw new Error(describeComfyNetworkError(baseUrl, false))
  }
  return res
}

async function readJsonSafe(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text.slice(0, 300) }
  }
}

export async function testComfyConnection(baseUrl: string, apiKey = ''): Promise<string> {
  const cleanUrl = normalizeComfyBase(baseUrl)
  const res = await comfyFetch(cleanUrl, '/system_stats', {}, apiKey, 8000)
  if (res.status === 401 || res.status === 403) {
    throw new Error(`[ComfyUI] ${cleanUrl} 拒绝访问 (HTTP ${res.status})，请检查 API Key / 鉴权设置`)
  }
  if (!res.ok) throw new Error(`[ComfyUI] ${cleanUrl}/system_stats 返回 HTTP ${res.status}，该地址可能不是 ComfyUI`)
  const data = await readJsonSafe(res)
  if (!data?.system) throw new Error(`[ComfyUI] ${cleanUrl} 的响应不是 ComfyUI 格式，请检查地址`)
  const ver = data.system.comfyui_version || '未知版本'
  const dev = data.devices?.[0]
  const gpu = dev?.name ? String(dev.name).replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, '') : '本地设备'
  const vram = dev?.vram_total ? ` · 显存 ${(dev.vram_total / 1024 ** 3).toFixed(1)} GB` : ''
  return `ComfyUI ${ver} · ${gpu}${vram}`
}

/** 依次尝试候选地址，返回第一个可用的 ComfyUI 地址 */
export async function detectComfyUi(
  current = '',
  apiKey = ''
): Promise<{ baseUrl: string; info: string } | null> {
  for (const url of comfyCandidateUrls(current)) {
    try {
      const info = await testComfyConnection(url, apiKey)
      return { baseUrl: url, info }
    } catch {
      /* try next */
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 工作流与本机模型/节点匹配检测（基于 /object_info）
// ---------------------------------------------------------------------------

export interface ComfyCheckResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  fixes: string[]
  /** 自动修正模型路径后的工作流 JSON（无修正时为 undefined） */
  fixedJson?: string
}

function comboOptions(spec: any): string[] | null {
  if (!Array.isArray(spec)) return null
  if (Array.isArray(spec[0])) return spec[0].map(String)
  if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options.map(String)
  return null
}

const baseName = (s: string) => s.split(/[\\/]/).pop()!.toLowerCase()

export async function fetchComfyObjectInfo(baseUrl: string, apiKey: string, workflowJson: string): Promise<ComfyObjectInfo> {
  const parsed = parseComfyWorkflowNodes(workflowJson)
  if (!parsed.valid) throw new Error(parsed.error || '工作流 JSON 无效')
  const workflow: ComfyWorkflow = JSON.parse(workflowJson)
  const base = normalizeComfyBase(baseUrl)
  const classes = Array.from(new Set(Object.values(workflow).map((node) => node.class_type).filter(Boolean)))
  const entries = await Promise.all(classes.map(async (cls) => {
    const res = await comfyFetch(base, `/object_info/${encodeURIComponent(cls)}`, {}, apiKey, 15000)
    if (!res.ok) throw new Error(`[ComfyUI] 无法读取节点「${cls}」的定义（HTTP ${res.status}），请检查连接地址、访问令牌和网关接口权限。`)
    const json = await readJsonSafe(res)
    return [cls, json?.[cls]] as const
  }))
  return Object.fromEntries(entries.filter(([, definition]) => definition))
}

export async function checkComfyWorkflow(
  baseUrl: string,
  apiKey: string,
  workflowJson: string,
  mappedImageNodeIds: string[] = [],
  objectInfo?: ComfyObjectInfo
): Promise<ComfyCheckResult> {
  const parsedInfo = parseComfyWorkflowNodes(workflowJson)
  if (!parsedInfo.valid) {
    return { ok: false, errors: [parsedInfo.error || '工作流 JSON 无效'], warnings: [], fixes: [] }
  }
  const wf: ComfyWorkflow = JSON.parse(workflowJson)
  const info = objectInfo ?? await fetchComfyObjectInfo(baseUrl, apiKey, workflowJson)

  const errors: string[] = []
  const warnings: string[] = []
  const fixes: string[] = []
  const mapped = new Set(mappedImageNodeIds.filter((x) => x && x !== 'none'))
  const imageLoaders = new Set(getWorkflowImages(workflowJson, [], info).map((node) => node.nodeId))

  for (const [id, node] of Object.entries(wf)) {
    if (!node?.class_type) continue
    const title = node._meta?.title || node.class_type
    const def = info[node.class_type]
    if (!def) {
      errors.push(
        `缺少节点「${node.class_type}」（节点 ${id}：${title}）。请在 ComfyUI Manager 安装对应的自定义节点，或升级 ComfyUI。`
      )
      continue
    }
    const required = def.input?.required || {}
    const optional = def.input?.optional || {}
    const inputs = node.inputs || {}

    for (const [name, spec] of Object.entries<any>(required)) {
      // V3 自动扩展组使用 images.image_1 等扁平输入，组名本身不参与执行。
      if (spec?.[0] === 'COMFY_AUTOGROW_V3') {
        const template = spec[1]?.template
        if (template?.input?.required) {
          for (let i = 0; i < (template.min ?? 0); i++) {
            const child = template.names?.[i] ?? `${template.prefix}${i}`
            if (!(`${name}.${child}` in inputs)) {
              errors.push(`节点 ${id}「${title}」缺少必填输入 ${name}.${child}`)
            }
          }
        }
        continue
      }
      if (!(name in inputs)) errors.push(`节点 ${id}「${title}」缺少必填输入 ${name}`)
    }

    for (const [name, value] of Object.entries(inputs)) {
      if (Array.isArray(value)) continue // 节点连线
      const spec = required[name] ?? optional[name]
      const options = comboOptions(spec)
      if (!options || typeof value !== 'string') continue
      if (name === 'image' && mapped.has(id) && imageLoaders.has(id)) continue
      if (node.class_type === 'LoadImage' && name === 'image') {
        if (!mapped.has(id) && !options.includes(value)) {
          warnings.push(`节点 ${id}「${title}」引用的图片 ${value} 不在 ComfyUI input 目录中，且未映射到人像/服装/姿势槽位`)
        }
        continue
      }
      if (options.includes(value)) continue
      const sameFile = options.find((o) => baseName(o) === baseName(value))
      if (sameFile) {
        inputs[name] = sameFile
        fixes.push(`节点 ${id}「${title}」${name}：${value} → ${sameFile}（自动修正路径）`)
        continue
      }
      const sample = options.slice(0, 12).join('、')
      errors.push(
        `节点 ${id}「${title}」的 ${name} = ${value} 在本机不存在（通常是模型文件未安装或路径不同）。本机可选：${sample || '（空）'}${options.length > 12 ? ' …' : ''}`
      )
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    fixes,
    fixedJson: fixes.length ? JSON.stringify(wf, null, 2) : undefined,
  }
}

function translateNodeError(er: any): string {
  const detail = er?.details ? `（${er.details}）` : ''
  switch (er?.type) {
    case 'value_not_in_list':
      return `${er.extra_info?.input_name ?? '输入'} 的值不在本机可选列表中${detail}——通常是模型文件不存在或路径不同`
    case 'required_input_missing':
      return `缺少必填输入 ${er.extra_info?.input_name ?? ''}`
    case 'invalid_input_type':
    case 'return_type_mismatch':
      return `节点连线类型不匹配${detail}`
    case 'value_bigger_than_max':
    case 'value_smaller_than_min':
      return `参数超出范围${detail}`
    case 'image_not_found':
    case 'custom_validation_failed':
      return `${er.message || '校验失败'}${detail}`
    default:
      return `${er?.message || '校验失败'}${detail}`
  }
}

function formatComfyPromptError(json: any, wf: ComfyWorkflow, status: number): string {
  const parts: string[] = []
  const e = json?.error
  if (e) {
    if (e.type === 'missing_node_type' || /does not exist|not found/i.test(String(e.message))) {
      parts.push(`缺少节点类型：${e.details || e.message}。请在 ComfyUI Manager 安装缺失的自定义节点或升级 ComfyUI`)
    } else if (e.type === 'prompt_no_outputs') {
      parts.push('工作流没有输出节点（SaveImage / PreviewImage）')
    } else if (e.type !== 'prompt_outputs_failed_validation') {
      parts.push(`${e.message || e.type}${e.details ? `：${e.details}` : ''}`)
    }
  }
  for (const [id, ne] of Object.entries<any>(json?.node_errors || {})) {
    const title = wf[id]?._meta?.title || ne?.class_type || id
    for (const er of ne?.errors || []) {
      parts.push(`节点 ${id}「${title}」：${translateNodeError(er)}`)
    }
  }
  if (!parts.length) parts.push(json?._raw || `HTTP ${status}`)
  return `[ComfyUI] 提交工作流失败：\n${parts.join('\n')}`
}

async function freeComfyMemory(baseUrl: string, apiKey: string): Promise<void> {
  try {
    await comfyFetch(
      baseUrl,
      '/free',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      },
      apiKey,
      10000
    )
  } catch {
    /* ignore */
  }
}

function formatExecutionError(messages: any[], wf: ComfyWorkflow): { text: string; oom: boolean } {
  const errMsg = (messages || []).find((m) => m?.[0] === 'execution_error')?.[1]
  if (errMsg) {
    const title = wf[errMsg.node_id]?._meta?.title || errMsg.node_type || errMsg.node_id
    const raw = `${errMsg.exception_type || ''} ${errMsg.exception_message || ''}`
    if (/out of memory|OutOfMemory|CUDA error: out of memory|allocat/i.test(raw)) {
      return {
        oom: true,
        text:
          `[ComfyUI] 显存不足（节点 ${errMsg.node_id}「${title}」）。已请求 ComfyUI 释放显存。\n` +
          '建议：关闭其他占用显卡的程序；在工作流中把「按姿势图比例确定输出尺寸」节点的 megapixels 从 1.0 调低到 0.6；然后重试。',
      }
    }
    return {
      oom: false,
      text: `[ComfyUI] 执行出错（节点 ${errMsg.node_id}「${title}」）：${String(errMsg.exception_message || raw).trim().slice(0, 400)}`,
    }
  }
  if ((messages || []).some((m) => m?.[0] === 'execution_interrupted')) {
    return { oom: false, text: '[ComfyUI] 任务已被中断（可能在 ComfyUI 界面中点击了取消）' }
  }
  return { oom: false, text: `[ComfyUI] 工作流执行出错：${JSON.stringify(messages || '').slice(0, 300)}` }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取生成结果失败'))
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
}

async function uploadImageToComfy(
  baseUrl: string,
  src: string,
  filenamePrefix: string,
  apiKey: string
): Promise<string> {
  let dataUrl: string
  try {
    dataUrl = await srcToPngDataUrl(src)
  } catch {
    throw new Error(`读取参考图失败：${src.slice(0, 80)}`)
  }
  const form = new FormData()
  form.append('image', dataUrlToBlob(dataUrl), `${filenamePrefix}_${Date.now()}.png`)
  form.append('subfolder', 'pose_studio')
  form.append('overwrite', 'true')

  const res = await comfyFetch(baseUrl, '/upload/image', { method: 'POST', body: form }, apiKey, 60000)
  if (!res.ok) {
    throw new Error(`[ComfyUI] 上传参考图失败 (HTTP ${res.status})：${(await res.text()).slice(0, 200)}`)
  }
  const json = await res.json()
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name
}

function openComfySocket(baseUrl: string, clientId: string, onMessage: (msg: any) => void): WebSocket | null {
  try {
    const u = new URL(baseUrl, window.location.href)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws`
    u.search = `clientId=${encodeURIComponent(clientId)}`
    const ws = new WebSocket(u.toString())
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      try {
        onMessage(JSON.parse(e.data))
      } catch {
        /* ignore */
      }
    }
    ws.onerror = () => {
      /* 进度推送失败不影响结果轮询 */
    }
    return ws
  } catch {
    return null
  }
}

export interface GenerationProgress {
  stage: 'check' | 'upload' | 'queue' | 'running' | 'download'
  message: string
  /** 0-100，未知时为 undefined */
  percent?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function generateWithComfyUi(params: {
  recipe: RecipeState
  prompt: string
  config: ApiConfig
  baseUrl: string
  apiKey: string
  onProgress?: (p: GenerationProgress) => void
}): Promise<{ imageUrl: string; modelUsed: string; providerUsed: ImageProviderId }> {
  const { recipe, prompt, config, baseUrl, apiKey } = params
  const report = params.onProgress ?? (() => {})
  throwIfAborted()
  const cp = config.comfyuiParams
  const timeoutSec = Math.max(60, cp.timeoutSec || 600)
  const parsedInfo = parseComfyWorkflowNodes(cp.workflowJson)
  if (!parsedInfo.valid) {
    throw new Error(`[ComfyUI] ${parsedInfo.error || '工作流 JSON 无效'}`)
  }

  // 0. 预检：服务在线 + 节点/模型与本机匹配
  report({ stage: 'check', message: '正在检查 ComfyUI 服务与模型…' })
  await testComfyConnection(baseUrl, apiKey)
  const schemas = await fetchComfyObjectInfo(baseUrl, apiKey, cp.workflowJson)
  const flexLayout = isComfyFlexibleLayout(config, recipe)
  let workflow: ComfyWorkflow

  if (flexLayout) {
    // 灵活参考：按「人像/服装/姿势」动态组合 1~3 张图；无人像时把姿势图放在最前作为构图底图，避免服装无头人台成为底图
    const roleSource: Record<'portrait' | 'costume' | 'pose', { src: string; prefix: string; label: string }> = {
      portrait: { src: recipe.portrait?.原图 || recipe.portrait?.缩略图 || '', prefix: 'studio_portrait', label: '人像' },
      costume: {
        src: recipe.costume?.预览图 || recipe.costume?.原图 || recipe.costume?.缩略图 || '',
        prefix: 'studio_costume',
        label: '服装',
      },
      pose: { src: recipe.pose ? poseImagePath(recipe.pose) : '', prefix: 'studio_pose', label: '姿势' },
    }
    const flexRefs = getFlexReferenceOrder(recipe).map((role) => ({ role, ...roleSource[role] }))
    if (flexRefs.length === 0) throw new Error('[ComfyUI] 请至少选择一张参考图（人像 / 服装 / 姿势 任选）')
    const template = buildFlexQwen21LocalWorkflow(flexRefs.map((ref) => ({ role: ref.role, name: 'flex_ref.png' })))
    const flexCheck = await checkComfyWorkflow(baseUrl, apiKey, JSON.stringify(template), [], schemas)
    if (!flexCheck.ok) throw new Error(`[ComfyUI] 工作流与本机不匹配：\n${flexCheck.errors.join('\n')}`)
    workflow = JSON.parse(flexCheck.fixedJson ?? JSON.stringify(template))
    throwIfAborted()
    for (let index = 0; index < flexRefs.length; index += 1) {
      const ref = flexRefs[index]
      report({ stage: 'upload', message: `正在上传${ref.label}参考图…` })
      workflow[String(index + 1)].inputs.image = await uploadImageToComfy(baseUrl, ref.src, ref.prefix, apiKey)
    }
    workflow['9'].inputs.prompt = prompt
  } else {
    const extraImageNodes = getWorkflowImages(cp.workflowJson, [cp.portraitNodeId, cp.costumeNodeId, cp.poseNodeId, cp.stitchedNodeId], schemas)
    const extraImages = recipe.workflowImagesIdentity === workflowIdentity(cp.workflowJson) ? recipe.workflowImages || {} : {}
    const selectedJson = applyWorkflowOverrides(cp.workflowJson, cp.parameterOverrides, schemas)
    const check = await checkComfyWorkflow(baseUrl, apiKey, selectedJson, [
      cp.portraitNodeId,
      cp.costumeNodeId,
      cp.poseNodeId,
      cp.stitchedNodeId,
      ...extraImageNodes.filter((node) => extraImages[node.nodeId]?.url || (node.optional && node.role === 'character_sheet')).map((node) => node.nodeId),
    ], schemas)
    if (!check.ok) {
      throw new Error(`[ComfyUI] 工作流与本机不匹配：\n${check.errors.join('\n')}`)
    }
    workflow = JSON.parse(check.fixedJson ?? selectedJson)

    // 1. 按映射槽位上传参考图并注入节点
    // 双图模式（服装节点为 none）且未选人像时：用服装图作为「人物/服装」参考，脸部由模型自由生成
    const costumeAsPersonUpload = Boolean(
      !recipe.portrait && recipe.costume && cp.costumeNodeId === 'none' && cp.portraitNodeId !== 'none'
    )
    const slotUploads: Array<{ nodeId: string; src: string | null; prefix: string; label: string }> = [
      {
        nodeId: cp.portraitNodeId,
        src: recipe.portrait
          ? recipe.portrait.原图 || recipe.portrait.缩略图
          : costumeAsPersonUpload && recipe.costume
            ? recipe.costume.预览图 || recipe.costume.原图 || recipe.costume.缩略图
            : null,
        prefix: 'studio_portrait',
        label: costumeAsPersonUpload ? '人物/服装' : '人像',
      },
      {
        nodeId: cp.costumeNodeId,
        src: recipe.costume ? recipe.costume.预览图 || recipe.costume.原图 || recipe.costume.缩略图 : null,
        prefix: 'studio_costume',
        label: '服装',
      },
      {
        nodeId: cp.poseNodeId,
        src: recipe.pose ? poseImagePath(recipe.pose) : null,
        prefix: 'studio_pose',
        label: '姿势',
      },
    ]
    const combinationError = validateReferenceCombinations(cp.workflowJson, [
      ...slotUploads.filter((slot) => slot.src && slot.nodeId && slot.nodeId !== 'none').map((slot) => slot.nodeId),
      ...extraImageNodes.filter((node) => extraImages[node.nodeId]?.url).map((node) => node.nodeId),
    ])
    if (combinationError) throw new Error(`[ComfyUI] ${combinationError}`)

    const invalidSlots = slotUploads.filter((slot) => slot.nodeId && slot.nodeId !== 'none' && !parsedInfo.imageNodes.some((node) => node.id === slot.nodeId))
    if (invalidSlots.length) {
      throw new Error(`[ComfyUI] ${invalidSlots.map((slot) => slot.label).join('、')}节点映射已失效，请重新识别或选择节点`)
    }
    const missingSlots = slotUploads.filter((slot) => slot.nodeId && slot.nodeId !== 'none' && !slot.src && parsedInfo.imageNodes.find((node) => node.id === slot.nodeId)?.emptyValue === undefined)
    if (missingSlots.length) {
      throw new Error(`[ComfyUI] 请先选择或上传：${missingSlots.map((slot) => slot.label).join('、')}`)
    }

    throwIfAborted()
    for (const slot of slotUploads) {
      if (!slot.nodeId || slot.nodeId === 'none' || !workflow[slot.nodeId]?.inputs) continue
      if (!slot.src) {
        const emptyValue = parsedInfo.imageNodes.find((node) => node.id === slot.nodeId)?.emptyValue
        if (emptyValue !== undefined) {
          workflow[slot.nodeId].inputs.image = emptyValue
          continue
        }
        throw new Error(`当前工作流需要「${slot.label}」参考图（节点 ${slot.nodeId}），请先在图库中选择`)
      }
      throwIfAborted()
      report({ stage: 'upload', message: `正在上传${slot.label}参考图…` })
      workflow[slot.nodeId].inputs.image = await uploadImageToComfy(baseUrl, slot.src, slot.prefix, apiKey)
    }

    for (const node of extraImageNodes) {
      const image = extraImages[node.nodeId]
      if (!image?.url) {
        if (node.optional && node.role === 'character_sheet') workflow[node.nodeId].inputs.image = '无'
        continue
      }
      throwIfAborted()
      report({ stage: 'upload', message: `正在上传${node.label}…` })
      workflow[node.nodeId].inputs.image = await uploadImageToComfy(baseUrl, image.url, 'studio_reference', apiKey)
    }

    if (cp.stitchedNodeId && cp.stitchedNodeId !== 'none' && workflow[cp.stitchedNodeId]?.inputs) {
      throwIfAborted()
      report({ stage: 'upload', message: '正在上传参考拼图…' })
      const stitchedDataUrl = await stitchRecipeCanvas(recipe)
      workflow[cp.stitchedNodeId].inputs.image = await uploadImageToComfy(baseUrl, stitchedDataUrl, 'studio_stitched', apiKey)
    }

    // 2. 注入提示词节点
    if (cp.promptNodeId && cp.promptNodeId !== 'none' && workflow[cp.promptNodeId]?.inputs) {
      const inputs = workflow[cp.promptNodeId].inputs
      for (const field of ['prompt', 'text', 'string', 'positive']) {
        if (typeof inputs[field] === 'string') {
          inputs[field] = prompt
          break
        }
      }
    }
  }

  // 高质量模式：复杂姿势下手/脚/颈部更稳（更慢）
  if (cp.qualityMode === 'high') applyComfyQualityBoost(workflow)

  // 3. 随机化种子
  if (cp.randomizeSeed) {
    const nextSeed = Math.floor(Math.random() * 90000000000000) + 1000000
    for (const node of Object.values<any>(workflow)) {
      if (!node?.inputs) continue
      if (typeof node.inputs.seed === 'number') node.inputs.seed = nextSeed
      if (typeof node.inputs.noise_seed === 'number') node.inputs.noise_seed = nextSeed
    }
  }

  // 4. 提交任务到 ComfyUI /prompt，并通过 WebSocket 接收实时进度
  const clientId = `pose_studio_${Math.random().toString(36).slice(2, 10)}`
  let promptId = ''
  let lastNodeTitle = ''
  const ws = openComfySocket(baseUrl, clientId, (msg) => {
    const d = msg?.data
    if (!d || (promptId && d.prompt_id && d.prompt_id !== promptId)) return
    if (msg.type === 'executing' && d.node) {
      lastNodeTitle = workflow[d.node]?._meta?.title || workflow[d.node]?.class_type || d.node
      report({ stage: 'running', message: `正在执行：${lastNodeTitle}` })
    } else if (msg.type === 'progress' && d.max) {
      const percent = Math.round((d.value / d.max) * 100)
      report({ stage: 'running', message: `${lastNodeTitle || '采样中'}（${d.value}/${d.max}）`, percent })
    }
  })

  try {
    throwIfAborted()
    report({ stage: 'queue', message: '正在提交工作流…' })
    const promptRes = await comfyFetch(
      baseUrl,
      '/prompt',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      },
      apiKey,
      60000
    )
    const promptJson = await readJsonSafe(promptRes)
    if (!promptRes.ok || !promptJson?.prompt_id) {
      throw new Error(formatComfyPromptError(promptJson, workflow, promptRes.status))
    }
    promptId = promptJson.prompt_id
    report({ stage: 'queue', message: '已提交，等待 ComfyUI 执行…' })

    // 5. 轮询 /history/{prompt_id} 获取最终结果
    const startedAt = Date.now()
    for (let attempt = 0; ; attempt++) {
      await sleep(1500)
      // 「立即停止」：主动中断时取消 ComfyUI 队列中的任务并退出轮询
      if (isActiveGenerationAborted()) {
        await cancelComfyPrompt(baseUrl, apiKey, promptId)
        throwIfAborted()
      }
      if (Date.now() - startedAt > timeoutSec * 1000) {
        await cancelComfyPrompt(baseUrl, apiKey, promptId)
        throw new Error(
          `[ComfyUI] 等待生成结果超时（超过 ${Math.round(timeoutSec / 60)} 分钟），已取消该任务。首次加载模型较慢，可在合成台调大超时时间后重试。`
        )
      }
      let histRes: Response
      try {
        histRes = await comfyFetch(baseUrl, `/history/${promptId}`, {}, apiKey, 15000)
      } catch (e) {
        if (attempt % 4 === 3) report({ stage: 'running', message: '暂时无法连接 ComfyUI，正在重试…' })
        if (Date.now() - startedAt > 60000 && attempt % 20 === 19) throw e
        continue
      }
      if (!histRes.ok) continue
      const item = (await readJsonSafe(histRes))?.[promptId]
      if (!item) {
        if (attempt % 3 === 0) {
          try {
            const q = await (await comfyFetch(baseUrl, '/queue', {}, apiKey, 10000)).json()
            const pendingIdx = (q?.queue_pending || []).findIndex((x: any) => x?.[1] === promptId)
            if (pendingIdx >= 0) {
              report({ stage: 'queue', message: `排队中，前方还有 ${pendingIdx + (q.queue_running?.length || 0)} 个任务` })
            }
          } catch {
            /* ignore */
          }
        }
        continue
      }

      if (item.status?.status_str === 'error') {
        const { text, oom } = formatExecutionError(item.status?.messages, workflow)
        if (oom) await freeComfyMemory(baseUrl, apiKey)
        throw new Error(text)
      }
      if (item.status && item.status.completed === false && item.status.status_str !== 'success') continue

      let outImg: { filename: string; subfolder?: string; type?: string } | null = null
      for (const nodeOut of Object.values<any>(item.outputs || {})) {
        for (const im of nodeOut?.images || []) {
          if (!outImg || (im?.type === 'output' && outImg.type !== 'output')) outImg = im
        }
      }
      if (!outImg) {
        if (item.status?.completed) throw new Error('[ComfyUI] 工作流已执行完成，但没有输出图片（请检查是否有 SaveImage 节点）')
        continue
      }

      throwIfAborted()
      report({ stage: 'download', message: '正在获取生成结果…', percent: 100 })
      const qs = new URLSearchParams({
        filename: outImg.filename,
        subfolder: outImg.subfolder || '',
        type: outImg.type || 'output',
      })
      const viewRes = await comfyFetch(baseUrl, `/view?${qs.toString()}`, {}, apiKey, 60000)
      if (!viewRes.ok) throw new Error(`[ComfyUI] 获取生成图片失败 (HTTP ${viewRes.status})`)
      const blob = await viewRes.blob()
      if (!blob.size || !blob.type.startsWith('image/')) {
        throw new Error('[ComfyUI] 返回的生成结果不是有效图片')
      }
      // 下载完成前被停止：不再把结果写入历史
      throwIfAborted()
      return { imageUrl: await blobToDataUrl(blob), modelUsed: 'ComfyUI 工作流', providerUsed: 'comfyui' }
    }
  } finally {
    ws?.close()
  }
}

async function cancelComfyPrompt(baseUrl: string, apiKey: string, promptId: string): Promise<void> {
  try {
    const q = await (await comfyFetch(baseUrl, '/queue', {}, apiKey, 10000)).json()
    if ((q?.queue_running || []).some((x: any) => x?.[1] === promptId)) {
      await comfyFetch(baseUrl, '/interrupt', { method: 'POST' }, apiKey, 10000)
    } else {
      await comfyFetch(
        baseUrl,
        '/queue',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) },
        apiKey,
        10000
      )
    }
  } catch {
    /* ignore */
  }
}

async function generateCharacterImageInner(params: {
  recipe: RecipeState
  prompt: string
  config: ApiConfig
  onProgress?: (p: GenerationProgress) => void
}): Promise<{ imageUrl: string; modelUsed: string; providerUsed: ImageProviderId }> {
  const { recipe, prompt, config, onProgress } = params
  const provider = config.activeProvider
  const pCfg = config.providers[provider]
  const apiKey = pCfg.apiKey.trim()

  if (provider !== 'comfyui' && !apiKey) {
    throw new Error(`请先配置 ${PROVIDER_META[provider].name} 的 API Key`)
  }

  const rawSources = [
    recipe.portrait && (recipe.portrait.原图 || recipe.portrait.缩略图),
    recipe.costume && (recipe.costume.预览图 || recipe.costume.原图 || recipe.costume.缩略图),
    recipe.pose && poseImagePath(recipe.pose),
    ...(recipe.extraImages || []).map((x) => x.url),
    ...(provider === 'comfyui' && recipe.workflowImagesIdentity === workflowIdentity(config.comfyuiParams.workflowJson)
      ? Object.values(recipe.workflowImages || {}).map((image) => image.url) : []),
  ].filter(Boolean) as string[]

  if (!rawSources.length) {
    throw new Error('请先选择或上传至少 1 张参考图')
  }

  const model = pCfg.model === 'custom' ? pCfg.customModel.trim() : pCfg.model
  if (provider !== 'comfyui' && !model) {
    throw new Error('请选择或填写有效的模型名称')
  }

  const baseUrl = (pCfg.baseUrl.trim() || PROVIDER_META[provider].defaultBaseUrl).replace(/\/+$/, '')

  if (provider === 'comfyui') {
    return generateWithComfyUi({ recipe, prompt, config, baseUrl, apiKey, onProgress })
  }

  // 判断当前请求是否需要转换为本地 Base64：
  // 1) 用户显式选择了 base64 模式
  // 2) 或者勾选了「附带三合一 Canvas 合成图」（本地动态绘制无公网 URL）
  // 3) 或者使用 Gemini Native 原生接口 / OpenAI multipart/form-data 模式
  const needBase64 =
    config.imagePassMode === 'base64' ||
    config.sendStitchedSheet ||
    (provider === 'gemini' && config.geminiParams.endpointMode === 'native') ||
    (provider === 'gpt' && config.gptParams.endpointMode === 'images_edits')

  const imageRefs: string[] = needBase64
    ? await Promise.all(rawSources.map(srcToPngDataUrl))
    : rawSources.map(toPublicHttpsUrl)

  const allImageRefs: string[] = config.sendStitchedSheet
    ? [...imageRefs, await stitchRecipeCanvas(recipe)]
    : imageRefs

  throwIfAborted()

  let res: Response
  let json: any

  // =========================================================================
  // 协议 1: OpenAI GPT Image (gpt-image-2.5 / gpt-image-2 / gpt-image-1.5 / 1)
  // =========================================================================
  if (provider === 'gpt') {
    const g = config.gptParams
    const v1 = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`

    if (g.endpointMode === 'images_edits_json') {
      // OpenAI 最新 /v1/images/edits JSON 协议：直接传 images: [{ image_url: "https://..." }]，无需上传文件流！
      const payload: Record<string, any> = {
        model,
        prompt,
        images: allImageRefs.map((ref) => ({ image_url: ref })),
      }
      if (g.size !== 'auto') payload.size = g.size
      if (g.quality !== 'auto') payload.quality = g.quality
      if (g.inputFidelity) payload.input_fidelity = g.inputFidelity
      if (g.background !== 'auto') payload.background = g.background
      if (g.outputFormat) payload.output_format = g.outputFormat
      if (g.moderation !== 'auto') payload.moderation = g.moderation

      res = await smartFetch(
        `${v1}/images/edits`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        },
        config.useProxy
      )
      json = await res.json()
    } else if (g.endpointMode === 'images_edits') {
      // 传统 /v1/images/edits (multipart/form-data 二进制文件上传)
      const fd = new FormData()
      fd.append('model', model)
      fd.append('prompt', prompt)
      allImageRefs.forEach((du, i) => {
        fd.append('image[]', dataUrlToBlob(du), `ref_${i + 1}.png`)
      })
      if (g.size !== 'auto') fd.append('size', g.size)
      if (g.quality !== 'auto') fd.append('quality', g.quality)
      if (g.inputFidelity) fd.append('input_fidelity', g.inputFidelity)
      if (g.background !== 'auto') fd.append('background', g.background)
      if (g.outputFormat) fd.append('output_format', g.outputFormat)
      if (g.moderation !== 'auto') fd.append('moderation', g.moderation)

      res = await smartFetch(
        `${v1}/images/edits`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: fd,
        },
        config.useProxy
      )
      json = await res.json()
    } else if (g.endpointMode === 'responses') {
      // OpenAI Responses API (/v1/responses) 支持直接传 HTTPS image_url 或 Base64
      const inputContent = [
        ...allImageRefs.map((ref) => ({ type: 'input_image', image_url: ref })),
        { type: 'input_text', text: prompt },
      ]
      const toolCfg: Record<string, any> = { type: 'image_generation' }
      if (g.size !== 'auto') toolCfg.size = g.size
      if (g.quality !== 'auto') toolCfg.quality = g.quality
      if (g.background !== 'auto') toolCfg.background = g.background
      if (g.inputFidelity) toolCfg.input_fidelity = g.inputFidelity
      if (g.outputFormat) toolCfg.output_format = g.outputFormat

      res = await smartFetch(
        `${v1}/responses`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: [{ role: 'user', content: inputContent }],
            tools: [toolCfg],
          }),
        },
        config.useProxy
      )
      json = await res.json()
    } else {
      // 兼容中转站 Chat Completions，支持直接传 HTTPS URL
      const content = [
        { type: 'text', text: prompt },
        ...allImageRefs.map((ref) => ({ type: 'image_url', image_url: { url: ref } })),
      ]
      res = await smartFetch(
        `${v1}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content }],
            modalities: ['text', 'image'],
          }),
        },
        config.useProxy
      )
      json = await res.json()
    }
  }
  // =========================================================================
  // 协议 2: Google Gemini 原生 / Nano Banana
  // =========================================================================
  else if (provider === 'gemini') {
    const gm = config.geminiParams
    if (gm.endpointMode === 'native') {
      const root = baseUrl.replace(/\/v1(?:beta)?$/, '')
      const url = `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
      const parts = [
        ...allImageRefs.map((du) => ({
          inlineData: { mimeType: 'image/png', data: du.split(',')[1] },
        })),
        { text: prompt },
      ]
      const isGemini3 = model.includes('gemini-3')
      const imageConfig: Record<string, string> = {
        aspectRatio: gm.aspectRatio,
      }
      if (isGemini3 && gm.imageSize) {
        imageConfig.imageSize = gm.imageSize
      }

      res = await smartFetch(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig,
            },
          }),
        },
        config.useProxy
      )
      json = await res.json()
    } else {
      const v1 = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`
      const content = [
        { type: 'text', text: `${prompt}\n(Output aspect ratio: ${gm.aspectRatio}, resolution: ${gm.imageSize})` },
        ...allImageRefs.map((ref) => ({ type: 'image_url', image_url: { url: ref } })),
      ]
      res = await smartFetch(
        `${v1}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content }],
            modalities: ['text', 'image'],
          }),
        },
        config.useProxy
      )
      json = await res.json()
    }
  }
  // =========================================================================
  // 协议 3: 阿里云百炼 Qwen-Image (DashScope multimodal-generation)
  // =========================================================================
  else if (provider === 'qwen') {
    const qw = config.qwenParams
    const endpoint = baseUrl.includes('/services/aigc/')
      ? baseUrl
      : `${baseUrl.replace(/\/api\/v1$/, '')}/api/v1/services/aigc/multimodal-generation/generation`

    // Qwen-Image 原生支持直接传入公网 HTTPS URL 或 Base64 Data URL: {"image": "https://..."}
    const content = [
      ...imageRefs.map((ref) => ({ image: ref })),
      { text: prompt },
    ]

    res = await smartFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: {
            messages: [
              {
                role: 'user',
                content,
              },
            ],
          },
          parameters: {
            size: qw.size,
            n: qw.n || 1,
            prompt_extend: qw.promptExtend,
            watermark: qw.watermark,
            ...(qw.negativePrompt.trim() ? { negative_prompt: qw.negativePrompt.trim() } : {}),
          },
        }),
      },
      config.useProxy
    )
    json = await res.json()
  }
  // =========================================================================
  // 协议 4: 字节火山方舟 Doubao Seedream (/api/v3/images/generations)
  // =========================================================================
  else {
    const db = config.doubaoParams
    let endpoint = baseUrl
    if (!endpoint.endsWith('/images/generations')) {
      if (endpoint.endsWith('/api/v3') || endpoint.endsWith('/v1')) {
        endpoint = `${endpoint}/images/generations`
      } else {
        endpoint = `${endpoint}/api/v3/images/generations`
      }
    }

    res = await smartFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          image: allImageRefs, // Seedream 4.0 / 4.5 / 5.0 原生支持传入多张参考图 URL 数组或 Base64 数组
          size: db.size,
          sequential_image_generation: db.sequentialImageGeneration,
          watermark: db.watermark,
          response_format: db.responseFormat,
        }),
      },
      config.useProxy
    )
    json = await res.json()
  }

  if (!res.ok) {
    const errMsg =
      json?.error?.message ||
      json?.message ||
      json?.code ||
      `请求失败 (HTTP ${res.status})`
    throw new Error(`[${PROVIDER_META[provider].shortName}] ${errMsg}`)
  }

  const imageUrl = extractUniversalImage(json)
  if (!imageUrl) {
    const fallbackText =
      json?.choices?.[0]?.message?.content ||
      json?.output?.choices?.[0]?.message?.content?.[0]?.text ||
      JSON.stringify(json).slice(0, 260)
    throw new Error(`接口已响应但未解析到图片输出：${fallbackText}`)
  }

  return { imageUrl, modelUsed: model, providerUsed: provider }
}

/**
 * 统一入口：生成角色图（支持通过 abortActiveGeneration() 立即中断）
 * - 云端协议：中断进行中的 fetch
 * - 本地 ComfyUI：中断轮询并取消队列任务
 */
export async function generateCharacterImage(params: {
  recipe: RecipeState
  prompt: string
  config: ApiConfig
  onProgress?: (p: GenerationProgress) => void
}): Promise<{ imageUrl: string; modelUsed: string; providerUsed: ImageProviderId }> {
  activeGenerationController = new AbortController()
  try {
    return await generateCharacterImageInner(params)
  } catch (error) {
    // fetch 被 abort 时抛出的是 DOMException（不是 Error 子类），且此时 controller 即将被清空；
    // 统一转换为 name='AbortError' 的普通 Error，供上层稳定识别「主动停止」
    if (activeGenerationController.signal.aborted) {
      const abortError = new Error('已手动停止当前生成')
      abortError.name = 'AbortError'
      throw abortError
    }
    throw error
  } finally {
    activeGenerationController = null
  }
}
