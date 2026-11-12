import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ActivityIcon,
  CheckIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  PowerIcon,
  PowerOffIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  SparklesIcon,
  TerminalIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Field, Section } from '@/components/common/FormSection'
import { PageHeader } from '@/components/common/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { comfyCandidateUrls, detectComfyUi, PROVIDER_META, testComfyConnection } from '@/services/aiGenerator'
import { useStudio } from '@/store/studioStore'
import type { ImagePassMode, ImageProviderId } from '@/types/gallery'

export const Route = createFileRoute('/settings')({
  staticData: { title: 'API 配置' },
  component: SettingsPage,
})

const PROVIDER_ORDER: ImageProviderId[] = ['gemini', 'gpt', 'qwen', 'doubao', 'comfyui']

const CODEX_GATEWAY_BASE = 'http://127.0.0.1:8788/v1'
const GATEWAY_STATUS_URL = '/api/codex-gateway/status'
const GATEWAY_START_URL = '/api/codex-gateway/start'
const GATEWAY_STOP_URL = '/api/codex-gateway/stop'
const GATEWAY_POLL_INTERVAL_MS = 10_000
const GATEWAY_UNSUPPORTED_TITLE = '仅在本机运行 pnpm dev / pnpm preview 时可用；线上请手动运行 scripts/start-codex-gateway.ps1'

/** GET /api/codex-gateway/status 返回的网关健康信息（由本机开发服务器注入，线上部署没有该接口） */
interface GatewayHealth {
  ok: boolean
  email?: string
  account_masked?: string
  plan_type?: string
  default_model?: string
}

/** GET /api/codex-gateway/status 的响应契约 */
interface GatewayStatus {
  ok: boolean
  supported: boolean
  platform: string
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

/** POST /api/codex-gateway/start 成功时在状态字段之外多返回 alreadyRunning */
interface GatewayStartResult extends GatewayStatus {
  alreadyRunning: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseGatewayHealth(value: unknown): GatewayHealth | null {
  if (!isRecord(value) || value.ok !== true) return null
  return {
    ok: true,
    email: asOptionalString(value.email),
    account_masked: asOptionalString(value.account_masked),
    plan_type: asOptionalString(value.plan_type),
    default_model: asOptionalString(value.default_model),
  }
}

/** 线上部署可能返回 404 / HTML，必须校验结构后再使用，避免把非契约响应当成网关状态 */
function parseGatewayStatus(value: unknown): GatewayStatus | null {
  if (!isRecord(value) || value.ok !== true) return null
  if (
    typeof value.supported !== 'boolean' ||
    typeof value.platform !== 'string' ||
    typeof value.port !== 'number' ||
    typeof value.baseUrl !== 'string' ||
    typeof value.running !== 'boolean' ||
    typeof value.managed !== 'boolean'
  ) {
    return null
  }
  return {
    ok: true,
    supported: value.supported,
    platform: value.platform,
    port: value.port,
    baseUrl: value.baseUrl,
    running: value.running,
    managed: value.managed,
    pid: typeof value.pid === 'number' ? value.pid : null,
    health: parseGatewayHealth(value.health),
    healthError: asOptionalString(value.healthError) ?? null,
    lastError: asOptionalString(value.lastError) ?? null,
    logTail: Array.isArray(value.logTail)
      ? value.logTail.filter((line): line is string => typeof line === 'string')
      : [],
  }
}

function parseGatewayStartResult(value: unknown): GatewayStartResult | null {
  const status = parseGatewayStatus(value)
  if (!status || !isRecord(value)) return null
  return { ...status, alreadyRunning: value.alreadyRunning === true }
}

function readGatewayErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  const message = value.error
  return typeof message === 'string' && message.trim().length > 0 ? message : null
}

/** 由网关 baseUrl 推导 health 地址：「检测网关」优先使用当前运行中的实际端口 */
function codexGatewayHealthUrl(baseUrl: string): string {
  const normalized = (baseUrl.trim() || CODEX_GATEWAY_BASE).replace(/\/+$/, '')
  return `${normalized.replace(/\/v1$/i, '')}/health`
}

function SettingsPage() {
  const { apiConfig, updateApiConfig, updateProviderConfig, updateGptParams } = useStudio()
  const [showKey, setShowKey] = useState(false)
  const [testingComfy, setTestingComfy] = useState(false)
  const [testingCodexGateway, setTestingCodexGateway] = useState(false)
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null)
  const [gatewayAction, setGatewayAction] = useState<'start' | 'stop' | null>(null)

