import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * 本地开发/预览时的一键 Codex 生图网关控制接口（仅本机回环可访问）。
 *
 * 背景：scripts/codex-image-gateway.mjs 需要先读取 ~/.codex/auth.json 与系统代理，
 * 原本只能手动在终端运行 scripts/start-codex-gateway.ps1 启动。这里由 Vite 的
 * Node 进程代为拉起网关子进程，供设置页「启动网关 / 停止网关」按钮调用。
 *
 * 端点（同源，仅 dev / preview 的 Vite 服务端存在；Cloudflare 线上部署没有）：
 *   GET  /api/codex-gateway/status  → 网关状态（端口、是否运行、账号信息、最近日志）
 *   POST /api/codex-gateway/start   → 拉起网关并等待其监听（幂等，已在运行则直接返回）
 *   POST /api/codex-gateway/stop    → 停止由本服务拉起的网关
 *
 * 安全：所有端点只接受 127.0.0.1 / ::1 的回环请求，避免局域网内他人借浏览器拉起本机进程。
 */

const GATEWAY_SCRIPT = 'scripts/codex-image-gateway.mjs'
const DEFAULT_PORT = Number(process.env.CODEX_GATEWAY_PORT || 8788)
const START_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 8_000
const PROBE_TIMEOUT_MS = 1_500
const PORT_PROBE_TIMEOUT_MS = 400
const LOG_LIMIT = 60
const LOG_TAIL = 20

export interface GatewayHealth {
  ok: boolean
  service?: string
  email?: string
  account_masked?: string
  plan_type?: string
  default_model?: string
  [key: string]: unknown
}

export interface GatewayStatusPayload {
  ok: boolean
  service: 'codex-gateway-control'
  platform: string
  supported: boolean
  port: number
  baseUrl: string
  running: boolean
  managed: boolean
  pid: number | null
  health: GatewayHealth | null
  healthError: string | null
  lastError: string | null
  logTail: string[]
}

type GatewayStartResult =
  | { ok: true; alreadyRunning: boolean; status: GatewayStatusPayload }
  | { ok: false; error: string; logTail: string[] }

type GatewayStopResult =
  | { ok: true; status: GatewayStatusPayload }
  | { ok: false; error: string; status: GatewayStatusPayload }

interface GatewayProbe {
  reachable: boolean
  running: boolean
  foreign: boolean
  health: GatewayHealth | null
  healthError: string | null
}

interface JsonProbe {
  status: number
  ok: boolean
  json: unknown
}

interface GatewayState {
  child: ChildProcess | null
  port: number
  logs: string[]
  lastError: string | null
  starting: Promise<GatewayStartResult> | null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function getJson(port: number, pathname: string): Promise<JsonProbe | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, ok: res.ok, json }
  } catch {
    return null
  }
}

function errorMessageOf(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const error = (json as { error?: unknown }).error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  const message = (json as { message?: unknown }).message
  return typeof message === 'string' && message.trim() ? message.trim() : null
}

async function probeGateway(port: number): Promise<GatewayProbe> {
  const empty: GatewayProbe = { reachable: false, running: false, foreign: false, health: null, healthError: null }
  if (!(await probePort(port))) return empty

  // 用 /v1/models 识别端口上跑的确实是 Codex 生图网关（该端点不依赖凭据，总能返回模型列表）
  const models = await getJson(port, '/v1/models')
  const list = models?.json as { object?: unknown; data?: unknown } | null
  const items = Array.isArray(list?.data) ? (list.data as Array<{ owned_by?: unknown }>) : []
  const identifiable = list?.object === 'list' && items.some((item) => item?.owned_by === 'codex-subscription')
  if (!identifiable) return { reachable: true, running: false, foreign: true, health: null, healthError: null }

  const health = await getJson(port, '/health')
  const healthJson = health?.json
  const healthOk = health?.ok === true && Boolean(healthJson) && (healthJson as GatewayHealth).ok === true
  if (healthOk) {
    return { reachable: true, running: true, foreign: false, health: healthJson as GatewayHealth, healthError: null }
  }
  return {
    reachable: true,
    running: true,
    foreign: false,
    health: null,
    healthError: errorMessageOf(healthJson) || (health ? `网关 /health 返回 HTTP ${health.status}` : '网关健康检查失败'),
  }
}

