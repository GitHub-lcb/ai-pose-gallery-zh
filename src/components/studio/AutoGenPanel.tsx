import {
  CircleAlertIcon,
  DicesIcon,
  LoaderCircleIcon,
  PlayIcon,
  RepeatIcon,
  SparklesIcon,
  SquareIcon,
  TimerIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Section } from '@/components/common/FormSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { STYLE_PRESETS } from '@/services/aiGenerator'
import { useStudio } from '@/store/studioStore'

const STYLE_COUNT = Math.max(1, Object.keys(STYLE_PRESETS).filter((key) => key !== 'none').length)

function NumberInput({
  value,
  min,
  max,
  ariaLabel,
  onCommit,
}: {
  value: number
  min: number
  max: number
  ariaLabel: string
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const text = draft.trim()
    setDraft(null)
    if (!text) return
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return
    onCommit(Math.min(max, Math.max(min, Math.round(parsed))))
  }
  return (
    <Input
      type="number"
      inputMode="numeric"
      aria-label={ariaLabel}
      min={min}
      max={max}
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      className="bg-background tabular-nums"
    />
  )
}

function ToggleRow({
  icon,
  label,
  desc,
  checked,
  onChange,
}: {
  icon: ReactNode
  label: string
  desc: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-background p-2.5 select-none">
      <span className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold">{label}</span>
          <span className="block text-[11px] leading-snug text-muted-foreground">{desc}</span>
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  )
}

/**
 * 定时任务面板：按随机间隔持续随机组合「人像 + 服装 + 姿势 + 画风」自动出图。
 * - 可随时「立即停止」：会中断正在进行的请求 / 取消 ComfyUI 队列任务
 * - 运行在当前页面内，切换路由不中断，刷新/关闭页面即停止
 */