  // 用 ref 做同步防重入：避免「启动/停止」被双击，或轮询请求覆盖刚拿到的状态
  const gatewayActionRef = useRef<'start' | 'stop' | null>(null)
  const gatewayStatusSeqRef = useRef(0)
  const gatewayStatusRequestRef = useRef(false)
  const gatewayMountedRef = useRef(true)

  const pid = apiConfig.activeProvider
  const meta = PROVIDER_META[pid]
  const pCfg = apiConfig.providers[pid]

  /** 一键填入本地 Codex 生图网关配置（启动成功、或手动点「Codex 网关」时复用） */
  const applyCodexGatewayConfig = (baseUrl?: string) => {
    updateProviderConfig('gpt', {
      baseUrl: baseUrl?.trim() || CODEX_GATEWAY_BASE,
      apiKey: 'sk-local-codex',
      model: 'gpt-image-2.6',
    })
    updateGptParams({ endpointMode: 'images_edits_json', size: '1024x1536', quality: 'high' })
    // 本地图片 OpenAI 服务器无法访问，走 Codex 网关时需要 data URL（base64）
    updateApiConfig({ imagePassMode: 'base64' })
  }

  const fillCodexGateway = () => {
    applyCodexGatewayConfig(gatewayStatus?.baseUrl)
    toast.success('已填入本地 Codex 生图网关（记得先运行 scripts/start-codex-gateway.ps1）')
  }

