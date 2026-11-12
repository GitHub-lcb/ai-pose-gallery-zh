#!/usr/bin/env node
/**
 * 提示词构建器回归测试（Node 24 原生 TypeScript 类型擦除，无需构建）
 *
 * 用法：node scripts/check-prompts.mjs
 *
 * 断言两套提示词范式的关键契约：
 *  - qwen21（本地 Qwen Image 2.1）：单段、无分点、多图 <imageN>、无「图N」指代、
 *    无否定句/分辨率/质量堆词、长度在规范区间内、所有画风预设均可通过 lint；
 *  - classic（云端 / 2509）：保持旧版分点结构与「图N」指代，避免行为回归。
 */
import { buildRecipePrompt, getPromptProfile, lintQwen21Prompt, STYLE_PRESETS } from '../src/services/recipePrompt.ts'

let failed = 0
let passed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

const portrait = {
  id: 'p1',
  分区: '正脸参考',
  发长: '中长发',
  发型名称: '中长狼尾卷发',
  标题: '中长发・中长狼尾卷发',
  宽: 1600,
  高: 2000,
  字节数: 1,
  精选: true,
  热门: true,
  缩略图: 'thumbs/portrait/p1.webp',
  原图: 'img/portrait/p1.webp',
  检索: '',
}
const costume = {
  id: 'c1',
  版本: '真人',
  分类: '秋季穿搭',
  服装名称: '灰色针织迷你连衣裙・黑色连裤袜・靴子・毛绒包',
  标签: ['灰色', '针织'],
  关键词: 'grey knit dress',
  缩略图: 'thumbs/costume/c1.webp',
  预览图: 'img/costume/c1.webp',
  原图: 'img/costume/c1.webp',
  检索: '',
}
const animeCostume = { ...costume, id: 'c2', 版本: '二次元', 服装名称: '水手服・百褶裙' }
const pose = {
  id: 'pose1',
  体系: '全身单人・性感系',
  姿势编号: 'P1',
  分类: '跪姿',
  姿势名称: '跪立・上体后仰・双手抱后脑',
  角度: '正面',
  缩略图: 'thumbs/pose/p1.jpg',
  原图: 'img/pose/p1.png',
  检索: '',
}
const pronePose = { ...pose, id: 'pose2', 分类: '卧姿', 姿势名称: '俯卧・单手托胸', 角度: '俯视' }
const supinePose = { ...pose, id: 'pose3', 分类: '卧姿', 姿势名称: '仰卧・双腿竖直向上', 角度: '仰视' }
const pairPose = { ...pose, id: 'pose4', 体系: '双人缠绵', 姿势名称: '相拥・面对面贴近', 角度: '斜前' }
const uploadPortrait = { ...portrait, source: 'upload' }
const uploadPose = { ...pose, source: 'upload' }

const qwen21 = (recipe, style = 'realistic', imageOrder) =>
  buildRecipePrompt(recipe, style, [], { profile: 'qwen21', imageOrder })
const classic = (recipe, style = 'realistic', imageOrder) =>
  buildRecipePrompt(recipe, style, [], { profile: 'classic', imageOrder })

// ---------------------------------------------------------------------------
// 1. 提示词范式选择：只有 Qwen 2.1 工作流走官方范式
// ---------------------------------------------------------------------------
const configOf = (preset, provider = 'comfyui') => ({
  activeProvider: provider,
  comfyuiParams: { workflowPreset: preset },
})
check('qwen21_local_3img → qwen21', getPromptProfile(configOf('qwen21_local_3img')) === 'qwen21')
check('qwen21_local_2img → qwen21', getPromptProfile(configOf('qwen21_local_2img')) === 'qwen21')
check('qwen21_3img → qwen21', getPromptProfile(configOf('qwen21_3img')) === 'qwen21')
check('qwen2509_3img → classic', getPromptProfile(configOf('qwen2509_3img')) === 'classic')
check('云端 Gemini → classic', getPromptProfile(configOf('qwen21_local_3img', 'gemini')) === 'classic')

