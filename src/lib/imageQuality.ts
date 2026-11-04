// ============================================================================
// 生图质量检测：纯前端 Canvas 启发式检测（模糊 / 空白 / 过暗过曝 / 低清 / 画幅异常）
// - 用于定时任务自动出图前的「质量门槛」：不达标直接丢弃并重抽，不写入历史、不落盘
// - 说明：无法识别「人体比例/手指畸形」这类语义问题（那部分通过提示词与工作流约束优化）
// ============================================================================

export interface ImageQualityMetrics {
  width: number
  height: number
  /** 拉普拉斯方差：越低越模糊 */
  sharpness: number
  /** 灰度标准差：过低说明空白/无对比 */
  contrast: number
  /** 平均亮度 0-255 */
  brightness: number
  /** 边缘像素占比 0-1 */
  edgeRatio: number
}

export interface ImageQualityResult {
  ok: boolean
  score: number
  reasons: string[]
  metrics: ImageQualityMetrics
}

const MIN_SIDE = 480
const MIN_SHARPNESS = 60
const MIN_CONTRAST = 8
const MIN_EDGE_RATIO = 0.03
const MIN_BRIGHTNESS = 12
const MAX_BRIGHTNESS = 250

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const timer = window.setTimeout(() => reject(new Error('质量检测：加载图片超时')), 15000)
    img.onload = () => {
      window.clearTimeout(timer)
      resolve(img)
    }
    img.onerror = () => {
      window.clearTimeout(timer)
      reject(new Error('质量检测：图片加载失败'))
    }
    img.src = src
  })
}

/**
 * 检测生成图质量。
 * @param src 生成结果（dataURL 或 http(s) 地址）
 * @returns ok=false 时 reasons 为中文原因列表
 */
export async function checkImageQuality(src: string): Promise<ImageQualityResult> {
  const img = await loadImage(src)
  const width = img.naturalWidth
  const height = img.naturalHeight

  // 缩小到最长边 320 后统计，兼顾速度与稳定性
  const scale = Math.min(1, 320 / Math.max(width, height))
  const w = Math.max(8, Math.round(width * scale))
  const h = Math.max(8, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('质量检测：无法创建 Canvas')
  ctx.drawImage(img, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)

  const gray = new Float32Array(w * h)
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < w * h; i += 1) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    const v = 0.299 * r + 0.587 * g + 0.114 * b
    gray[i] = v
    sum += v
    sumSq += v * v
  }
  const n = w * h
  const mean = sum / n
  const contrast = Math.sqrt(Math.max(0, sumSq / n - mean * mean))

  // 拉普拉斯方差（4 邻域）
  let lapSum = 0
  let lapSq = 0
  let lapCount = 0
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      lapSum += lap
      lapSq += lap * lap
      lapCount += 1
    }
  }
  const sharpness = lapCount > 0 ? Math.max(0, lapSq / lapCount - (lapSum / lapCount) ** 2) : 0

  // Sobel 边缘占比
  let edgeCount = 0
  let edgeTotal = 0
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x
      const gx = gray[i - w + 1] - gray[i - w - 1] + 2 * (gray[i + 1] - gray[i - 1]) + gray[i + w + 1] - gray[i + w - 1]
      const gy = gray[i + w - 1] - gray[i - w - 1] + 2 * (gray[i + w] - gray[i - w]) + gray[i + w + 1] - gray[i - w + 1]
      if (Math.hypot(gx, gy) > 40) edgeCount += 1
      edgeTotal += 1
    }
  }
  const edgeRatio = edgeTotal > 0 ? edgeCount / edgeTotal : 0

  const reasons: string[] = []
  if (Math.min(width, height) < MIN_SIDE) reasons.push('分辨率过低')
  if (sharpness < MIN_SHARPNESS) reasons.push('画面模糊 / 细节不足')
  if (contrast < MIN_CONTRAST) reasons.push('画面空白或对比过低')
  if (mean < MIN_BRIGHTNESS) reasons.push('画面过暗')
  if (mean > MAX_BRIGHTNESS) reasons.push('画面过曝')
  if (edgeRatio < MIN_EDGE_RATIO) reasons.push('缺少有效画面细节')
  const ratio = width / Math.max(1, height)
  if (ratio < 0.4 || ratio > 2.5) reasons.push('画幅比例异常')

  const metrics: ImageQualityMetrics = {
    width,
    height,
    sharpness: Math.round(sharpness * 10) / 10,
    contrast: Math.round(contrast * 10) / 10,
    brightness: Math.round(mean * 10) / 10,
    edgeRatio: Math.round(edgeRatio * 10000) / 10000,
  }

  let score = 100
  score -= Math.min(40, Math.max(0, (MIN_SHARPNESS - sharpness) / MIN_SHARPNESS) * 40)
  score -= Math.min(25, Math.max(0, (MIN_CONTRAST - contrast) / MIN_CONTRAST) * 25)
  score -= Math.min(20, Math.max(0, (MIN_EDGE_RATIO - edgeRatio) / MIN_EDGE_RATIO) * 20)
  if (reasons.includes('分辨率过低')) score -= 25
  if (reasons.includes('画幅比例异常')) score -= 10
  score = Math.max(0, Math.min(100, Math.round(score)))

  return { ok: reasons.length === 0, score, reasons, metrics }
}

export function formatQualityReasons(result: ImageQualityResult): string {
  return result.reasons.length ? result.reasons.join('、') : '未通过质量检测'
}