/** 读取 Windows 系统代理（Clash/V2Ray 等），与 start-codex-gateway.ps1 的行为保持一致。 */
function systemProxyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const inherited = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (inherited) {
    env.HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || inherited
    env.HTTP_PROXY = process.env.HTTP_PROXY || process.env.http_proxy || inherited
    env.NODE_USE_ENV_PROXY = '1'
    return env
  }
  if (process.platform !== 'win32') return env
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3_000,
    })
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)
    const serverMatch = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(out)
    if (!enabled || Number.parseInt(enabled[1], 16) !== 1 || !serverMatch) return env
    let server = serverMatch[1].trim()
    if (server.includes('=')) {
      const parts = server.split(';').map((part) => part.trim())
      const pick = (prefix: string) =>
        parts
          .find((part) => part.toLowerCase().startsWith(prefix))
          ?.slice(prefix.length)
          .trim() || ''
      server = pick('https=') || pick('http=') || ''
    }
    if (!server) return env
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(server)) server = `http://${server}`
    env.HTTP_PROXY = server
    env.HTTPS_PROXY = server
    env.NODE_USE_ENV_PROXY = '1'
  } catch {
    // 读不到系统代理时交给网关自身提示（不影响启动）
  }
  return env
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'])

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

/**
 * 仅允许本机回环来源。除 socket 远端地址外，再校验浏览器 Origin：
 * 避免用户在浏览器打开任意第三方网页时，借 simple POST（无 preflight）拉起/停止本机网关（CSRF）。
 * curl / 本机脚本不带 Origin，靠 remoteAddress 已限定回环，直接放行。
 */
function isAllowedLocalRequest(req: {
  socket?: { remoteAddress?: string | undefined } | null
  headers?: Record<string, string | string[] | undefined>
}): boolean {
  if (!isLoopbackHost(String(req.socket?.remoteAddress || ''))) return false
  const rawOrigin = req.headers?.origin
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin
  if (!origin) return true
  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

function sendJson(res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string) => void }, statusCode: number, payload: unknown) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

// 每个 Vite 配置实例（含重启后的新实例）都会覆盖这个引用，保证进程退出时只清理当前网关子进程
const globalRef = globalThis as {
  __codexGatewayDispose?: () => void
  __codexGatewayExitHook?: boolean
}