  // 读取本机开发服务器提供的网关状态；线上部署没有该接口时降级为禁用按钮
  const refreshGatewayStatus = useCallback(async () => {
    const seq = ++gatewayStatusSeqRef.current
    gatewayStatusRequestRef.current = true
    try {
      const res = await fetch(GATEWAY_STATUS_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload: unknown = await res.json()
      const status = parseGatewayStatus(payload)
      if (!status) throw new Error('网关状态响应格式异常')
      if (!gatewayMountedRef.current || seq !== gatewayStatusSeqRef.current) return
      setGatewayStatus(status)
    } catch {
      if (!gatewayMountedRef.current || seq !== gatewayStatusSeqRef.current) return
      setGatewayStatus(null)
    } finally {
      gatewayStatusRequestRef.current = false
    }
  }, [])

  useEffect(() => {
    gatewayMountedRef.current = true
    // 挂载后异步读取一次，不在 effect 同步阶段触发 setState
    const initialTimer = window.setTimeout(() => {
      void refreshGatewayStatus()
    }, 0)
    const refresh = () => {
      // 启动/停止进行中或上一次请求未返回时跳过，避免并发覆盖状态
      if (gatewayActionRef.current !== null || gatewayStatusRequestRef.current) return
      void refreshGatewayStatus()
    }
    const timer = window.setInterval(refresh, GATEWAY_POLL_INTERVAL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      gatewayMountedRef.current = false
      gatewayStatusSeqRef.current += 1
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refreshGatewayStatus])

  const startCodexGateway = async () => {
    if (gatewayActionRef.current !== null) return
    gatewayActionRef.current = 'start'
    setGatewayAction('start')
    try {
      const res = await fetch(GATEWAY_START_URL, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      const payload: unknown = await res.json().catch(() => null)
      const started = res.ok ? parseGatewayStartResult(payload) : null
      if (!started) {
        const serverError = readGatewayErrorMessage(payload)
        toast.error(serverError ?? (res.ok ? '网关启动接口返回异常' : `启动网关失败（HTTP ${res.status}）`), {
          duration: 10000,
        })
        return
      }
      gatewayStatusSeqRef.current += 1
      setGatewayStatus(started)
      applyCodexGatewayConfig(started.baseUrl)
      if (started.healthError) {
        toast.error(`网关已启动，但 Codex 凭据读取失败：${started.healthError}。请先在终端运行 codex login`, {
          duration: 10000,
        })
      } else if (started.alreadyRunning) {
        toast.success('Codex 网关已在运行，已填入配置')
      } else if (started.health?.ok) {
        const account = started.health.email || started.health.account_masked || '本机账号'
        toast.success(
          `Codex 网关已启动：${account}（${started.health.plan_type || '未知套餐'}），已自动填入配置`
        )
      } else {
        toast.success('Codex 网关已启动，已自动填入配置')
      }
    } catch {
      toast.error('无法连接本机开发服务器接口', { duration: 10000 })
    } finally {
      gatewayActionRef.current = null
      if (gatewayMountedRef.current) setGatewayAction(null)
    }
  }

  const stopCodexGateway = async () => {
    if (gatewayActionRef.current !== null) return
    gatewayActionRef.current = 'stop'
    setGatewayAction('stop')
    try {
      const res = await fetch(GATEWAY_STOP_URL, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      const payload: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(readGatewayErrorMessage(payload) ?? `停止网关失败（HTTP ${res.status}）`, { duration: 10000 })
        return
      }
      toast.success('已停止 Codex 网关')
      await refreshGatewayStatus()
    } catch {
      toast.error('无法连接本机开发服务器接口', { duration: 10000 })
    } finally {
      gatewayActionRef.current = null
      if (gatewayMountedRef.current) setGatewayAction(null)
    }
  }

  const testCodexGateway = async () => {
    setTestingCodexGateway(true)
    try {
      const res = await fetch(codexGatewayHealthUrl(gatewayStatus?.baseUrl ?? CODEX_GATEWAY_BASE), {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const info: unknown = await res.json()
      if (!isRecord(info) || info.ok !== true) throw new Error('网关返回异常')
      const email = asOptionalString(info.email)
      const accountMasked = asOptionalString(info.account_masked)
      const planType = asOptionalString(info.plan_type)
      const defaultModel = asOptionalString(info.default_model)
      toast.success(
        `Codex 网关可用：${email || accountMasked || '本机账号'}（${planType || '未知套餐'}）${
          defaultModel ? `，默认模型 ${defaultModel}` : ''
        }`
      )
      await refreshGatewayStatus()
    } catch {
      toast.error(
        '未检测到本地 Codex 生图网关：可点「启动网关」直接拉起，或先在终端运行 scripts/start-codex-gateway.ps1',
        { duration: 8000 }
      )
    } finally {
      setTestingCodexGateway(false)
    }
  }

  const handleTestComfy = async () => {
    setTestingComfy(true)
    try {
      const info = await testComfyConnection(pCfg.baseUrl, pCfg.apiKey)
      toast.success(`连接成功：${info}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '连接失败', { duration: 10000 })
    } finally {
      setTestingComfy(false)
    }
  }

  const handleDetectComfy = async () => {
    setTestingComfy(true)
    try {
      const found = await detectComfyUi(pCfg.baseUrl, pCfg.apiKey)
      if (!found) {
        toast.error(
          `未找到可用的 ComfyUI（已尝试：${comfyCandidateUrls(pCfg.baseUrl).join('、')}）。请确认已启动；若端口不同，可在上方地址栏填写正确地址`,
          { duration: 10000 }
        )
        return
      }
      updateProviderConfig('comfyui', { baseUrl: found.baseUrl })
      toast.success(`已识别：${found.info}（${found.baseUrl}）`)
    } finally {
      setTestingComfy(false)
    }
  }

  const gatewayRunning = gatewayStatus?.running === true
  const gatewayManaged = gatewayStatus?.managed === true
  const gatewayBusy = gatewayAction !== null
  const gatewayButtonDisabled =
    gatewayBusy || !gatewayStatus || !gatewayStatus.supported || (gatewayRunning && !gatewayManaged)
  const gatewayButtonTitle = !gatewayStatus
    ? GATEWAY_UNSUPPORTED_TITLE
    : !gatewayStatus.supported
      ? `当前平台（${gatewayStatus.platform || '未知平台'}）暂不支持一键启动，请手动运行 scripts/start-codex-gateway.ps1`
      : gatewayRunning && !gatewayManaged
        ? '该网关由外部终端启动，如需停止请回到启动它的终端窗口（Ctrl+C）'
        : undefined

  return (
    <>
      <PageHeader
        title="API 接口配置"
        actions={
          <Button size="sm" asChild>
            <Link to="/studio">
              <SparklesIcon className="size-4" />
              返回合成台
            </Link>
          </Button>
        }
      />

      {/* 五大协议切换标签 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {PROVIDER_ORDER.map((id) => {
          const itemMeta = PROVIDER_META[id]
          const isActive = pid === id
          const hasKey =
            id === 'comfyui'
              ? Boolean(apiConfig.providers.comfyui.baseUrl.trim())
              : Boolean(apiConfig.providers[id].apiKey.trim())
          return (
            <button
              key={id}
              type="button"
              onClick={() => updateApiConfig({ activeProvider: id })}
              className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-all ${
                isActive
                  ? 'border-primary bg-primary/6 font-semibold shadow-xs'
                  : 'border-border/60 bg-card hover:bg-muted/40'
              }`}
            >
              <span className="truncate text-xs sm:text-sm">{itemMeta.name}</span>
              <span
                className={`size-2 shrink-0 rounded-full ${
                  hasKey ? 'bg-emerald-500' : 'bg-muted-foreground/30'
                }`}
                title={hasKey ? '已就绪' : '未配置 Key'}
              />
            </button>
          )
        })}
      </div>

      {/* 当前厂商连接配置 */}
      <Section
        title={`${meta.name} 连接配置`}
        actions={
          <div className="flex items-center gap-1.5">
            {pid === 'comfyui' && (
              <>
                <Button variant="outline" size="sm" onClick={handleDetectComfy} disabled={testingComfy}>
                  <ScanSearchIcon className="size-3.5" />
                  自动识别
                </Button>
                <Button variant="outline" size="sm" onClick={handleTestComfy} disabled={testingComfy}>
                  <ActivityIcon className="size-3.5" />
                  {testingComfy ? '检测中…' : '测试连接'}
                </Button>
              </>
            )}
            {pid === 'gpt' && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void (gatewayRunning ? stopCodexGateway() : startCodexGateway())
                  }}
                  disabled={gatewayButtonDisabled}
                  aria-busy={gatewayBusy}
                  title={gatewayButtonTitle}
                >
                  {gatewayAction === 'start' ? (
                    <>
                      <LoaderCircleIcon className="size-3.5 animate-spin" />
                      启动中…
                    </>
                  ) : gatewayAction === 'stop' ? (
                    <>
                      <LoaderCircleIcon className="size-3.5 animate-spin" />
                      停止中…
                    </>
                  ) : gatewayRunning ? (
                    <>
                      <PowerOffIcon className="size-3.5" />
                      {gatewayManaged ? '停止网关' : '网关运行中'}
                    </>
                  ) : (
                    <>
                      <PowerIcon className="size-3.5" />
                      启动网关
                    </>
                  )}
                </Button>
                <Button variant="outline" size="sm" onClick={fillCodexGateway}>
                  <TerminalIcon className="size-3.5" />
                  Codex 网关
                </Button>
                <Button variant="outline" size="sm" onClick={testCodexGateway} disabled={testingCodexGateway}>
                  <ActivityIcon className="size-3.5" />
                  {testingCodexGateway ? '检测中…' : '检测网关'}
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" asChild>
              <a href={meta.docUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon className="size-3.5" />
                文档
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                updateProviderConfig(pid, {
                  baseUrl: meta.defaultBaseUrl,
                  model: meta.models[0].value,
                })
                toast.success('已恢复默认')
              }}
            >
              <RotateCcwIcon className="size-3.5" />
              重置
            </Button>
          </div>
        }
      >
        <Field
          label={pid === 'comfyui' ? 'ComfyUI 地址 (Base URL)' : 'Base URL'}
          hint={
            pid === 'comfyui'
              ? `本地运行本站时填 /comfy（同源代理，pnpm dev 会自动探测本机 ComfyUI 端口，默认 8188，兼容 8000/8088/8189）；直连时 ComfyUI 需加启动参数 --enable-cors-header "${typeof window !== 'undefined' ? window.location.origin : '*'}"`
              : pid === 'gpt'
                ? '本机 Codex/ChatGPT 订阅生图：直接点右上「启动网关」一键拉起（自动读取 ~/.codex/auth.json、继承 Windows 系统代理，需先 codex login），也可手动运行 scripts/start-codex-gateway.ps1 后点「Codex 网关」填入 http://127.0.0.1:8788/v1；订阅账号审核会拒绝部分「泳装/内衣/性感类」参考图（safety_violations=[sexual]，与提示词无关；白模/深度图姿势参考实测可通过），建议优先用日常服装；应用会自动改用中性提示词并做生成前校验：随机配方/定时任务命中高风险素材会自动再随机一次，手动选中的高风险素材会提示更换。'
                : undefined
          }
        >
          <Input
            type={pid === 'comfyui' ? 'text' : 'url'}
            value={pCfg.baseUrl}
            onChange={(e) => updateProviderConfig(pid, { baseUrl: e.target.value })}
            placeholder={meta.defaultBaseUrl}
          />
        </Field>

        <Field label={pid === 'comfyui' ? 'API Key（可选，本地留空）' : 'API Key'}>
          <div className="relative">
            <Input
              type={showKey ? 'text' : 'password'}
              value={pCfg.apiKey}
              onChange={(e) => updateProviderConfig(pid, { apiKey: e.target.value })}
              placeholder={
                pid === 'comfyui'
                  ? '本地 ComfyUI 无需填写，远程鉴权可填 Token'
                  : '输入 API Key（仅保存在本地浏览器）'
              }
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </button>
          </div>
        </Field>

        {pid !== 'comfyui' && (
          <Field label="默认模型 ID">
            <Select
              value={pCfg.model}
              onValueChange={(v) => updateProviderConfig(pid, { model: v })}
            >
              <SelectTrigger className="w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {meta.models.map((m) => (
                  <SelectItem key={m.value} value={m.value} className="font-mono text-xs">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        {pid !== 'comfyui' && pCfg.model === 'custom' && (
          <Field label="自定义模型 ID">
            <Input
              value={pCfg.customModel}
              onChange={(e) => updateProviderConfig(pid, { customModel: e.target.value })}
              placeholder={pid === 'doubao' ? 'ep-2026xxxx 或模型 ID' : '输入模型 ID'}
              className="font-mono text-xs"
            />
          </Field>
        )}
      </Section>

      {pid === 'comfyui' && (
        <p className="text-sm text-muted-foreground">模型由工作流决定。请返回合成台导入工作流，并设置人像、服装和姿势节点。</p>
      )}

      {/* 全局传输设置 */}
      {pid !== 'comfyui' && (
        <Section title="全局请求选项">
          <Field label="参考图传参方式">
            <Select
              value={apiConfig.imagePassMode}
              onValueChange={(v) => updateApiConfig({ imagePassMode: v as ImagePassMode })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="url">传递图片 URL（免上传文件，推荐）</SelectItem>
                <SelectItem value="base64">转 Base64 编码传输</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="服务端 CORS 代理 (/api/proxy)"
            hint="默认关闭（浏览器直连）；切换到阿里云百炼 (Qwen) 或火山方舟 (Doubao) 时会自动开启。仅支持白名单域名（可通过服务端环境变量 PROXY_ALLOWED_ORIGINS 扩展）"
          >
            <div className="flex h-9 items-center justify-between rounded-xl border bg-background px-3">
              <span className="text-xs text-muted-foreground">
                {apiConfig.useProxy ? '已启用（解决跨域限制）' : '已关闭（浏览器直连）'}
              </span>
              <Switch
                checked={apiConfig.useProxy}
                onCheckedChange={(v) => updateApiConfig({ useProxy: v })}
              />
            </div>
          </Field>
        </Section>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => toast.success('配置已保存')}>
          <CheckIcon className="size-4" />
          保存配置
        </Button>
      </div>
    </>
  )
}
