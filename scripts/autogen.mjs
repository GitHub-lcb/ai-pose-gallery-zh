#!/usr/bin/env node
/**
 * AI 角色三合一：本地 ComfyUI 随机配方 24/7 自动生成
 *
 * - 每次随机：人像 + 服装 + 姿势（安全模式默认开启，只选 SFW 素材）、画风预设、随机种子
 * - 工作流：与站点「Qwen Image 2.1 三图合成（本机 int8 模型）」模板一致
 *   （Qwen-Image 2.1 int8 + qwen3vl_8b_bf16 + qwen_image_2.1_vae_bf16，
 *    画布由姿势图按 megapixels 缩放决定，默认 1.6875 MP ≈ 1152x1536）
 * - 输出：.auto-gen/images/*.png + .auto-gen/meta.jsonl（配方/提示词/种子）+ autogen.log
 * - 自动重试 ComfyUI 断连、自动按容量清理旧图（默认 30GB）
 *
 * 用法（在项目根目录）：
 *   node scripts/autogen.mjs
 * 环境变量：
 *   COMFY_URL=http://127.0.0.1:8188   DELAY_SEC=3   MAX_STORAGE_GB=30
 *   INCLUDE_NSFW=1   STEPS=25   MEGAPIXELS=1.6875   REF_RESOLUTION=1024
 *   CACHE_DTYPE=int8   TIMEOUT_SEC=600   AUTOGEN_OUT_DIR=<自定义输出目录>
 */
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const COMFY = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
const OUT_DIR = path.resolve(process.env.AUTOGEN_OUT_DIR || path.join(ROOT, '.auto-gen'))
const COMFY_OUTPUT_DIR = process.env.COMFY_OUTPUT_DIR ? path.resolve(process.env.COMFY_OUTPUT_DIR) : null
const KEEP_COMFY_COPIES = process.env.KEEP_COMFY_COPIES === '1'
const IMAGE_DIR = path.join(OUT_DIR, 'images')
const META_FILE = path.join(OUT_DIR, 'meta.jsonl')
const LOG_FILE = path.join(OUT_DIR, 'autogen.log')
const GALLERY_FILE = path.join(OUT_DIR, 'gallery.html')
const PID_FILE = path.join(OUT_DIR, 'autogen.pid')

const DELAY_SEC = Number(process.env.DELAY_SEC || 3)
const MAX_STORAGE_GB = Number(process.env.MAX_STORAGE_GB || 30)
const INCLUDE_NSFW = process.env.INCLUDE_NSFW === '1'
const STEPS = Number(process.env.STEPS || 25)
const MEGAPIXELS = Number(process.env.MEGAPIXELS || 1.6875)
const REF_RESOLUTION = Number(process.env.REF_RESOLUTION || 1024)
const CACHE_DTYPE = process.env.CACHE_DTYPE || 'int8'
const TIMEOUT_SEC = Number(process.env.TIMEOUT_SEC || 600)
const MAX_IMAGES = Number(process.env.MAX_IMAGES || 0)

const MODELS = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_bf16.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
}

const NSFW_POSE_SYSTEMS = new Set(['全身单人・性感系', '双人缠绵'])
const NSFW_COSTUME_CATEGORIES = new Set(['内衣・睡衣', '性感穿搭'])

const STYLES = {
  realistic: '写实商业摄影级质感，85mm 人像镜头，自然柔和光影，真实肌肤纹理与织物细节，8k 高清画质。',
  fashion: '日韩时尚穿搭杂志画报风格，干净极简摄影棚背景，高级色调，突出人物颜值与服装剪裁。',
  film: '35mm 富士胶片摄影质感，轻微胶片颗粒，柔和复古暖调，自然街拍光影与电影呼吸感。',
  semi_real: '2.5D 半写实高精度游戏角色原画，唯美厚涂光影，精致五官与华丽布料金属质感。',
  anime: '日系精致二次元插画风格，细腻赛璐璐与厚涂光影过渡，动漫角色立绘质感，色彩通透干净。',
  cel_anime: '动画电影级画面质感，清澈高饱和光影，细腻体积光与发丝高光，干净唯美的动漫色彩。',
  manga: '日本黑白漫画原稿风格，利落精准的G笔线稿，细腻漫画网点纸阴影与层次对比。',
  render3d: 'Unreal Engine 5 / Octane Render 次世代 3D 角色渲染，细腻次表面散射肌肤材质，电影级布光。',
  chibi_box: '高品质 PVC 涂装完成品手办质感，柔和摄影棚柔光箱布光，精致材质高光与微距景深。',
  cyberpunk: '赛博朋克科幻视觉风格，雨夜霓虹冷暖双色轮廓光，未来感材质反光与电影级氛围。',
  concept_sheet: '标准角色设定集全身立绘，纯白干净无杂物背景，均匀漫反射布光，清晰展示全身服装结构与配饰细节。',
}
const PHOTO_STYLES = new Set(['realistic', 'fashion', 'film'])