export function codexGatewayPlugin(options: { rootDir: string }): Plugin {
  const scriptPath = path.join(options.rootDir, GATEWAY_SCRIPT)
  const state: GatewayState = {
    child: null,
    port: DEFAULT_PORT,
    logs: [],
    lastError: null,
    starting: null,
  }

  const pushLog = (chunk: unknown) => {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd()
      if (trimmed) state.logs.push(trimmed)
    }
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT)
  }

  const logTail = () => state.logs.slice(-LOG_TAIL)

  const killChild = (): boolean => {
    const child = state.child
    state.child = null
    if (!child || child.exitCode !== null) return false
    try {
      child.kill()
    } catch {
      // 进程已退出时 kill 会抛错，忽略
    }
    return true
  }

  const isManagedAlive = () => Boolean(state.child && state.child.exitCode === null && !state.child.killed)

  const dispose = () => {
    killChild()
  }

  const waitPortClosed = async (port: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await probePort(port))) return true
      await sleep(120)
    }
    return !(await probePort(port))
  }

  const collectStatus = async (): Promise<GatewayStatusPayload> => {
    const probe = await probeGateway(state.port)
    const managed = isManagedAlive()
    return {
      ok: true,
      service: 'codex-gateway-control',
      platform: process.platform,
      supported: fs.existsSync(scriptPath),
      port: state.port,
      baseUrl: `http://127.0.0.1:${state.port}/v1`,
      running: probe.running,
      managed,
      pid: managed ? (state.child?.pid ?? null) : null,
      health: probe.health,
      healthError: probe.healthError,
      lastError: state.lastError,
      logTail: logTail(),
    }
  }

  const startGateway = async (): Promise<GatewayStartResult> => {
    // 每次启动尝试都重置日志，避免失败时把上一次运行的旧日志当成本次证据展示
    state.logs = []
    if (!fs.existsSync(scriptPath)) {
      const error = `未找到网关脚本：${scriptPath}`
      state.lastError = error
      return { ok: false, error, logTail: logTail() }
    }

    const before = await probeGateway(state.port)
    if (before.running) {
      state.lastError = null
      return { ok: true, alreadyRunning: true, status: await collectStatus() }
    }
    if (before.foreign) {
      const error = `端口 ${state.port} 已被其它程序占用，请先停止占用程序（或设置 CODEX_GATEWAY_PORT 换端口）`
      state.lastError = error
      return { ok: false, error, logTail: logTail() }
    }

    state.logs = []
    const child = spawn(process.execPath, [scriptPath], {
      cwd: options.rootDir,
      env: { ...process.env, ...systemProxyEnv(), CODEX_IMAGE_GATEWAY_PORT: String(state.port) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    state.child = child
    child.stdout?.on('data', pushLog)
    child.stderr?.on('data', pushLog)
    child.once('exit', (code, signal) => {
      pushLog(`[gateway] 进程退出 code=${code ?? '-'} signal=${signal ?? '-'}`)
      if (state.child === child) state.child = null
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(200)
      if (state.child === child && child.exitCode !== null) {
        const tail = logTail()
        const detail = [...tail].reverse().find((line) => /error|错误|EADDRINUSE|端口|凭据/i.test(line)) || tail[tail.length - 1]
        const error = detail ? `网关启动失败：${detail}` : '网关进程启动后立即退出，请查看开发服务器终端日志'
        state.lastError = error
        return { ok: false, error, logTail: tail }
      }
      const probe = await probeGateway(state.port)
      if (probe.running) {
        state.lastError = null
        return { ok: true, alreadyRunning: false, status: await collectStatus() }
      }
      if (probe.foreign) {
        const error = `端口 ${state.port} 已被其它程序占用`
        state.lastError = error
        killChild()
        return { ok: false, error, logTail: logTail() }
      }
    }

    killChild()
    const error = `网关启动超时（${Math.round(START_TIMEOUT_MS / 1000)} 秒），请查看开发服务器终端中的网关日志`
    state.lastError = error
    return { ok: false, error, logTail: logTail() }
  }

  const runStart = (): Promise<GatewayStartResult> => {
    if (!state.starting) {
      state.starting = startGateway().finally(() => {
        state.starting = null
      })
    }
    return state.starting
  }

  const stopGateway = async (): Promise<GatewayStopResult> => {
    const killed = killChild()
    if (!killed) {
      const probe = await probeGateway(state.port)
      if (probe.running) {
        return {
          ok: false,
          error: '网关不是由本开发服务器启动的，请在启动它的终端中停止',
          status: await collectStatus(),
        }
      }
      state.lastError = null
      return { ok: true, status: await collectStatus() }
    }
    await waitPortClosed(state.port, STOP_TIMEOUT_MS)
    state.lastError = null
    return { ok: true, status: await collectStatus() }
  }

  const handle = async (req: any, res: any) => {
    const url = String(req.url || '').split('?')[0]
    if (!isAllowedLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: '仅允许本机（回环地址）的页面访问该接口' })
      return
    }
    if (req.method === 'POST') req.resume()
    try {
      if (req.method === 'GET' && url === '/api/codex-gateway/status') {
        sendJson(res, 200, await collectStatus())
        return
      }
      if (req.method === 'POST' && url === '/api/codex-gateway/start') {
        const result = await runStart()
        if (result.ok) {
          sendJson(res, 200, { ...result.status, lastError: null, alreadyRunning: result.alreadyRunning })
          return
        }
        sendJson(res, 500, { ok: false, service: 'codex-gateway-control', error: result.error, logTail: result.logTail })
        return
      }
      if (req.method === 'POST' && url === '/api/codex-gateway/stop') {
        const result = await stopGateway()
        if (result.ok) {
          sendJson(res, 200, { ...result.status, lastError: null })
          return
        }
        sendJson(res, 409, { ...result.status, ok: false, service: 'codex-gateway-control', error: result.error })
        return
      }
      sendJson(res, 404, { ok: false, error: `未知端点：${req.method} ${url}` })
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        service: 'codex-gateway-control',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const install = (server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void }; httpServer?: { once: (event: string, listener: () => void) => void } | null }) => {
    server.middlewares.use((req: any, res: any, next: () => void) => {
      const url = String(req.url || '').split('?')[0]
      if (!url.startsWith('/api/codex-gateway/')) {
        next()
        return
      }
      void handle(req, res)
    })
    // 开发服务器重启 / 关闭时清理由它拉起的网关子进程；进程退出时再兜底一次
    server.httpServer?.once('close', dispose)
    globalRef.__codexGatewayDispose = dispose
    if (!globalRef.__codexGatewayExitHook) {
      globalRef.__codexGatewayExitHook = true
      process.once('exit', () => globalRef.__codexGatewayDispose?.())
    }
  }

  return {
    name: 'codex-gateway-control',
    configureServer(server) {
      install(server as any)
    },
    configurePreviewServer(server) {
      install(server as any)
    },
  }
}
