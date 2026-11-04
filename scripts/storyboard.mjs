#!/usr/bin/env node
/**
 * 分镜短片流水线：站点三图关键帧 → H3 首尾帧视频 → 拼接成片
 *
 * 输出：
 *   .auto-gen/storyboard/keyframes/KF*.png     关键帧（1152x1536）
 *   .auto-gen/storyboard/clips/*.mp4           每镜头视频（768x1024，24fps，带立体声）
 *   .auto-gen/videos/film_A_15s.mp4            第一段 15.0s
 *   .auto-gen/videos/film_B_15s.mp4            第二段 15.0s（与 A 结尾共用同一关键帧，可直接接）
 *   .auto-gen/videos/film_AB_30s.mp4           A+B 合并 30.0s
 *
 * 运行： node scripts/storyboard.mjs
 * 依赖：本机 ComfyUI 在 8188；ComfyUI venv 的 python（见 COMFY_PY 环境变量）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const COMFY = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
const OUT = path.join(ROOT, '.auto-gen', 'storyboard')
const KF_DIR = path.join(OUT, 'keyframes')
const CLIP_DIR = path.join(OUT, 'clips')
const FILM_DIR = path.join(ROOT, '.auto-gen', 'videos')
const LOG_FILE = path.join(OUT, 'pipeline.log')
const COMFY_PY = process.env.COMFY_PY || 'C:\\Users\\Administrator\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Installs\\h3\\ComfyUI\\.venv\\Scripts\\python.exe'

const WIDTH = 768
const HEIGHT = 1024
const FPS = 24
const H3_STEPS = 8
const KEYFRAME_STEPS = 25

const log = (...args) => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + args.join(' ')
  console.log(line)
  try { fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
const portraits = readJson(path.join(ROOT, 'data', 'portrait-zh.json'))
const costumes = readJson(path.join(ROOT, 'data', 'costume-zh.json'))
const poses = readJson(path.join(ROOT, 'data', 'pose-zh.json'))
const byId = (list, id) => list.find((x) => x.id === id)

function assetPath(...candidates) {
  for (const rel of candidates) {
    if (!rel) continue
    const abs = path.join(ROOT, rel)
    if (fs.existsSync(abs)) return abs
  }
  return null
}

// ---------- 分镜配置 ----------
const CHARACTER = { portraitId: 'f000a1c4200', costumeId: 'AUT-0001' }

// 关键帧：同一角色/服装，换姿势（姿势库 id 见 data/pose-zh.json）
const KEYFRAMES = [
  { id: 'KF1', poseId: 'full_single_P017_front', note: '开场：回眸站姿' },
  { id: 'KF2', poseId: 'full_single_P016_front', note: '转身撩发' },
  { id: 'KF3', poseId: 'upper80v2_P001_front', note: '中段：双手比心' },
  { id: 'KF4', poseId: 'upper80v2_P008_front', note: 'A 收尾：猫爪挥手' },
  { id: 'KF5', poseId: 'full_single_P073_front', note: 'B 开场：挺背站姿' },
  { id: 'KF6', poseId: 'full_single_P041_front', note: 'B 中段：坐姿' },
  { id: 'KF7', poseId: 'upper80v2_P003_front', note: 'B 收尾：脸侧比心' },
]

// 镜头：124 帧 = 5.17s，107 帧 = 4.46s，总计 355 帧 + 末帧定格 5 帧 = 360 帧 = 15.0s
const SHOTS = [
  {
    id: 'A1', first: 'KF1', last: 'KF2', frames: 124,
    prompt: 'Cinematic vertical fashion film. The same young woman as in the first frame: long light-brown layered hair, a burgundy puff-sleeve blouse with a large bow at the collar, brown flared jeans, fur-trimmed beige platform boots, a small brown plaid shoulder bag. She stands in a bright cream studio with a soft window shadow on the wall, slowly turns from a glance over her shoulder to face the camera, hair swaying, natural smile. Camera: slow push-in from full body to medium shot, subtle handheld drift. Audio: soft piano arpeggio, quiet studio room tone. Keep her face, hair and outfit identical to the first frame; do not change her clothes. Photorealistic, shallow depth of field, 24fps.',
  },
  {
    id: 'A2', first: 'KF2', last: 'KF3', frames: 124,
    prompt: 'Same young woman as the first frame, same long light-brown hair, same burgundy puff-sleeve bow blouse, brown flared jeans, fur-trimmed platform boots and plaid shoulder bag, same bright cream studio and window shadow. She lifts both hands to her chest and makes a small heart shape with her fingers, smiling warmly, then holds the pose. Camera: slow push-in to a medium close-up, shallow depth of field. Audio: warm piano continues, soft room tone. Do not change her face, hair, outfit or the background. Photorealistic, cinematic, 24fps.',
  },
  {
    id: 'A3', first: 'KF3', last: 'KF4', frames: 107,
    prompt: 'Same young woman and same outfit as the first frame (burgundy puff-sleeve blouse with bow, brown flared jeans, plaid shoulder bag), same cream studio. She playfully lifts one hand in a soft cat-paw wave beside her face, laughs gently, then settles into a warm smiling pose looking at the camera. Camera: static medium close-up with a slight drift in. Audio: gentle piano phrase ending, soft room tone. Keep identity, hair and outfit unchanged.',
  },
  {
    id: 'B1', first: 'KF4', last: 'KF5', frames: 107,
    prompt: 'Same young woman and same outfit as the first frame, same bright cream studio with a soft window shadow on the wall. She lowers her hand, turns and walks toward the camera, camera slowly pulls back from medium close-up to full body, warm afternoon light, soft shadows. Audio: soft piano continuation, quiet footsteps, room tone. Keep her face, hair, clothes and the plain studio background identical to the first frame; do not change the outfit or the setting.',
  },
  {
    id: 'B2', first: 'KF5', last: 'KF6', frames: 124,
    prompt: 'Same woman, same burgundy puff-sleeve bow blouse, brown flared jeans, fur-trimmed platform boots and plaid shoulder bag, same sunlit cream studio. She reaches the window seat and sits down gracefully, then looks out of the window with a soft smile. Camera: smooth lateral dolly following her, settles into a medium-wide shot. Audio: piano, faint birdsong outside, room tone. Do not change her identity or outfit.',
  },
  {
    id: 'B3', first: 'KF6', last: 'KF7', frames: 124,
    prompt: 'Same woman as the first frame, same long light-brown hair and burgundy bow blouse, in the same bright cream studio. She smiles at the camera and makes a small finger-heart beside her cheek, then holds the warm expression as the camera slowly pushes in. Audio: warm piano resolves, soft room tone, gentle final chord. Keep identity, hair, outfit and the plain studio background unchanged; no text or subtitles.',
  },
]

const FILMS = [
  { id: 'A', label: '第一段 15s（开场→中段→收尾）', shots: ['A1', 'A2', 'A3'], output: path.join(FILM_DIR, 'film_A_15s.mp4'), targetFrames: 360 },
  { id: 'B', label: '第二段 15s（续接 A 结尾→坐姿→收尾）', shots: ['B1', 'B2', 'B3'], output: path.join(FILM_DIR, 'film_B_15s.mp4'), targetFrames: 360 },
]

// ---------- HTTP 工具 ----------
async function comfy(pathname, init) {
  const res = await fetch(COMFY + pathname, init)
  return res
}
async function uploadImage(absPath, name) {
  const buf = fs.readFileSync(absPath)
  const ext = path.extname(absPath) || '.png'
  const form = new FormData()
  form.append('image', new Blob([buf]), name + ext)
  form.append('subfolder', 'storyboard')
  form.append('overwrite', 'true')
  const res = await comfy('/upload/image', { method: 'POST', body: form })
  if (!res.ok) throw new Error('上传失败 ' + absPath + ' HTTP ' + res.status)
  const json = await res.json()
  return json.subfolder ? json.subfolder + '/' + json.name : json.name
}
async function submitWorkflow(wf, label) {
  const res = await comfy('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'storyboard-' + process.pid }) })
  const text = await res.text()
  if (!res.ok) throw new Error(label + ' 提交失败 HTTP ' + res.status + ' ' + text.slice(0, 1200))
  return JSON.parse(text).prompt_id
}
async function waitHistory(promptId, timeoutSec) {
  const started = Date.now()
  let lastLog = 0
  while (Date.now() - started < timeoutSec * 1000) {
    await sleep(3000)
    const res = await comfy('/history/' + promptId)
    if (!res.ok) continue
    const hist = await res.json()
    const item = hist[promptId]
    if (!item) {
      if (Date.now() - lastLog > 30000) { lastLog = Date.now(); log('  ...仍在生成（' + Math.round((Date.now() - started) / 1000) + 's）') }
      continue
    }
    if (item.status && item.status.status_str === 'error') {
      throw new Error('ComfyUI 执行出错：' + JSON.stringify(item.status.messages || []).slice(0, 1500))
    }
    const images = []
    for (const nodeId of Object.keys(item.outputs || {})) {
      for (const key of Object.keys(item.outputs[nodeId] || {})) {
        const arr = item.outputs[nodeId][key]
        if (Array.isArray(arr)) for (const it of arr) if (it && it.filename) images.push(it)
      }
    }
    if (images.length) return { images, elapsedSec: Math.round((Date.now() - started) / 1000) }
  }
  throw new Error('等待超时 ' + timeoutSec + 's')
}
async function downloadOutput(item, target) {
  const query = '?filename=' + encodeURIComponent(item.filename) + '&subfolder=' + encodeURIComponent(item.subfolder || '') + '&type=' + encodeURIComponent(item.type || 'output')
  const res = await comfy('/view' + query)
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buf)
  return buf.length
}

// ---------- 关键帧（Qwen-Image 2.1 三图） ----------
function buildKeyframeWorkflow(cfg) {
  return {
    '1': { inputs: { image: cfg.portrait }, class_type: 'LoadImage', _meta: { title: '图1：人像参考' } },
    '2': { inputs: { image: cfg.costume }, class_type: 'LoadImage', _meta: { title: '图2：服装参考' } },
    '3': { inputs: { image: cfg.pose }, class_type: 'LoadImage', _meta: { title: '图3：姿势参考' } },
    '4': { inputs: { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' }, class_type: 'UNETLoader' },
    '6': { inputs: { device: 'auto', dtype: 'int8', model: ['4', 0] }, class_type: 'QwenImage21Cache' },
    '7': { inputs: { clip_name: 'qwen3vl_8b_bf16.safetensors', type: 'qwen_image', device: 'default' }, class_type: 'CLIPLoader' },
    '8': { inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' }, class_type: 'VAELoader' },
    '9': {
      inputs: {
        prompt: cfg.prompt, negative_prompt: '', resolution: 1024,
        clip: ['7', 0], vae: ['8', 0],
        'images.image_1': ['1', 0], 'images.image_2': ['2', 0], 'images.image_3': ['3', 0],
      },
      class_type: 'TextEncodeQwenImage21',
    },
    '13': { inputs: { image: ['3', 0], upscale_method: 'lanczos', megapixels: 1.6875, resolution_steps: 32 }, class_type: 'ImageScaleToTotalPixels' },
    '14': { inputs: { pixels: ['13', 0], vae: ['8', 0] }, class_type: 'VAEEncode' },
    '10': { inputs: { seed: cfg.seed, steps: KEYFRAME_STEPS, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0, model: ['6', 0], positive: ['9', 0], negative: ['9', 1], latent_image: ['14', 0] }, class_type: 'KSampler' },
    '11': { inputs: { samples: ['10', 0], vae: ['8', 0] }, class_type: 'VAEDecode' },
    '12': { inputs: { filename_prefix: 'storyboard/keyframe', images: ['11', 0] }, class_type: 'SaveImage' },
  }
}

function buildKeyframePrompt(portrait, costume, pose) {
  const hairDesc = portrait.发型名称 && portrait.发型名称 !== '标准基础款' ? portrait.标题 : portrait.发长
  const lines = [
    '请根据提供的 3 张参考图，生成一张完整的真实人物照片：',
    '• 人物：图1中的人物，保持其脸型、五官、发型（' + hairDesc + '）和发色一致。人物的肤色必须与图一人物一致，所有裸露皮肤（包括服装镂空处露出的皮肤）必须与脸部肤色统一，统一后的肤色与质感按风格要求呈现。',
    '• 服装：让人物穿上图2中展示的整套服装和配饰（参考名称：' + costume.服装名称 + '），每件单品的颜色、款式、面料与配饰都以图2为准，名称仅作辅助说明。',
    '• 姿势：按照图3中人体模型的动作和镜头角度摆姿势（' + pose.姿势名称 + '，' + pose.角度 + '）；图3只是动作示意，最终画面中的人物是真人，皮肤真实自然，穿着图2的服装。',
    '• 风格：写实商业摄影级质感，85mm 人像镜头，自然柔和光影，真实肌肤纹理与织物细节，8k 高清画质。 人物比例协调，手部与五官自然，光影统一。',
    '画面中没有任何文字、标志或水印。',
  ]
  return lines.join('\n')
}

async function ensureKeyframe(kf) {
  const target = path.join(KF_DIR, kf.id + '.png')
  if (fs.existsSync(target) && fs.statSync(target).size > 10000) {
    log('[关键帧] ' + kf.id + ' 已存在，跳过')
    return target
  }
  const portrait = byId(portraits, CHARACTER.portraitId)
  const costume = byId(costumes, CHARACTER.costumeId)
  const pose = byId(poses, kf.poseId)
  if (!portrait || !costume || !pose) throw new Error('素材 id 找不到：' + JSON.stringify({ portrait: CHARACTER.portraitId, costume: CHARACTER.costumeId, pose: kf.poseId }))
  log('[关键帧] ' + kf.id + ' 生成中（姿势 ' + pose.姿势名称 + ' / ' + kf.note + '）')
  const portraitFile = assetPath(portrait.原图, portrait.缩略图)
  const costumeFile = assetPath(costume.预览图, costume.原图, costume.缩略图)
  const poseFile = assetPath(pose.原图, pose.缩略图)
  if (!portraitFile || !costumeFile || !poseFile) throw new Error('参考图文件缺失：' + JSON.stringify({ portraitFile, costumeFile, poseFile }))
  const portraitName = await uploadImage(portraitFile, 'kf_portrait')
  const costumeName = await uploadImage(costumeFile, 'kf_costume')
  const poseName = await uploadImage(poseFile, 'kf_pose')
  const wf = buildKeyframeWorkflow({
    portrait: portraitName, costume: costumeName, pose: poseName,
    prompt: buildKeyframePrompt(portrait, costume, pose),
    seed: Math.floor(Math.random() * 1000000),
  })
  const promptId = await submitWorkflow(wf, '关键帧 ' + kf.id)
  const result = await waitHistory(promptId, 600)
  const size = await downloadOutput(result.images[0], target)
  log('[关键帧] ' + kf.id + ' 完成 ' + result.elapsedSec + 's ' + Math.round(size / 1024) + 'KB')
  return target
}

// ---------- H3 镜头 ----------
const H3_TEMPLATE = readJson(path.join(ROOT, 'scripts', 'workflows', 'h3_i2v.api.json'))

function buildShotWorkflow(cfg) {
  const wf = JSON.parse(JSON.stringify(H3_TEMPLATE))
  wf['6'].inputs.image = cfg.first
  if (cfg.last) wf['6b'].inputs.image = cfg.last
  else delete wf['6b']
  wf['7'].inputs.prompt = cfg.prompt
  wf['7'].inputs.width = WIDTH
  wf['7'].inputs.height = HEIGHT
  wf['7'].inputs.length = cfg.frames
  if (!cfg.last) delete wf['7'].inputs.last_frame
  wf['10'].inputs.steps = H3_STEPS
  wf['11'].inputs.noise_seed = cfg.seed
  wf['16'].inputs.filename_prefix = 'storyboard/' + cfg.id
  return wf
}

async function ensureShot(shot) {
  const target = path.join(CLIP_DIR, shot.id + '.mp4')
  if (fs.existsSync(target) && fs.statSync(target).size > 50000) {
    log('[镜头] ' + shot.id + ' 已存在，跳过')
    return target
  }
  const firstPath = path.join(KF_DIR, shot.first + '.png')
  const lastPath = shot.last ? path.join(KF_DIR, shot.last + '.png') : null
  for (const p of [firstPath, lastPath]) if (p && !fs.existsSync(p)) throw new Error('缺少关键帧：' + p)
  log('[镜头] ' + shot.id + ' 生成中（' + shot.first + (shot.last ? ' → ' + shot.last : '') + '，' + shot.frames + ' 帧）')
  const first = await uploadImage(firstPath, 'shot_' + shot.id + '_first')
  const last = lastPath ? await uploadImage(lastPath, 'shot_' + shot.id + '_last') : null
  const wf = buildShotWorkflow({ id: shot.id, first, last, prompt: shot.prompt, frames: shot.frames, seed: Math.floor(Math.random() * 1000000) })
  const promptId = await submitWorkflow(wf, '镜头 ' + shot.id)
  const result = await waitHistory(promptId, 1500)
  const videoItem = result.images[0]
  const size = await downloadOutput(videoItem, target)
  const frames = videoItem.metadata && videoItem.metadata.frame_count
  log('[镜头] ' + shot.id + ' 完成 ' + result.elapsedSec + 's ' + Math.round(size / 1024) + 'KB 帧数=' + (frames || shot.frames))
  return target
}

// ---------- 拼接 ----------
function stitch(spec) {
  const specPath = path.join(OUT, 'stitch_' + path.basename(spec.output, '.mp4') + '.json')
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2))
  const r = spawnSync(COMFY_PY, [path.join(ROOT, 'scripts', 'stitch_videos.py'), specPath], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('拼接失败：' + (r.stderr || r.stdout || '').slice(0, 1500))
  log('[拼接] ' + spec.output + ' ← ' + r.stdout.trim().slice(0, 400))
}

function ensureFilm(film, shotFiles) {
  if (fs.existsSync(film.output) && fs.statSync(film.output).size > 100000) {
    log('[成片] ' + film.id + ' 已存在，跳过')
    return film.output
  }
  const shots = film.shots.map((id) => SHOTS.find((s) => s.id === id))
  const total = shots.reduce((n, s) => n + s.frames, 0)
  const hold = Math.max(0, film.targetFrames - total)
  log('[成片] ' + film.id + ' 拼接：' + shots.map((s) => s.id + '(' + s.frames + 'f)').join(' + ') + ' + 定格 ' + hold + 'f = ' + film.targetFrames + 'f')
  stitch({
    fps: FPS, audio_rate: 32000, output: film.output,
    segments: shots.map((s) => ({ file: shotFiles[s.id], frames: s.frames })),
    hold_last_frames: hold,
  })
  return film.output
}

function ensureMerged(filmA, filmB) {
  const target = path.join(FILM_DIR, 'film_AB_30s.mp4')
  if (fs.existsSync(target) && fs.statSync(target).size > 200000) { log('[成片] AB 已存在，跳过'); return target }
  stitch({
    fps: FPS, audio_rate: 32000, output: target,
    segments: [{ file: filmA, frames: 360 }, { file: filmB, frames: 360 }],
    hold_last_frames: 0,
  })
  return target
}

// ---------- 主流程 ----------
async function main() {
  fs.mkdirSync(KF_DIR, { recursive: true })
  fs.mkdirSync(CLIP_DIR, { recursive: true })
  fs.mkdirSync(FILM_DIR, { recursive: true })
  const t0 = Date.now()
  log('分镜流水线开始：' + FILMS.map((f) => f.id).join('+') + '，镜头 ' + SHOTS.length + ' 个，关键帧 ' + KEYFRAMES.length + ' 张')

  const stats = await (await comfy('/system_stats')).json()
  log('ComfyUI ' + stats.system.comfyui_version + ' / ' + (stats.devices[0] && stats.devices[0].name))

  for (const kf of KEYFRAMES) await ensureKeyframe(kf)
  const shotFiles = {}
  const filmFiles = {}
  // 按片顺序生成：A 的三镜完成就先拼 A，B 继续，最后合成 30s
  for (const film of FILMS) {
    for (const id of film.shots) {
      const shot = SHOTS.find((s) => s.id === id)
      shotFiles[id] = await ensureShot(shot)
    }
    filmFiles[film.id] = ensureFilm(film, shotFiles)
  }
  const filmA = filmFiles['A']
  const filmB = filmFiles['B']
  const merged = ensureMerged(filmA, filmB)

  const storyboard = {
    generatedAt: new Date().toISOString(),
    totalMin: Math.round((Date.now() - t0) / 60000),
    character: { portraitId: CHARACTER.portraitId, costumeId: CHARACTER.costumeId },
    keyframes: KEYFRAMES.map((kf) => ({ id: kf.id, poseId: kf.poseId, note: kf.note, file: path.relative(ROOT, path.join(KF_DIR, kf.id + '.png')) })),
    shots: SHOTS.map((s) => ({ id: s.id, first: s.first, last: s.last, frames: s.frames, prompt: s.prompt, file: path.relative(ROOT, path.join(CLIP_DIR, s.id + '.mp4')) })),
    films: [
      { id: 'A', durationSec: 15, file: path.relative(ROOT, filmA) },
      { id: 'B', durationSec: 15, file: path.relative(ROOT, filmB) },
      { id: 'AB', durationSec: 30, file: path.relative(ROOT, merged) },
    ],
  }
  fs.writeFileSync(path.join(OUT, 'storyboard.generated.json'), JSON.stringify(storyboard, null, 2))
  log('全部完成，用时 ' + Math.round((Date.now() - t0) / 60000) + ' 分钟')
  log('成片：' + [filmA, filmB, merged].join(' | '))
}

main().catch((error) => {
  log('流水线失败：' + (error && error.stack ? error.stack : String(error)))
  process.exit(1)
})