const rand = (list) => list[Math.floor(Math.random() * list.length)]
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

// ComfyUI 侧输出目录：用于删除重复副本，避免 24/7 挂机时 output/autogen 无限膨胀
// （优先读 COMFY_OUTPUT_DIR；否则从 /system_stats 的 argv 自动识别 --output-directory）
let comfyOutputDir = COMFY_OUTPUT_DIR

function resolveComfyOutputDir(stats) {
  if (comfyOutputDir) return comfyOutputDir
  const argv = (stats && stats.system && stats.system.argv) || []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    let value = ''
    if (arg === '--output-directory') value = String(argv[i + 1] || '')
    else if (arg.startsWith('--output-directory=')) value = arg.slice('--output-directory='.length)
    if (value && path.isAbsolute(value)) {
      comfyOutputDir = path.normalize(value)
      log('ComfyUI 输出目录：' + comfyOutputDir + (KEEP_COMFY_COPIES ? '（保留副本）' : '（重复副本自动清理）'))
      return comfyOutputDir
    }
  }
  return null
}

// 启动/重连时清掉上一轮残留的重复副本（只动 output/autogen 下我们自己的 png）
function cleanupComfyCopies() {
  if (KEEP_COMFY_COPIES || !comfyOutputDir) return
  try {
    const dir = path.join(comfyOutputDir, 'autogen')
    if (!fs.existsSync(dir)) return
    let removed = 0
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.png')) continue
      try {
        fs.unlinkSync(path.join(dir, file))
        removed += 1
      } catch {
        /* ignore */
      }
    }
    if (removed > 0) log('已清理 ComfyUI output 中的重复副本 ' + removed + ' 张')
  } catch {
    /* ignore */
  }
}

// 下载完成后删掉 ComfyUI output 里的那份副本（本地 .auto-gen 已保留）
// Windows 上刚写出的文件可能被 Defender/索引器瞬时占用，失败时短暂重试几次；
// 实在删不掉也不影响出图，下一轮 generateOne 开头的 cleanupComfyCopies 会兜底清掉。
async function removeComfyCopy(image) {
  if (KEEP_COMFY_COPIES || !comfyOutputDir || !image || !image.filename) return
  const file = path.join(comfyOutputDir, image.subfolder || '', image.filename)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.unlinkSync(file)
      return
    } catch (e) {
      if (e && e.code === 'ENOENT') return
      await sleep(300)
    }
  }
  log('ComfyUI output 副本暂未删除，将在下一轮自动清理：' + image.filename)
}

function stamp() {
  return new Date().toISOString().slice(11, 19)
}

function log(message) {
  const line = stamp() + ' ' + message
  console.log(line)
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    /* ignore log write failures */
  }
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8'))
}

function assetPath(rel) {
  if (!rel) return null
  const abs = path.join(ROOT, rel)
  return fs.existsSync(abs) ? abs : null
}

const portraits = readJson('portrait-zh.json')
const costumes = readJson('costume-zh.json').filter((c) => INCLUDE_NSFW || !NSFW_COSTUME_CATEGORIES.has(c.分类))
const poses = readJson('pose-zh.json').filter((p) => INCLUDE_NSFW || !NSFW_POSE_SYSTEMS.has(p.体系))
log('素材池：人像 ' + portraits.length + ' 张 / 服装 ' + costumes.length + ' 套 / 姿势 ' + poses.length + ' 张（安全模式=' + (INCLUDE_NSFW ? '关' : '开') + '）')

function pickPortrait() {
  const item = rand(portraits)
  return { item: item, file: assetPath(item.原图) || assetPath(item.缩略图) }
}

function pickCostume() {
  const item = rand(costumes)
  return { item: item, file: assetPath(item.预览图) || assetPath(item.原图) || assetPath(item.缩略图) }
}