export function AutoGenPanel() {
  const {
    autoGenConfig,
    updateAutoGenConfig,
    autoGenStatus,
    startAutoGen,
    stopAutoGen,
    isGenerating,
    setPreviewUrl,
    adultGenMode,
    randomSlots,
  } = useStudio()

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!autoGenStatus.enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [autoGenStatus.enabled])

  const running = autoGenStatus.enabled
  const generating = autoGenStatus.generating
  const remainingSec = autoGenStatus.nextRunAt ? Math.max(0, Math.ceil((autoGenStatus.nextRunAt - now) / 1000)) : null
  const statusText = !running
    ? '已停止'
    : generating
      ? '正在自动生成…'
      : isGenerating
        ? '等待手动生成完成…'
        : remainingSec !== null
          ? `等待下一张 · ${remainingSec}s 后`
          : '准备中…'

  return (
    <Section
      title="定时任务 · 自动随机出图"
      desc="按随机间隔持续生成角色图，配方与画风自动轮换，随时可停止。"
      actions={
        <Badge variant={running ? 'default' : 'secondary'}>
          {running && generating ? <LoaderCircleIcon className="animate-spin" /> : <TimerIcon />}
          {running ? (generating ? '生成中' : '运行中') : '已停止'}
        </Badge>
      }
      className="@lg/section:grid-cols-1"
    >
      {/* 状态条 + 开始/停止 */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl bg-background p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-xl',
              running ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            )}
          >
            {generating ? <LoaderCircleIcon className="size-5 animate-spin" /> : <TimerIcon className="size-5" />}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{statusText}</div>
            <div className="text-[11px] text-muted-foreground">
              成功 {autoGenStatus.successCount} 张 · 失败 {autoGenStatus.failureCount} 次
              {autoGenStatus.discardedCount > 0 ? ` · 丢弃 ${autoGenStatus.discardedCount} 张` : ''}
            </div>
          </div>
        </div>
        {/* 两个按钮固定位置：避免「停止」后同一点击位置立刻变成「开始」被双击误触 */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" onClick={startAutoGen} disabled={running}>
            <PlayIcon className="size-3.5" />
            开始
          </Button>
          <Button variant="destructive" size="sm" onClick={() => stopAutoGen()} disabled={!running}>
            <SquareIcon className="size-3.5" />
            立即停止
          </Button>
        </div>
      </div>

      {/* 间隔 / 上限 */}
      <div className="grid grid-cols-2 gap-2.5">
        <label className="grid content-start gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">间隔下限（秒）</span>
          <NumberInput
            value={autoGenConfig.minIntervalSec}
            min={1}
            max={7200}
            ariaLabel="间隔下限秒数"
            onCommit={(value) => updateAutoGenConfig({ minIntervalSec: value })}
          />
        </label>
        <label className="grid content-start gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">间隔上限（秒）</span>
          <NumberInput
            value={autoGenConfig.maxIntervalSec}
            min={1}
            max={7200}
            ariaLabel="间隔上限秒数"
            onCommit={(value) => updateAutoGenConfig({ maxIntervalSec: value })}
          />
        </label>
        <label className="col-span-2 grid content-start gap-1.5">
          <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>张数上限</span>
            <span>{autoGenConfig.maxImages > 0 ? `本轮最多 ${autoGenConfig.maxImages} 张` : '0 = 不限'}</span>
          </span>
          <NumberInput
            value={autoGenConfig.maxImages}
            min={0}
            max={100000}
            ariaLabel="张数上限"
            onCommit={(value) => updateAutoGenConfig({ maxImages: value })}
          />
        </label>
      </div>

      {/* 随机策略 */}
      <div className="space-y-1.5">
        <ToggleRow
          icon={<DicesIcon className="size-4" />}
          label="随机配方"
          desc={`每张自动更换 ${
            [randomSlots.portrait && '人像', randomSlots.costume && '服装', randomSlots.pose && '姿势'].filter(Boolean).join(' + ') || '（未启用参考项）'
          }（${adultGenMode === 'only' ? '仅 18+ 素材' : adultGenMode === 'mixed' ? '含 18+ 素材' : 'SFW 素材'}）`}
          checked={autoGenConfig.randomizeRecipe}
          onChange={(checked) => updateAutoGenConfig({ randomizeRecipe: checked })}
        />
        <ToggleRow
          icon={<SparklesIcon className="size-4" />}
          label="随机画风"
          desc={`每张从 ${STYLE_COUNT} 种画风预设中随机`}
          checked={autoGenConfig.randomizeStyle}
          onChange={(checked) => updateAutoGenConfig({ randomizeStyle: checked })}
        />
        <ToggleRow
          icon={<RepeatIcon className="size-4" />}
          label="出错自动暂停"
          desc="连续失败 3 次自动停止，避免持续消耗 API 额度"
          checked={autoGenConfig.stopOnFailure}
          onChange={(checked) => updateAutoGenConfig({ stopOnFailure: checked })}
        />
        <ToggleRow
          icon={<CircleAlertIcon className="size-4" />}
          label="质量过滤"
          desc="生成后检测模糊 / 空白 / 低清，不达标直接丢弃重抽（连续 5 张自动暂停）"
          checked={autoGenConfig.qualityFilter}
          onChange={(checked) => updateAutoGenConfig({ qualityFilter: checked })}
        />
      </div>

      {autoGenStatus.discardedCount > 0 && autoGenStatus.lastRejectReason && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-all">
            已丢弃 {autoGenStatus.discardedCount} 张质量不达标图片（最近原因：{autoGenStatus.lastRejectReason}）
          </span>
        </div>
      )}

      {autoGenStatus.lastError && (
        <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-2.5 text-xs text-destructive">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-all whitespace-pre-wrap">{autoGenStatus.lastError}</span>
        </div>
      )}

      {autoGenStatus.lastImageUrl && (
        <div className="flex items-center gap-2.5 rounded-xl bg-background p-2.5">
          <img
            src={autoGenStatus.lastImageUrl}
            alt="最近一次自动生成结果"
            className="h-14 w-11 shrink-0 rounded-lg object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold">最近一张自动生成结果</div>
            <div className="text-[11px] text-muted-foreground">已自动保存到下方「生成记录」</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setPreviewUrl(autoGenStatus.lastImageUrl)}>
            查看
          </Button>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        定时任务运行在当前页面内：切换页面不会中断，「立即停止」会马上中断正在进行的请求；刷新或关闭页面后自动停止。出图使用「模型与参数」中当前选择的接口与画风设置；已开启「生成后自动保存」时，每张自动生成的图也会写入所选文件夹。随机配方是否使用 18+ 素材、抽取真人还是二次元服装，由合成台「参考图组合」中的「生图成人模式 / 随机配方 · 服装版本」控制。
      </p>
    </Section>
  )
}