// ---------------------------------------------------------------------------
// 2. qwen21 三图合成：单段 + 标签 + 正向 + 场景
// ---------------------------------------------------------------------------
const threeOrder = ['portrait', 'costume', 'pose']
for (const [name, recipe] of [
  ['三图（人像+服装+姿势）', { portrait, costume, pose }],
  ['三图（动漫服装）', { portrait, costume: animeCostume, pose }],
  ['三图（俯卧姿势）', { portrait, costume, pose: pronePose }],
  ['三图（仰卧姿势）', { portrait, costume, pose: supinePose }],
  ['三图（双人姿势）', { portrait, costume, pose: pairPose }],
  ['三图（上传人像）', { portrait: uploadPortrait, costume, pose }],
  ['三图（上传姿势）', { portrait, costume, pose: uploadPose }],
]) {
  const text = qwen21(recipe, 'realistic', threeOrder)
  const issues = lintQwen21Prompt(text, 3)
  check(`${name} 通过 lint`, issues.length === 0, JSON.stringify(issues))
  check(`${name} 为单段`, !text.includes('\n'))
  check(`${name} 使用 <image1>~<image3>`, /<image1>/.test(text) && /<image2>/.test(text) && /<image3>/.test(text))
  check(`${name} 不含「图N」`, !/图[1-9](?!\d)|图一(?!致)|第一张图/.test(text))
  check(`${name} 长度合规`, text.length >= 250 && text.length <= 800, `实际 ${text.length} 字`)
  check(`${name} 含场景/布光`, /光/.test(text) && /背景|场景/.test(text))
}

// 姿势族动态化：不同姿势的比例/入镜句必须不同且不与姿势冲突
const standText = qwen21({ portrait, costume, pose: { ...pose, 分类: '站姿', 姿势名称: '站姿・双手叉腰' } }, 'realistic', threeOrder)
const kneelText = qwen21({ portrait, costume, pose }, 'realistic', threeOrder)
const proneText = qwen21({ portrait, costume, pose: pronePose }, 'realistic', threeOrder)
check('站姿提示词写站姿', /站姿|双脚着地/.test(standText))
check('跪姿提示词写跪立', /跪立/.test(kneelText))
check('俯卧提示词不写「站姿与关节」', !/站姿与关节/.test(proneText))
check('不同姿势族的构图句不同', new Set([standText, kneelText, proneText].map((t) => t.match(/镜头为[^。]+/)?.[0])).size === 3)

// ---------------------------------------------------------------------------
// 2b. 落地规则回归：配饰穷尽 / 姿势硬锁 / 机位不被风格模板覆盖 / 躺卧兼容场景
// ---------------------------------------------------------------------------
const threeText = qwen21({ portrait, costume, pose }, 'realistic', threeOrder)
for (const part of costume.服装名称.split('・')) {
  check(`配饰穷尽：枚举包含「${part}」`, threeText.includes(part))
}
check('配饰穷尽：有「完整保留…每一件单品与配饰」声明', /完整保留<image2>中展示的每一件单品与配饰/.test(threeText))

for (const [name, poseItem, axis] of [
  ['俯卧', pronePose, '身体水平趴伏在地面上'],
  ['仰卧', supinePose, '身体平躺在地面上'],
  ['跪立', pose, '双膝着地承重、小腿贴地'],
]) {
  const text = qwen21({ portrait, costume, pose: poseItem }, 'realistic', threeOrder)
  check(`姿势硬锁（${name}）：写身体轴/支撑点`, text.includes(axis))
  check(`姿势硬锁（${name}）：镜头机位与 <image3> 完全一致`, text.includes('镜头机位与<image3>完全一致'))
  check(`姿势硬锁（${name}）：不由风格模板写死平视视角`, !text.includes('平视视角'))
}