function pickPose() {
  const item = rand(poses)
  return { item: item, file: assetPath(item.原图) || assetPath(item.缩略图) }
}

function buildPrompt(portrait, costume, pose, styleKey) {
  const style = STYLES[styleKey]
  const isPhoto = PHOTO_STYLES.has(styleKey)
  const hairDesc = portrait.发型名称 && portrait.发型名称 !== '标准基础款' ? portrait.标题 : portrait.发长
  const lines = ['请根据提供的 3 张参考图，生成一张完整的' + (isPhoto ? '真实人物照片' : '人物图像') + '：']
  const isPairPose = Boolean(pose.体系 && pose.体系.includes('双人'))
  if (isPairPose && lines[0]) lines[0] = lines[0].replace('生成一张完整的', '生成一张包含两位人物的完整的')
  lines.push('• 人物：图1中的人物，保持其脸型、五官、发型（' + hairDesc + '）和发色一致。人物的肤色必须与图一人物一致，所有裸露皮肤（包括服装镂空处露出的皮肤）必须与脸部肤色统一，统一后的肤色与质感按风格要求呈现。')
  lines.push('• 服装：让人物穿上图2中展示的整套服装和配饰（参考名称：' + costume.服装名称 + '），每件单品的颜色、款式、面料与配饰都以图2为准，名称仅作辅助说明。')
  // 动漫库服装是 2D 线稿/插画：真人照片风格下转译为真实材质，避免「真人脸 + 动漫平涂服装」拼贴感
  if (costume.版本 === '二次元') {
    lines.push(
      isPhoto
        ? '• 动漫服装转译（重要）：图2 是二次元动漫风格的服装插画，仅用于参考套装的设计、配色、图案与配饰；请把它转译为真实面料、真实剪裁与自然褶皱的成品服装穿在人物身上，保留款式、颜色与配饰；不要保留动漫线稿、黑色描边、平涂色块或 2D 插画质感，也不要照搬图中人台的灰色假人肤色，整体以人物照片与画风要求为准。'
        : '• 动漫服装参考：图2 是二次元服装插画，仅参考款式、配色与配饰；请按当前画风统一渲染为服装成品，避免线稿拼贴感，不要照搬图中人台外观。'
    )
  }
  lines.push(
    isPairPose
      ? '• 姿势（双人）：图3 是双人姿势参考，画面中必须同时出现两位人物；严格按照图中两人的相对站位、肢体互动与镜头角度摆姿势（' + pose.姿势名称 + '，' + pose.角度 + '）；图3 只是动作示意，不要把两位人物合并成一个人、不要裁掉其中一人，' + (isPhoto ? '最终画面中的两位人物都是真人，皮肤真实自然' : '两位人物的肤色与质感按风格要求呈现') + '，都穿着图2的服装。'
      : '• 姿势：按照图3中人体模型的动作和镜头角度摆姿势（' + pose.姿势名称 + '，' + pose.角度 + '）；图3只是动作示意，' + (isPhoto ? '最终画面中的人物是真人，皮肤真实自然' : '人物的肤色与质感按风格要求呈现') + '，穿着图2的服装。'
  )
  if (isPairPose) {
    lines.push('• 双人构图（重要）：画面中必须同时出现两位成年女性人物，两人均完整入镜、不被裁切；两位人物的脸型、五官与发型均以图1为面部参考（可呈现为同一角色的两个角度或双胞胎设定，不要重复粘贴完全相同的脸）；两位人物都穿上图2展示的整套服装与配饰（同一套装扮，按两人分别自然贴合）；两人的身高与体型比例协调，肢体互动自然，手部与肢体互不粘连。')
  }
  // 3D 素体姿势自带夸张的「大头/长腿」比例，全身/双人姿势追加头身比约束
  if (pose.体系 && /全身|双人/.test(pose.体系)) {
    lines.push(
      isPhoto
        ? '• 人体比例（重要）：成年女性真实自然的全身比例（约 7~7.5 头身），头部不要偏大，头部大小与肩宽、胸腔、腰胯、四肢长度协调；避免大头小身、幼态娃娃比例、躯干过短或四肢过细；头顶与双脚均完整入镜、不被裁切，站姿与关节自然。'
        : '• 人体比例（重要）：成年角色自然比例（约 7~7.5 头身），头部不要偏大，避免大头小身 / 幼态比例，头部与躯干、四肢长度协调；按该画风的标准人物比例绘制，头顶与双脚完整入镜。'
    )
  }
  // 默认身材偏好：成年女性成熟匀称、胸部略丰满（不夸张、不低俗）
  lines.push(
    isPhoto
      ? '• 身材（默认偏好）：成年女性成熟匀称的身材，肩颈与腰胯曲线自然，胸部较丰满但不夸张、与服装版型自然贴合；不要幼态、过度瘦弱或比例失调的身材。'
      : '• 身材（默认偏好）：成年女性成熟匀称的身材，曲线自然，胸部较丰满但不夸张（符合该画风审美）；不要幼态、过度瘦弱或比例失调的身材。'
  )
  if (style) lines.push('• 风格：' + style + ' 人物比例协调，手部与五官自然，光影统一。')
  lines.push('画面中没有任何文字、标志或水印。')
  return lines.join('\n')
}

