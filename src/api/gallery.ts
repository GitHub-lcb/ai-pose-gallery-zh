import { queryOptions } from '@tanstack/react-query'
import type { CostumeItem, PortraitItem, PoseGroup, PoseItem, RecipeState } from '@/types/gallery'

export const ANGLES = ['正面', '俯视', '仰视', '侧面', '斜侧'] as const

export const PREFERRED_POSE_LINE_ORDER = [
  '全身单人・标准系',
  '上半身单人',
  '全身单人・性感系',
  '双人缠绵',
] as const

export const NSFW_POSE_SYSTEMS = new Set(['全身单人・性感系', '双人缠绵'])
export const NSFW_COSTUME_CATEGORIES = new Set(['内衣・睡衣', '性感穿搭'])
/** 本机 Codex 订阅网关的图片审核实测会直接拒绝泳装类参考图（与提示词无关），随机池需剔除以提高成功率 */
export const GATEWAY_UNSAFE_COSTUME_CATEGORIES = new Set(['泳装・度假'])

export function isNsfwPoseSystem(system: string): boolean {
  return NSFW_POSE_SYSTEMS.has(system)
}

export function isNsfwPose(item: PoseItem | PoseGroup): boolean {
  const sys = '体系' in item ? item.体系 : item.system
  return NSFW_POSE_SYSTEMS.has(sys)
}

export function isNsfwCostumeCategory(category: string): boolean {
  return NSFW_COSTUME_CATEGORIES.has(category)
}

export function isNsfwCostume(item: CostumeItem): boolean {
  return NSFW_COSTUME_CATEGORIES.has(item.分类)
}

/** 订阅网关会因这类参考图触发 sexual 安全审核（实测：泳装分类 100% 拒绝） */
export function isGatewayUnsafeCostume(item: CostumeItem): boolean {
  return isNsfwCostume(item) || GATEWAY_UNSAFE_COSTUME_CATEGORIES.has(item.分类)
}

/**
 * 本机 Codex 订阅网关的生成前校验：配方里是否包含高风险参考素材。
 * 返回问题描述（如「服装「泳装・度假」」）；null 表示通过。
 * 随机配方在选取后会调用它，不通过则自动再随机一次。
 */
export function codexGatewayRecipeIssue(recipe: RecipeState): string | null {
  const costume = recipe.costume
  if (costume && costume.source !== 'upload' && isGatewayUnsafeCostume(costume)) {
    return `服装「${costume.分类}」`
  }
  const pose = recipe.pose
  if (pose && pose.source !== 'upload' && isNsfwPoseSystem(pose.体系)) {
    return `姿势「${pose.体系}」`
  }
  return null
}

export function buildPoseGroups(items: PoseItem[]): { items: PoseItem[]; groups: PoseGroup[]; lines: string[] } {
  const rawLines = [...new Set(items.map((x) => x.体系))]
  const lines = rawLines.sort((a, b) => {
    const ia = PREFERRED_POSE_LINE_ORDER.indexOf(a as (typeof PREFERRED_POSE_LINE_ORDER)[number])
    const ib = PREFERRED_POSE_LINE_ORDER.indexOf(b as (typeof PREFERRED_POSE_LINE_ORDER)[number])
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  const groupMap = new Map<string, PoseGroup>()
  const groups: PoseGroup[] = []

  for (const item of items) {
    const key = `${item.体系}|${item.姿势编号 || item.id}`
    let group = groupMap.get(key)
    if (!group) {
      group = {
        key,
        system: item.体系,
        number: item.姿势编号,
        name: item.姿势名称,
        category: item.分类,
        items: [],
        angles: {},
        order: [],
      }
      groupMap.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
    if (item.角度 && !group.angles[item.角度]) {
      group.angles[item.角度] = item
    }
  }

  groups.sort((a, b) => lines.indexOf(a.system) - lines.indexOf(b.system) || String(a.number).localeCompare(String(b.number)))
  for (const group of groups) {
    group.order = ANGLES.map((a) => group.angles[a]).filter(Boolean)
    for (const item of group.items) {
      if (!group.order.includes(item)) group.order.push(item)
    }
  }

  return { items, groups, lines }
}

export const posesQuery = queryOptions({
  queryKey: ['gallery', 'poses'],
  staleTime: Infinity,
  queryFn: async () => {
    const res = await fetch('/data/pose-zh.json')
    if (!res.ok) throw new Error(`加载姿势数据失败: HTTP ${res.status}`)
    const data = (await res.json()) as PoseItem[]
    return buildPoseGroups(data)
  },
})

export const costumesQuery = queryOptions({
  queryKey: ['gallery', 'costumes'],
  staleTime: Infinity,
  queryFn: async () => {
    const res = await fetch('/data/costume-zh.json')
    if (!res.ok) throw new Error(`加载服装数据失败: HTTP ${res.status}`)
    return (await res.json()) as CostumeItem[]
  },
})

export const portraitsQuery = queryOptions({
  queryKey: ['gallery', 'portraits'],
  staleTime: Infinity,
  queryFn: async () => {
    const res = await fetch('/data/portrait-zh.json')
    if (!res.ok) throw new Error(`加载人像数据失败: HTTP ${res.status}`)
    return (await res.json()) as PortraitItem[]
  },
})