const filmProne = qwen21({ portrait, costume, pose: pronePose }, 'film', threeOrder)
check('躺卧 + 胶片风格：背景改为室内兼容环境', /卧室床品环境/.test(filmProne) && !/城市街道/.test(filmProne))
const filmStand = qwen21({ portrait, costume, pose: { ...pose, 分类: '站姿', 姿势名称: '站姿・双手叉腰' } }, 'film', threeOrder)
check('站姿 + 胶片风格：背景按服装推导（非固定场景清单）', /画面背景依据参考图/.test(filmStand))
check('画面洁净句存在（允许的洁净约束）', /没有文字、标志或水印/.test(threeText))

// 背景改为「参考图 + 服装/姿势驱动」，不再有写死的场景下拉
const realisticDefault = qwen21({ portrait, costume, pose }, 'realistic', threeOrder)
check('写实画风：背景由参考图内容自动生成', /画面背景依据参考图/.test(realisticDefault))
check('写实画风：不再固定浅灰摄影棚', !/浅灰色无缝背景/.test(realisticDefault))
const swimCostume = { ...costume, 分类: '泳装・度假', 服装名称: '白色比基尼・沙滩罩衫', 标签: ['泳装'] }
check('服装内容驱动背景：泳装 → 海边/泳池', /海边|泳池/.test(qwen21({ portrait, costume: swimCostume, pose }, 'realistic', threeOrder)))
const sleepCostume = { ...costume, 分类: '内衣・睡衣', 服装名称: '蕾丝睡裙・真丝吊带', 标签: ['睡衣'] }
check('服装内容驱动背景：睡衣 → 卧室/私密室内', /卧室|私密室内/.test(qwen21({ portrait, costume: sleepCostume, pose }, 'realistic', threeOrder)))
const galaCostume = { ...costume, 分类: '派对・礼服', 服装名称: '晚宴礼服・高跟鞋', 标签: ['礼服'] }
check('服装内容驱动背景：礼服 → 宴会厅/典雅室内', /宴会厅|典雅的室内/.test(qwen21({ portrait, costume: galaCostume, pose }, 'realistic', threeOrder)))
check('躺卧姿势背景自动兼容：卧室床品', /卧室床品环境/.test(qwen21({ portrait, costume, pose: supinePose }, 'realistic', threeOrder)))

// 上传参考图带场景 → 跟随参考图
const uploadPoseScene = { ...pose, source: 'upload', 分类: '上传', 体系: '上传', 姿势名称: '上传姿势', 角度: '' }
const uploadSceneText = qwen21({ portrait, costume, pose: uploadPoseScene }, 'realistic', threeOrder)
check('上传姿势参考图：背景跟随参考图', /背景、环境与整体光线参考<image3>的场景氛围/.test(uploadSceneText))
check('上传姿势参考图：措辞按「人物」而非人体模型', /<image3>中人物的动作/.test(uploadSceneText) && !/中人体模型的动作/.test(uploadSceneText))
check('上传参考图为白底时：自动补真实环境', /纯色或白底/.test(uploadSceneText))
const uploadPortraitScene = qwen21({ portrait: { ...portrait, source: 'upload' }, costume: null, pose: null }, 'realistic', ['portrait'])
check('上传人像单图：背景跟随上传参考图', /背景、环境与整体光线参考上传的人像参考图/.test(uploadPortraitScene))

// classic 范式同样走参考图驱动背景（云端落地）
const classicBackground = classic({ portrait, costume, pose }, 'realistic', threeOrder)
check('classic 范式：写实类背景按参考图推导', classicBackground.includes('• 场景：画面背景依据参考图'))
check('classic 范式：保留基本风格与结构', classicBackground.includes('• 风格：') && classicBackground.includes('\n'))

// 姿势分类：库里存在「分类=趴卧、名称=仰卧…」的脏数据，必须按名称判为仰卧
const supersededPose = { ...pose, 分类: '趴卧', 姿势名称: '仰卧V字开腿（双腿抬起）', 角度: '正面' }
const supersedText = qwen21({ portrait, costume, pose: supersededPose }, 'realistic', threeOrder)
check('分类脏数据（趴卧 + 名称仰卧）：按仰卧处理', /身体平躺在地面上/.test(supersedText) && !/身体水平趴伏/.test(supersedText))