function buildWorkflow(params) {
  const wf = {
    '1': { inputs: { image: params.portrait, }, class_type: 'LoadImage', _meta: { title: '图1：人像参考 (Portrait)' } },
    '2': { inputs: { image: params.costume, }, class_type: 'LoadImage', _meta: { title: '图2：服装参考 (Costume)' } },
    '3': { inputs: { image: params.pose, }, class_type: 'LoadImage', _meta: { title: '图3：姿势参考 (Pose)' } },
    '4': { inputs: { unet_name: MODELS.unet, weight_dtype: 'default' }, class_type: 'UNETLoader', _meta: { title: '加载 Qwen Image 2.1 模型（本机 int8）' } },
    '6': { inputs: { device: 'auto', dtype: CACHE_DTYPE, model: ['4', 0] }, class_type: 'QwenImage21Cache', _meta: { title: 'Qwen Image 2.1 条件缓存' } },
    '7': { inputs: { clip_name: MODELS.clip, type: 'qwen_image', device: 'default' }, class_type: 'CLIPLoader', _meta: { title: '加载 Qwen3-VL 8B 编码器' } },
    '8': { inputs: { vae_name: MODELS.vae }, class_type: 'VAELoader', _meta: { title: '加载 Qwen Image 2.1 VAE' } },
    '9': {
      inputs: {
        prompt: params.prompt,
        negative_prompt: '',
        resolution: REF_RESOLUTION,
        clip: ['7', 0],
        vae: ['8', 0],
        'images.image_1': ['1', 0],
        'images.image_2': ['2', 0],
        'images.image_3': ['3', 0],
      },
      class_type: 'TextEncodeQwenImage21',
      _meta: { title: '提示词与多图参考编码 (Qwen 2.1)' },
    },
    '13': { inputs: { image: ['3', 0], upscale_method: 'lanczos', megapixels: MEGAPIXELS, resolution_steps: 32 }, class_type: 'ImageScaleToTotalPixels', _meta: { title: '按姿势图比例确定输出尺寸' } },
    '14': { inputs: { pixels: ['13', 0], vae: ['8', 0] }, class_type: 'VAEEncode', _meta: { title: '输出画布 Latent' } },
    '10': { inputs: { seed: params.seed, steps: STEPS, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0, model: ['6', 0], positive: ['9', 0], negative: ['9', 1], latent_image: ['14', 0] }, class_type: 'KSampler', _meta: { title: 'KSampler 采样器' } },
    '15': { inputs: { samples: ['10', 0], vae: ['8', 0] }, class_type: 'VAEDecode', _meta: { title: 'VAE 解码' } },
    '16': { inputs: { filename_prefix: 'autogen/auto', images: ['15', 0] }, class_type: 'SaveImage', _meta: { title: '保存生成结果' } },
  }
  return wf
}

async function comfy(pathname, init) {
  const res = await fetch(COMFY + pathname, init)
  return res
}

async function ensureComfy() {
  const res = await comfy('/system_stats')
  if (!res.ok) throw new Error('ComfyUI /system_stats HTTP ' + res.status)
  const json = await res.json()
  resolveComfyOutputDir(json)
  cleanupComfyCopies()
  return json
}

