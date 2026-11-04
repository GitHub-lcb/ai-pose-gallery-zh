import { idbGet, idbSet } from '@/lib/idbStorage'
import type { SaveFolderPermission } from '@/types/gallery'

// ============================================================================
// 生图保存位置：File System Access API（目录选择 + 直接写入本地文件）
// - 仅 Chrome / Edge 桌面版支持（安全上下文：https 或 localhost）
// - 用户选择文件夹后，生成结果可自动写入该文件夹
// - 不支持时由调用方回退为「自动下载到浏览器默认下载目录」
// ============================================================================

interface DirectoryPermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

export interface FsWritableStreamLike {
  write(data: Blob | BufferSource | string): Promise<void>
  close(): Promise<void>
}

export interface FsFileHandleLike {
  kind: 'file'
  name: string
  createWritable?(): Promise<FsWritableStreamLike>
}

export interface FsDirectoryHandleLike {
  kind: 'directory'
  name: string
  queryPermission?(descriptor?: DirectoryPermissionDescriptor): Promise<PermissionState>
  requestPermission?(descriptor?: DirectoryPermissionDescriptor): Promise<PermissionState>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandleLike>
}

type DirectoryPickerLike = (options?: {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: string
}) => Promise<FsDirectoryHandleLike>

const SAVE_DIR_IDB_KEY = 'pose_atlas_save_dir_v1'
export const SAVE_ENABLED_STORAGE_KEY = 'pose_atlas_save_enabled_v1'

const getPicker = (): DirectoryPickerLike | undefined =>
  (window as unknown as { showDirectoryPicker?: DirectoryPickerLike }).showDirectoryPicker

/** 当前浏览器是否支持「选择本地文件夹」 */
export function isSaveFolderSupported(): boolean {
  if (typeof window === 'undefined') return false
  return typeof getPicker() === 'function'
}

/** 弹出系统文件夹选择器；用户取消时返回 null */
export async function pickSaveFolder(): Promise<FsDirectoryHandleLike | null> {
  const picker = getPicker()
  if (!picker) return null
  try {
    const handle = await picker({ id: 'pose-atlas-output', mode: 'readwrite' })
    // 选择后立即申请读写权限（需要处于用户手势内）
    if (handle.requestPermission) {
      const state = await handle.requestPermission({ mode: 'readwrite' })
      if (state !== 'granted') throw new Error('未获得文件夹读写权限')
    }
    return handle
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NotAllowedError')) {
      // AbortError = 用户取消；NotAllowedError = 非用户手势触发
      if (error.name === 'AbortError') return null
    }
    throw error
  }
}

export async function loadSaveFolderHandle(): Promise<FsDirectoryHandleLike | null> {
  return (await idbGet<FsDirectoryHandleLike>(SAVE_DIR_IDB_KEY)) ?? null
}

export async function persistSaveFolderHandle(handle: FsDirectoryHandleLike | null): Promise<void> {
  await idbSet(SAVE_DIR_IDB_KEY, handle as unknown)
}

const normalizePermission = (state: PermissionState | undefined): SaveFolderPermission => {
  if (state === 'granted') return 'granted'
  if (state === 'denied') return 'denied'
  return 'prompt'
}

export async function querySaveFolderPermission(handle: FsDirectoryHandleLike): Promise<SaveFolderPermission> {
  if (!handle.queryPermission) return 'granted'
  try {
    return normalizePermission(await handle.queryPermission({ mode: 'readwrite' }))
  } catch {
    return 'prompt'
  }
}

/** 申请读写权限（必须在用户点击等手势中调用才可靠） */
export async function requestSaveFolderPermission(handle: FsDirectoryHandleLike): Promise<boolean> {
  if (!handle.requestPermission) return true
  try {
    return normalizePermission(await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

const extFromBlob = (blob: Blob): string => EXT_BY_MIME[blob.type.toLowerCase()] ?? 'png'

const pad = (value: number): string => String(value).padStart(2, '0')

/** 生成文件图片名：gen-20261104-213012-123.png */
export function buildImageFileName(prefix: string, ext: string, now = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-` +
    String(now.getMilliseconds()).padStart(3, '0')
  return `${prefix}-${stamp}.${ext}`
}

/**
 * 把生成结果（dataURL 或 http(s) URL）转成 Blob。
 * 优先 fetch；跨域失败时尝试 <img> + Canvas（图片本身允许跨域读取时可用）。
 */
export async function imageUrlToBlob(imageUrl: string): Promise<Blob | null> {
  try {
    const response = await fetch(imageUrl)
    if (response.ok) {
      const blob = await response.blob()
      if (blob.size > 0) return blob
    }
  } catch {
    /* 继续走 Canvas 兜底 */
  }
  try {
    return await new Promise<Blob | null>((resolve) => {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth || 1024
          canvas.height = image.naturalHeight || 1024
          canvas.getContext('2d')?.drawImage(image, 0, 0)
          canvas.toBlob((blob) => resolve(blob && blob.size > 0 ? blob : null), 'image/png')
        } catch {
          resolve(null)
        }
      }
      image.onerror = () => resolve(null)
      image.src = imageUrl
    })
  } catch {
    return null
  }
}

/**
 * 把生成图片写入用户选择的文件夹，返回文件名。
 * 注意：调用前应先确保目录读写权限已授予。
 */
export async function saveImageUrlToFolder(
  handle: FsDirectoryHandleLike,
  imageUrl: string,
  prefix: string
): Promise<{ fileName: string; size: number }> {
  const blob = await imageUrlToBlob(imageUrl)
  if (!blob) throw new Error('无法读取生成图片（跨域或格式受限），请改用「下载图片」')
  const fileName = buildImageFileName(prefix, extFromBlob(blob))
  const fileHandle = await handle.getFileHandle(fileName, { create: true })
  if (!fileHandle.createWritable) throw new Error('当前浏览器不支持写入文件')
  const writable = await fileHandle.createWritable()
  try {
    await writable.write(blob)
  } finally {
    await writable.close()
  }
  return { fileName, size: blob.size }
}

/** 浏览器不支持选择文件夹时的兜底：直接下载到浏览器默认下载目录，返回文件名 */
export async function downloadGeneratedImage(imageUrl: string, prefix: string): Promise<string> {
  const blob = await imageUrlToBlob(imageUrl)
  const fileName = buildImageFileName(prefix, blob ? extFromBlob(blob) : 'png')
  const href = blob ? URL.createObjectURL(blob) : imageUrl
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  if (blob) window.setTimeout(() => URL.revokeObjectURL(href), 4000)
  return fileName
}