// ---------------------------------------------------------------------------
// 3. 参考组合与编号规则
// ---------------------------------------------------------------------------
const ppText = qwen21({ portrait, costume: null, pose }, 'realistic', ['pose', 'portrait'])
check('双图固定模板：姿势是 <image1>、人像是 <image2>', /<image1>中人体模型/.test(ppText) && /<image2>中的人物/.test(ppText))
check('双图固定模板不含 <image3>', !/<image3>/.test(ppText))

const cpText = qwen21({ portrait: null, costume, pose }, 'realistic', ['pose', 'costume'])
check('服装+姿势：姿势 <image1>、服装 <image2>', /<image1>中人体模型/.test(cpText) && /<image2>展示的整套服装/.test(cpText))
check('服装+姿势：自由生成面部（正向句）', /面部自然/.test(cpText))

const singlePoseText = qwen21({ portrait: null, costume: null, pose }, 'realistic', ['pose'])
check('仅姿势单图：不使用 <imageN> 标签', !/<image\d>/.test(singlePoseText))
check('仅姿势单图：自然指代人体模型', /人体模型/.test(singlePoseText))

const singlePortraitText = qwen21({ portrait, costume: null, pose: null }, 'realistic', ['portrait'])
check('仅人像单图：不使用 <imageN> 标签', !/<image\d>/.test(singlePortraitText))

// 空配方回退提示
check('空配方给出引导文案', qwen21({ portrait: null, costume: null, pose: null }, 'realistic', []) === '请先选择人像/服装/姿势或上传附加参考图。')

// ---------------------------------------------------------------------------
// 4. 所有画风预设都产出合规的 qwen21 提示词
// ---------------------------------------------------------------------------
for (const styleKey of Object.keys(STYLE_PRESETS)) {
  const text = qwen21({ portrait, costume, pose }, styleKey, threeOrder)
  const issues = lintQwen21Prompt(text, 3)
  check(`画风 ${styleKey} 通过 lint`, issues.length === 0, JSON.stringify(issues))
  const styleInfo = STYLE_PRESETS[styleKey]
  if (styleInfo.scene) {
    check(`画风 ${styleKey} 使用画风自带场景（风格化）`, text.includes(styleInfo.scene))
  } else {
    check(`画风 ${styleKey} 使用参考图驱动背景`, /画面背景依据参考图/.test(text))
  }
  check(`画风 ${styleKey} 有收束句`, text.endsWith(`${styleInfo.closing}。`))
}

// ---------------------------------------------------------------------------
// 5. classic 范式保持旧行为（云端 / 2509 不回归）
// ---------------------------------------------------------------------------
const classicText = classic({ portrait, costume, pose }, 'realistic', threeOrder)
check('classic 仍为分点结构', classicText.includes('• 人物：') && classicText.includes('\n'))
check('classic 仍使用「图N」指代', classicText.includes('图1') && classicText.includes('图2') && classicText.includes('图3'))
check('classic 保留风格关键词', classicText.includes('85mm 人像镜头'))
check('classic 比例固定句已改为姿态（不再强制站姿）', classicText.includes('姿态与关节自然') && !classicText.includes('站姿与关节自然'))
check(
  'classic 双图固定模板仍交换图号',
  classic({ portrait, costume: null, pose }, 'realistic', ['pose', 'portrait']).includes('图1中的人物')
)

