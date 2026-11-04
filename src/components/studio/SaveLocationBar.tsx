import { CircleAlertIcon, DownloadIcon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useStudio } from '@/store/studioStore'

/**
 * 生图保存位置：选择本地文件夹后，生成结果可自动写入该文件夹。
 * Chrome / Edge 支持 File System Access API；不支持的浏览器可回退为自动下载。
 */
export function SaveLocationBar() {
  const {
    saveLocation,
    chooseSaveFolder,
    authorizeSaveFolder,
    clearSaveFolder,
    toggleAutoSave,
    saveCurrentImage,
    previewUrl,
    isGenerating,
  } = useStudio()
  const { supported, folderName, permission, enabled, lastSavedName, lastError } = saveLocation
  const hasFolder = Boolean(folderName)
  const authorized = hasFolder && permission === 'granted'

  const hint = !supported
    ? '当前浏览器不支持选择文件夹（需 Chrome / Edge 桌面版），可开启「自动下载」保存到浏览器默认下载目录。'
    : hasFolder
      ? authorized
        ? `生成结果会自动写入「${folderName}」，同时保留在浏览器生成记录中。`
        : '文件夹权限已失效，点击「重新授权」恢复自动保存。'
      : '选择一个本地文件夹后，生成结果可直接保存为图片文件（需 Chrome / Edge）。'

  return (
    <div className="rounded-2xl bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FolderIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
              生图保存位置
              {hasFolder && (
                <Badge
                  variant={authorized ? 'secondary' : 'destructive'}
                  className="max-w-[180px] truncate font-mono text-[10px]"
                >
                  <FolderOpenIcon />
                  {folderName}
                </Badge>
              )}
            </div>
            <div className="text-[11px] leading-snug text-muted-foreground">{hint}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {supported && !hasFolder && (
            <Button size="sm" variant="outline" onClick={() => void chooseSaveFolder()}>
              <FolderIcon className="size-3.5" />
              选择文件夹
            </Button>
          )}
          {hasFolder && permission !== 'granted' && (
            <Button size="sm" variant="outline" onClick={() => void authorizeSaveFolder()}>
              重新授权
            </Button>
          )}
          {hasFolder && (
            <>
              <Button size="sm" variant="ghost" onClick={() => void chooseSaveFolder()}>
                更换
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void clearSaveFolder()}>
                清除
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" disabled={!previewUrl || isGenerating} onClick={() => void saveCurrentImage()}>
            <DownloadIcon className="size-3.5" />
            保存当前
          </Button>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium select-none">
          <Switch checked={enabled} onCheckedChange={(value) => toggleAutoSave(value)} aria-label="生成后自动保存" />
          {supported ? '生成后自动保存到该文件夹' : '生成后自动下载到默认下载目录'}
        </label>
        <div className="min-w-0 break-all text-[11px] text-muted-foreground">
          {lastSavedName
            ? `最近保存：${lastSavedName}`
            : supported
              ? '文件名按生成时间自动命名，不会覆盖旧图'
              : '可在浏览器设置中修改默认下载目录'}
        </div>
      </div>

      {lastError && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-destructive">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-all">{lastError}</span>
        </div>
      )}
    </div>
  )
}
