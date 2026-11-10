#!/usr/bin/env node
/**
 * Codex 本地生图网关（OpenAI 兼容）
 *
 * 复刻 sub2api 的 Codex 图片路径：读取本机 Codex CLI 的 OAuth 凭据（~/.codex/auth.json），
 * 直接调用 ChatGPT Codex 图片端点，并把结果包装成 OpenAI `/v1/images/*` 协议，
 * 供 ai-pose-gallery（OpenAI GPT Image provider）使用。
 *
 * 端点：
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/images/generations   (JSON)
 *   POST /v1/images/edits         (JSON 或 multipart/form-data，支持 image[] / image / images)
 *
 * 启动：
 *   node scripts/codex-image-gateway.mjs
 *   （可选）CODEX_IMAGE_GATEWAY_PORT=8787 CODEX_IMAGE_MODEL=gpt-image-2.5-flare
 *   （可选）CODEX_IMAGE_GATEWAY_KEY=sk-xxx 要求客户端携带该 Bearer key
 *   （代理）先设置 HTTPS_PROXY 并让 Node 使用它：NODE_USE_ENV_PROXY=1 node ...
 *
 * 说明：单账号、无数据库/计费；多账号/配额/故障转移请用 sub2api（https://github.com/Wei-Shaw/sub2api）。
 * 使用订阅账号调用内部接口可能违反服务条款，风险自负。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.CODEX_IMAGE_GATEWAY_PORT || 8788)
const HOST = process.env.CODEX_IMAGE_GATEWAY_HOST || '127.0.0.1'
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const AUTH_PATH = path.join(CODEX_HOME, 'auth.json')
const GATEWAY_KEY = (process.env.CODEX_IMAGE_GATEWAY_KEY || '').trim()
const DEFAULT_MODEL = (process.env.CODEX_IMAGE_MODEL || 'gpt-image-2.6').trim()
const UPSTREAM_BASE = 'https://chatgpt.com/backend-api/codex'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OAUTH_REFRESH_SCOPE = 'openid profile email'
const CLIENT_VERSION = process.env.CODEX_IMAGE_CLIENT_VERSION || '0.146.0'
const USER_AGENT = `codex_cli_rs/${CLIENT_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`
const MAX_BODY_BYTES = 60 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = Number(process.env.CODEX_IMAGE_TIMEOUT_MS || 300000)

const MODELS = [
  'gpt-image-2.6',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare-2026-09-08',
  'gpt-image-2.5-sunburst-2026-09-08',
  'gpt-image-2',
  'gpt-image-1.5',
]

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args)

function readAuth() {
  const raw = fs.readFileSync(AUTH_PATH, 'utf8')
  const auth = JSON.parse(raw)
  const tokens = auth.tokens || {}
  if (!tokens.access_token || !tokens.account_id) {
    throw new Error(`Codex 凭据缺少 access_token / account_id：${AUTH_PATH}（请先 codex login）`)
  }
  return { auth, tokens }
}

function writeAuth(auth) {
  const raw = JSON.stringify(auth, null, 2)
  const tmp = `${AUTH_PATH}.gateway-${process.pid}.tmp`
  fs.writeFileSync(tmp, raw, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, AUTH_PATH)
}

function parseJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1]
    if (!part) return null
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function authInfo() {
  const { auth, tokens } = readAuth()
  const claims = parseJwtPayload(tokens.id_token) || {}
  const openaiAuth = claims['https://api.openai.com/auth'] || {}
  return {
    auth_mode: auth.auth_mode || '',
    account_id: tokens.account_id || '',
    account_masked: tokens.account_id ? `${String(tokens.account_id).slice(0, 8)}…` : '',
    email: openaiAuth.email || claims.email || '',
    plan_type: openaiAuth.chatgpt_plan_type || '',
    last_refresh: auth.last_refresh || '',
    access_token_exp: claims.exp ? new Date(claims.exp * 1000).toISOString() : '',
  }
}

let refreshing = null
async function refreshAccessToken() {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const { auth, tokens } = readAuth()
    if (!tokens.refresh_token) throw new Error('Codex access_token 已过期且没有 refresh_token')
    log('access_token 已过期，正在刷新…')
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: OAUTH_CLIENT_ID,
      scope: OAUTH_REFRESH_SCOPE,
    })
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(60000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`刷新 Codex 凭据失败（HTTP ${res.status}）：${text.slice(0, 400)}`)
    const json = JSON.parse(text)
    if (!json.access_token) throw new Error('刷新 Codex 凭据失败：响应无 access_token')
    tokens.access_token = json.access_token
    if (json.refresh_token) tokens.refresh_token = json.refresh_token
    if (json.id_token) tokens.id_token = json.id_token
    auth.tokens = tokens
    auth.last_refresh = new Date().toISOString()
    writeAuth(auth)
    log('Codex 凭据已刷新')
    return readAuth().tokens
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

async function upstreamFetch(endpoint, payload, retried = false) {
  let tokens
  try {
    tokens = readAuth().tokens
  } catch (err) {
    throw Object.assign(new Error(err.message), { statusCode: 500 })
  }
  const res = await fetch(`${UPSTREAM_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'chatgpt-account-id': tokens.account_id,
      'content-type': 'application/json',
      accept: 'application/json',
      originator: 'codex_cli_rs',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  const text = await res.text()
  if ((res.status === 401 || res.status === 403) && !retried) {
    try {
      await refreshAccessToken()
      return upstreamFetch(endpoint, payload, true)
    } catch (err) {
      throw Object.assign(new Error(err.message), { statusCode: 401 })
    }
  }
  if (!res.ok) {
    let message = text.slice(0, 800)
    try {
      const j = JSON.parse(text)
      message = j?.error?.message || j?.message || message
    } catch {}
    throw Object.assign(new Error(`Codex 上游图片接口失败（HTTP ${res.status}）：${message}`), { statusCode: res.status })
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw Object.assign(new Error(`Codex 上游返回非 JSON：${text.slice(0, 300)}`), { statusCode: 502 })
  }
  return json
}

function imageResults(json) {
  const data = Array.isArray(json?.data) ? json.data : []
  const results = []
  for (const item of data) {
    const b64 = item?.b64_json
    if (b64) {
      results.push({ b64_json: b64, revised_prompt: item.revised_prompt })
      continue
    }
    const url = item?.url
    if (url) results.push({ url, revised_prompt: item.revised_prompt })
  }
  return results
}

function sanitizePayload(raw, { edits = false } = {}) {
  const payload = {}
  const model = String(raw?.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL
  payload.model = model
  payload.prompt = String(raw?.prompt || '').trim()
  if (!payload.prompt) throw Object.assign(new Error('prompt 不能为空'), { statusCode: 400 })
  for (const key of ['size', 'quality', 'background', 'output_format', 'moderation', 'style', 'input_fidelity']) {
    if (typeof raw?.[key] === 'string' && raw[key].trim()) payload[key] = raw[key].trim()
  }
  for (const key of ['n', 'output_compression', 'partial_images']) {
    if (Number.isFinite(Number(raw?.[key])) && raw[key] !== undefined && raw[key] !== '') payload[key] = Number(raw[key])
  }
  if (raw?.stream === true) payload.stream = true
  if (edits) {
    const images = []
    const push = (value) => {
      if (!value) return
      if (typeof value === 'string' && value.startsWith('data:image/')) images.push({ image_url: value })
      else if (typeof value === 'string' && /^https?:\/\//.test(value)) images.push({ image_url: value })
      else if (value && typeof value === 'object' && typeof value.image_url === 'string') images.push({ image_url: value.image_url })
    }
    if (Array.isArray(raw?.images)) raw.images.forEach(push)
    else push(raw?.images)
    if (Array.isArray(raw?.image)) raw.image.forEach(push)
    else push(raw?.image)
    if (Array.isArray(raw?.reference_images)) raw.reference_images.forEach(push)
    if (images.length === 0) throw Object.assign(new Error('images/edits 需要至少一张参考图'), { statusCode: 400 })
    payload.images = images
    if (raw?.mask && typeof raw.mask === 'object' && raw.mask.image_url) payload.mask = { image_url: raw.mask.image_url }
    else if (typeof raw?.mask === 'string') payload.mask = { image_url: raw.mask }
  }
  return payload
}

async function parseMultipart(req, body) {
  const request = new Request('http://gateway.local/upload', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] || '' },
    body,
  })
  const form = await request.formData()
  const raw = { prompt: '', model: '', images: [] }
  for (const key of ['size', 'quality', 'background', 'output_format', 'moderation', 'style', 'input_fidelity']) {
    const value = form.get(key)
    if (typeof value === 'string' && value) raw[key] = value
  }
  const prompt = form.get('prompt')
  if (typeof prompt === 'string') raw.prompt = prompt
  const model = form.get('model')
  if (typeof model === 'string') raw.model = model
  const files = []
  for (const value of form.getAll('image[]')) if (value && typeof value === 'object') files.push(value)
  for (const value of form.getAll('image')) if (value && typeof value === 'object') files.push(value)
  for (const value of form.getAll('images')) if (value && typeof value === 'object') files.push(value)
  for (const file of files) {
    const buf = Buffer.from(await file.arrayBuffer())
    const type = file.type || 'image/png'
    raw.images.push(`data:${type};base64,${buf.toString('base64')}`)
  }
  return raw
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大（>60MB）'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-max-age': '600',
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function requireGatewayKey(req) {
  if (!GATEWAY_KEY) return true
  const auth = String(req.headers.authorization || '')
  return auth === `Bearer ${GATEWAY_KEY}`
}

async function handleImages(req, res, { edits }) {
  if (!requireGatewayKey(req)) {
    sendJson(res, 401, { error: { message: '无效的网关 API Key', type: 'invalid_request_error', code: 'invalid_api_key' } })
    return
  }
  const contentType = String(req.headers['content-type'] || '')
  const body = await readBody(req)
  let raw
  if (contentType.startsWith('multipart/form-data')) raw = await parseMultipart(req, body)
  else if (contentType.includes('application/json')) raw = JSON.parse(body.toString('utf8') || '{}')
  else throw Object.assign(new Error('不支持的 Content-Type（需要 application/json 或 multipart/form-data）'), { statusCode: 415 })

  const payload = sanitizePayload(raw, { edits })
  const startedAt = Date.now()
  log(`${edits ? 'edits' : 'generations'} model=${payload.model} images=${payload.images?.length || 0} size=${payload.size || 'auto'}`)
  const json = await upstreamFetch(edits ? '/images/edits' : '/images/generations', payload)
  const results = imageResults(json)
  if (results.length === 0) {
    throw Object.assign(new Error('Codex 上游没有返回图片'), { statusCode: 502 })
  }
  const out = {
    created: Number(json?.created) || Math.floor(Date.now() / 1000),
    data: results,
  }
  if (json?.usage) out.usage = json.usage
  log(`${edits ? 'edits' : 'generations'} 完成 ${Math.round((Date.now() - startedAt) / 1000)}s images=${results.length}`)
  sendJson(res, 200, out)
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const info = authInfo()
      sendJson(res, 200, {
        ok: true,
        service: 'codex-image-gateway',
        models: MODELS,
        default_model: DEFAULT_MODEL,
        ...info,
      })
      return
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      sendJson(res, 200, {
        object: 'list',
        data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'codex-subscription', created: 0 })),
      })
      return
    }
    if (req.method === 'POST' && (url.pathname === '/v1/images/generations' || url.pathname === '/images/generations')) {
      await handleImages(req, res, { edits: false })
      return
    }
    if (req.method === 'POST' && (url.pathname === '/v1/images/edits' || url.pathname === '/images/edits')) {
      await handleImages(req, res, { edits: true })
      return
    }
    sendJson(res, 404, { error: { message: `未知端点：${req.method} ${url.pathname}`, type: 'invalid_request_error' } })
  } catch (err) {
    const statusCode = Number(err?.statusCode) || 500
    const message = err instanceof Error ? err.message : String(err)
    log('错误:', statusCode, message.slice(0, 500))
    sendJson(res, statusCode, { error: { message, type: statusCode >= 500 ? 'upstream_error' : 'invalid_request_error' } })
  }
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用，请用 CODEX_IMAGE_GATEWAY_PORT=其他端口 重启（例如 8790）`)
  } else {
    log('网关错误：', err.message)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  let info = null
  try {
    info = authInfo()
    log(`Codex 图片网关已启动：http://${HOST}:${PORT}/v1`)
    log(`账号：${info.email || info.account_masked}（${info.plan_type || '未知套餐'}）`)
    log(`模型：${MODELS.join(', ')}（默认 ${DEFAULT_MODEL}）`)
    log(`代理：${process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '未设置（若网络需要代理请先设置 HTTPS_PROXY 并启用 NODE_USE_ENV_PROXY=1）'}`)
    log('在应用中：接口协议选「OpenAI GPT Image」→ Base URL 填本地址（含 /v1）→ API Key 填任意值（或网关 Key）→ 模型选 gpt-image-2.6')
  } catch (err) {
    log('警告：', err.message)
    log(`请先运行 codex login，或设置 CODEX_HOME 指向包含 auth.json 的目录`)
  }
})