async function uploadImage(absPath, prefix) {
  const buf = fs.readFileSync(absPath)
  const ext = path.extname(absPath) || '.png'
  const form = new FormData()
  // 固定文件名 + overwrite：ComfyUI input 目录里每个槽位只保留 1 个文件，长期运行不会堆垃圾
  form.append('image', new Blob([buf]), prefix + ext)
  form.append('subfolder', 'autogen')
  form.append('overwrite', 'true')
  const res = await comfy('/upload/image', { method: 'POST', body: form })
  if (!res.ok) throw new Error('上传参考图失败 HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200))
  const json = await res.json()
  return json.subfolder ? json.subfolder + '/' + json.name : json.name
}

async function submitAndWait(workflow) {
  const res = await comfy('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'autogen-' + process.pid }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('提交工作流失败 HTTP ' + res.status + ' ' + text.slice(0, 800))
  const promptId = JSON.parse(text).prompt_id
  const started = Date.now()
  while (Date.now() - started < TIMEOUT_SEC * 1000) {
    await sleep(2000)
    const h = await comfy('/history/' + promptId)
    if (!h.ok) continue
    const hist = await h.json()
    const item = hist[promptId]
    if (!item) continue
    const status = item.status || {}
    if (status.status_str === 'error') {
      const messages = (status.messages || []).map((m) => JSON.stringify(m)).join('\n').slice(0, 1200)
      throw new Error('ComfyUI 执行出错：' + messages)
    }
    const images = []
    for (const nodeId of Object.keys(item.outputs || {})) {
      for (const image of item.outputs[nodeId].images || []) {
        images.push(image)
      }
    }
    if (images.length > 0) return images[0]
  }
  try { await comfy('/interrupt', { method: 'POST' }) } catch { /* ignore */ }
  throw new Error('等待生成超时（' + TIMEOUT_SEC + ' 秒）')
}

async function downloadImage(image) {
  const query = '?filename=' + encodeURIComponent(image.filename) + '&subfolder=' + encodeURIComponent(image.subfolder || '') + '&type=' + encodeURIComponent(image.type || 'output')
  const res = await comfy('/view' + query)
  if (!res.ok) throw new Error('下载生成结果失败 HTTP ' + res.status)
  return Buffer.from(await res.arrayBuffer())
}

function totalImagesBytes() {
  let total = 0
  const files = fs.readdirSync(IMAGE_DIR).filter((f) => f.endsWith('.png'))
  const entries = []
  for (const file of files) {
    try {
      const st = fs.statSync(path.join(IMAGE_DIR, file))
      entries.push({ file: file, size: st.size, mtime: st.mtimeMs })
      total += st.size
    } catch { /* ignore */ }
  }
  return { total: total, entries: entries }
}

function pruneIfNeeded() {
  const cap = MAX_STORAGE_GB * 1024 * 1024 * 1024
  const info = totalImagesBytes()
  if (info.total <= cap) return
  info.entries.sort((a, b) => a.mtime - b.mtime)
  let total = info.total
  let removed = 0
  for (const entry of info.entries) {
    if (total <= cap) break
    try {
      fs.unlinkSync(path.join(IMAGE_DIR, entry.file))
      total -= entry.size
      removed += 1
    } catch { /* ignore */ }
  }
  log('已清理旧图 ' + removed + ' 张，剩余约 ' + (total / 1024 ** 3).toFixed(2) + ' GB')
}

function writeGallery() {
  try {
    const files = fs.readdirSync(IMAGE_DIR).filter((f) => f.endsWith('.png')).sort().reverse().slice(0, 200)
    const cards = files.map((f) => '<figure><img loading="lazy" src="images/' + f + '" alt="' + f + '"><figcaption>' + f + '</figcaption></figure>').join('\n')
    const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>自动生成图库</title>' +
      '<style>body{background:#0b0b0f;color:#ddd;font:14px/1.5 system-ui;margin:24px}h1{font-size:18px}' +
      'main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}figure{margin:0;background:#16161c;border-radius:10px;overflow:hidden}' +
      'img{width:100%;display:block;aspect-ratio:3/4;object-fit:cover}figcaption{padding:6px 10px;font-size:11px;color:#888;word-break:break-all}</style></head>' +
      '<body><h1>自动生成图库（最新 ' + files.length + ' 张）</h1><main>' + cards + '</main></body></html>'
    fs.writeFileSync(GALLERY_FILE, html)
  } catch {
    /* ignore */
  }
}

let generated = 0

async function generateOne() {
  // 每次出图前清一次 ComfyUI output/autogen：正常情况为空；若上一轮进程被强杀，
  // ComfyUI 仍会跑完并在稍后写出副本，这里顺手清掉，避免残留长期堆积
  cleanupComfyCopies()
  const portrait = pickPortrait()
  const costume = pickCostume()
  const pose = pickPose()
  if (!portrait.file || !costume.file || !pose.file) throw new Error('参考图文件缺失：' + JSON.stringify({ p: portrait.file, c: costume.file, s: pose.file }))
  const styleKey = rand(Object.keys(STYLES))
  const seed = randInt(1, 2147483000)
  const prompt = buildPrompt(portrait.item, costume.item, pose.item, styleKey)

  log('开始：人像 ' + portrait.item.id + ' / 服装 ' + costume.item.id + ' / 姿势 ' + pose.item.id + ' / 风格 ' + styleKey + ' / seed ' + seed)
  const portraitName = await uploadImage(portrait.file, 'auto_portrait')
  const costumeName = await uploadImage(costume.file, 'auto_costume')
  const poseName = await uploadImage(pose.file, 'auto_pose')

  const workflow = buildWorkflow({ portrait: portraitName, costume: costumeName, pose: poseName, prompt: prompt, seed: seed })
  const startedAt = Date.now()
  const image = await submitAndWait(workflow)
  const buffer = await downloadImage(image)
  await removeComfyCopy(image)
  const elapsed = Math.round((Date.now() - startedAt) / 1000)

  const ms = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stampName = String(ms.getFullYear()) + pad(ms.getMonth() + 1) + pad(ms.getDate()) + '-' + pad(ms.getHours()) + pad(ms.getMinutes()) + pad(ms.getSeconds())
  const filename = 'auto-' + stampName + '-' + seed + '.png'
  fs.writeFileSync(path.join(IMAGE_DIR, filename), buffer)

  const meta = {
    time: new Date().toISOString(),
    file: 'images/' + filename,
    width: image.metadata ? image.metadata.width : null,
    height: image.metadata ? image.metadata.height : null,
    elapsedSec: elapsed,
    seed: seed,
    style: styleKey,
    steps: STEPS,
    megapixels: MEGAPIXELS,
    portrait: { id: portrait.item.id, 发型: portrait.item.发型名称, 发长: portrait.item.发长 },
    costume: { id: costume.item.id, 服装: costume.item.服装名称 },
    pose: { id: pose.item.id, 姿势: pose.item.姿势名称, 角度: pose.item.角度, 体系: pose.item.体系 },
    prompt: prompt,
  }
  fs.appendFileSync(META_FILE, JSON.stringify(meta) + '\n')
  generated += 1
  log('完成 #' + generated + ' ' + filename + ' ' + (meta.width || '?') + 'x' + (meta.height || '?') + ' 用时 ' + elapsed + 's')

  // 每张都刷新本地图库（.auto-gen/gallery.html），打开即可看到最新结果
  writeGallery()
  if (generated % 10 === 0) pruneIfNeeded()
}

async function main() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
  fs.writeFileSync(PID_FILE, String(process.pid))
  log('自动生成启动 pid=' + process.pid + ' ComfyUI=' + COMFY + ' 输出=' + OUT_DIR)
  log('参数：steps=' + STEPS + ' megapixels=' + MEGAPIXELS + ' refResolution=' + REF_RESOLUTION + ' cacheDtype=' + CACHE_DTYPE + ' 间隔=' + DELAY_SEC + 's 容量上限=' + MAX_STORAGE_GB + 'GB')
  let comfyDownLogged = false
  while (true) {
    try {
      if (!comfyDownLogged) {
        const stats = await ensureComfy()
        const dev = stats.devices && stats.devices[0]
        log('ComfyUI 在线 ' + (stats.system ? stats.system.comfyui_version : '?') + (dev ? ' / ' + dev.name : ''))
        comfyDownLogged = true
      }
      await generateOne()
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      log('错误：' + message.slice(0, 900))
      if (/ECONNREFUSED|fetch failed|system_stats|HTTP 502|HTTP 503/.test(message)) {
        comfyDownLogged = false
        log('ComfyUI 可能未启动，60 秒后重试')
        await sleep(60000)
      } else {
        await sleep(10000)
      }
    }
    if (MAX_IMAGES > 0 && generated >= MAX_IMAGES) {
      log('已达到 MAX_IMAGES=' + MAX_IMAGES + '，退出')
      process.exit(0)
    }
    await sleep(DELAY_SEC * 1000)
  }
}

main().catch((error) => {
  log('主进程异常退出：' + (error && error.stack ? error.stack : String(error)))
  process.exit(1)
})