// ---------------------------------------------------------------------------
// 6. Codex 订阅安全范式（本机 127.0.0.1 / localhost 网关专用中性措辞）
// ---------------------------------------------------------------------------
const gatewayConfig = (baseUrl) => ({ activeProvider: 'gpt', providers: { gpt: { baseUrl } } })
check('本机 127.0.0.1 网关 → codex', getPromptProfile(gatewayConfig('http://127.0.0.1:8788/v1')) === 'codex')
check('localhost 网关 → codex', getPromptProfile(gatewayConfig('http://localhost:8788/v1')) === 'codex')
check('官方 OpenAI API → classic', getPromptProfile(gatewayConfig('https://api.openai.com/v1')) === 'classic')
check(
  '其它 provider 即使配本地地址也不走 codex',
  getPromptProfile({ activeProvider: 'gemini', providers: { gpt: { baseUrl: 'http://127.0.0.1:8788/v1' } } }) === 'classic'
)
const codexText = buildRecipePrompt({ portrait, costume, pose }, 'realistic', [], { profile: 'codex' })
check('codex 不含敏感身材/皮肤措辞（胸部/裸露/镂空/腰胯/幼态）', !/胸部|裸露|镂空|腰胯|幼态/.test(codexText), codexText.match(/胸部|裸露|镂空|腰胯|幼态/)?.[0] ?? '')
check('codex 仍为分点结构并保留图N指代', codexText.includes('\n') && codexText.includes('图1') && codexText.includes('图3'))
check('codex 含中性着装收束句', codexText.includes('着装完整得体'))
const codexPoseOnly = buildRecipePrompt({ portrait: null, costume: null, pose }, 'anime', [], { profile: 'codex' })
check('codex 任意画风仍可构建', codexPoseOnly.length > 100 && !/胸部|裸露/.test(codexPoseOnly))

// ---------------------------------------------------------------------------
// 7. 桌面壁纸预设（wallpaper）：横版构图 + 中性措辞 + 三图自动组装
// ---------------------------------------------------------------------------
const wallpaperText = buildRecipePrompt({ portrait, costume, pose }, 'wallpaper', [], { profile: 'codex' })
check('壁纸预设：横版构图 + 三分线 + 负空间', /横版/.test(wallpaperText) && /三分线/.test(wallpaperText) && /负空间/.test(wallpaperText))
check('壁纸预设：真人写实 + 无文字约束', /真实的?人物照片|真人/.test(wallpaperText) && /没有文字/.test(wallpaperText))
check(
  '壁纸预设：不含高风险词',
  !/sexy|seductive|cleavage|lingerie|bikini|form-fitting|high slit|off-shoulder|性感|裸露/i.test(wallpaperText)
)
check('壁纸预设：classic 范式同样生效', buildRecipePrompt({ portrait, costume, pose }, 'wallpaper', [], { profile: 'classic' }).includes('横版'))

// ---------------------------------------------------------------------------
// 8. 人物数量约束：非双人姿势必须显式单人；双人姿势不得冲突
// ---------------------------------------------------------------------------
const classicSingle = classic({ portrait, costume, pose }, 'realistic', threeOrder)
check('非双人：显式单人构图约束', classicSingle.includes('单人构图') && classicSingle.includes('只有一位成年女性'))
check('非双人：禁止第二人物 / 人体模型 / 人台', /不要出现第二位人物/.test(classicSingle) && /人体模型/.test(classicSingle) && /人台/.test(classicSingle))
const classicPair = classic({ portrait, costume, pose: pairPose }, 'realistic', threeOrder)
check('双人姿势：要求两人且不加单人约束', classicPair.includes('双人构图') && !classicPair.includes('只有一位成年女性'))
const classicStitched = buildRecipePrompt({ portrait, costume, pose }, 'realistic', [], { profile: 'classic', stitchedSheet: true })
check('附带拼图：声明拼图仅参考、不是构图', /参考拼图/.test(classicStitched) && /不是成品构图/.test(classicStitched))
check('codex 非双人：同样带单人约束', buildRecipePrompt({ portrait, costume, pose }, 'realistic', [], { profile: 'codex' }).includes('只有一位成年女性'))

// ---------------------------------------------------------------------------
// 9. 群像模式（画面人数 2~5：服装相似、人脸不同、姿势不同）
// ---------------------------------------------------------------------------
const crowd4 = buildRecipePrompt({ portrait, costume, pose }, 'wallpaper', [], { profile: 'classic', characterCount: 4 })
check('群像：人数准确声明', crowd4.includes('4 位成年女性') && /有且仅有 4 位成年女性/.test(crowd4))
check('群像：人脸各不相同', /每个人的脸型、五官、发型都不同/.test(crowd4) && /不要重复同一张脸/.test(crowd4))
check('群像：姿势与站位各不相同', /姿势与站位各不相同/.test(crowd4))
check('群像：服装相似统一', /同款或近似款/.test(crowd4) && /服装风格统一/.test(crowd4))
check('群像：不再出现单人约束', !crowd4.includes('只有一位成年女性'))
check('群像：9 人可用', buildRecipePrompt({ portrait, costume, pose }, 'realistic', [], { profile: 'classic', characterCount: 9 }).includes('9 位成年女性'))
check('群像：超过 9 人自动收敛为 9', buildRecipePrompt({ portrait, costume, pose }, 'realistic', [], { profile: 'classic', characterCount: 12 }).includes('9 位成年女性'))
const crowdWithPairPose = buildRecipePrompt({ portrait, costume, pose: pairPose }, 'realistic', [], { profile: 'classic', characterCount: 3 })
check('群像 + 双人姿势：以人数为准、无双人/单人冲突', crowdWithPairPose.includes('3 位成年女性') && !crowdWithPairPose.includes('双人构图') && !crowdWithPairPose.includes('只有一位成年女性'))
check('群像构图：人物铺满画面、不再留大面积负空间', crowd4.includes('铺满画面') && !crowd4.includes('大面积干净负空间'))
const singleWallpaper = buildRecipePrompt({ portrait, costume, pose }, 'wallpaper', [], { profile: 'classic' })
check('单人壁纸：仍保留桌面负空间', singleWallpaper.includes('负空间'))
const crowdConciseFill = buildRecipePrompt({ portrait, costume, pose }, 'wallpaper', [], { profile: 'codex', verbosity: 'concise', characterCount: 9 })
check('简洁群像：9 人铺满画面', crowdConciseFill.includes('9 位成年女性') && crowdConciseFill.includes('铺满画面') && !crowdConciseFill.includes('大面积干净负空间'))

// ---------------------------------------------------------------------------
// 10. 简洁范式（参考图优先：只写必要绑定 + 人数 + 场景 + 风格）
// ---------------------------------------------------------------------------
const conciseSingle = buildRecipePrompt({ portrait, costume, pose }, 'realistic', [], { profile: 'classic', verbosity: 'concise' })
check('简洁：保留图1/图2/图3 绑定', conciseSingle.includes('图1') && conciseSingle.includes('图2') && conciseSingle.includes('图3'))
check(
  '简洁：不复述五官/服装/身材/关节长描述',
  !/胸部|裸露|腰胯|幼态|每只手 5 根手指|人体比例|身材（默认偏好）/.test(conciseSingle)
)
check(
  '简洁：明显短于详细版',
  conciseSingle.length < 500 && conciseSingle.length < classic({ portrait, costume, pose }, 'realistic', threeOrder).length,
  `简洁 ${conciseSingle.length} 字`
)
const conciseMulti = buildRecipePrompt({ portrait, costume, pose }, 'wallpaper', [], {
  profile: 'codex',
  verbosity: 'concise',
  characterCount: 4,
})
check(
  '简洁群像：人数/脸/姿势一句到位',
  conciseMulti.includes('4 位成年女性') && /每个人的脸型、五官必须不同/.test(conciseMulti) && /姿势与站位各不相同/.test(conciseMulti)
)
check('简洁群像：无双人/单人冲突', !conciseMulti.includes('双人构图') && !conciseMulti.includes('只有一位成年女性'))
check('简洁壁纸：含横版构图', /横版/.test(conciseMulti))
check('简洁 codex：无敏感身材措辞', !/胸部|裸露|腰胯|幼态/.test(conciseMulti))
check('简洁：水印约束不重复', (conciseMulti.match(/画面中没有文字/g) || []).length === 1)

// ---------------------------------------------------------------------------
console.log(`\n提示词回归检查：${passed} 项通过，${failed} 项失败`)
if (failed > 0) process.exit(1)

