import { createFileRoute } from '@tanstack/react-router'
import { Section } from '@/components/common/FormSection'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/guide')({
  staticData: { title: '使用指南与免责声明' },
  component: GuidePage,
})

function GuidePage() {
  return (
    <>
      <PageHeader title="使用指南与免责声明" />

      <Section title="角色合成流程" className="@lg/section:grid-cols-3">
        <div className="rounded-2xl bg-background p-4">
          <Badge>1. 人像</Badge>
          <h3 className="mt-2 text-sm font-semibold">人像颜值库 (1,499)</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            挑选五官与发型参考，或在合成台直接上传自定义人像图，锁定角色面部特征。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>2. 服装</Badge>
          <h3 className="mt-2 text-sm font-semibold">服装穿搭库 (2,727 套)</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            真人写实 1,407 套 + 二次元动漫 1,320 套双版本，按分类或标签挑选服饰，自带中英双语生图词条，也支持上传本地服装参考图。动漫服装会自动转译为真实面料与剪裁（真人照片风格），也可搭配二次元画风使用。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>3. 姿势 + 附图</Badge>
          <h3 className="mt-2 text-sm font-semibold">动作姿势库 (1,439)</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            挑选 5 视角 3D 素体白模或深度图（Depth），结合云端 API 或本地 ComfyUI 一键生成角色立绘。本地 Qwen 2.1 支持人像 / 服装 / 姿势任意组合：常规组合沿用模板，非常规组合自动切换为 1~3 图灵活参考工作流；双图模板内部顺序为「图1=姿势、图2=人物/服装」。本地 Qwen 2.1 还会自动使用官方推荐的提示词范式（单段指令 + <code>&lt;image1/2/3&gt;</code> 标签 + 场景布光），见「提示词范式」卡片。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>4. 生图成人模式 (18+)</Badge>
          <h3 className="mt-2 text-sm font-semibold">可选：随机抽取 18+ 素材</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            在合成台「1. 参考图组合」中把生图成人模式设为「混合 18+ / 仅 18+ 素材」，随机配方与定时任务会自动从性感系姿势、双人缠绵、内衣・睡衣、性感穿搭中抽取；默认关闭，开启需通过 18+ 年龄确认。
          </p>
        </div>
      </Section>

      <Section title="定时任务 · 自动随机出图" className="@lg/section:grid-cols-3">
        <div className="rounded-2xl bg-background p-4">
          <Badge>1. 开启</Badge>
          <h3 className="mt-2 text-sm font-semibold">合成台右栏「定时任务」</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            设置随机间隔（如 10–30 秒）与张数上限（0 = 不限），按需开启「随机配方 / 随机画风」，点击「开始」后即按随机间隔持续出图。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>2. 运行</Badge>
          <h3 className="mt-2 text-sm font-semibold">自动切换配方与画风</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            每张自动随机抽取「人像 + 服装 + 姿势」配方（跟随安全模式）并从内置画风预设中随机切换，实时显示成功/失败统计与下一张倒计时。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>3. 停止</Badge>
          <h3 className="mt-2 text-sm font-semibold">随时「立即停止」</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            点击「立即停止」会马上中断正在进行的云端请求或取消本地 ComfyUI 队列任务；任务运行在当前页面内，切换页面不中断，刷新/关闭页面后自动停止。
          </p>
        </div>
      </Section>

      <Section title="提示词范式（提示词引擎）" className="@lg/section:grid-cols-2">
        <div className="rounded-2xl bg-background p-4">
          <Badge>本地 Qwen 2.1</Badge>
          <h3 className="mt-2 text-sm font-semibold">官方单段指令范式（自动启用）</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            本机 ComfyUI 的 Qwen Image 2.1 链路会自动切换为官方推荐的写法：单段连续中文、用 <code>&lt;image1/2/3&gt;</code> 指向参考图、逐图声明角色来源（身份 / 服装 / 动作机位）、肯定式保留声明、并按画风主动写入场景 / 布光 / 构图（不再只写风格词，避免默认白底棚拍感）。姿势描述会按站 / 跪 / 坐 / 卧 / 双人动态生成，与所选姿势不再冲突；**背景由参考图自动驱动**：上传参考图带环境就跟随其场景氛围，素材库白模/人台没有环境信息时则按服装风格、姿势与画风光线自动生成协调的真实背景。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>云端 / 2509</Badge>
          <h3 className="mt-2 text-sm font-semibold">通用分点格式（保持不变）</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Gemini / GPT Image / 云端 Qwen / 豆包与 Qwen-Image-Edit 2509 链路继续使用旧版中文分点格式（人物 / 服装 / 姿势 / 比例 / 细节 / 风格），保证云端出图行为不回归。合成台「提示词」区域顶部会显示当前使用的提示词引擎，提示词仍可手动编辑，点「重置」恢复为自动生成。
          </p>
        </div>
      </Section>

      <Section title="出图质量（比例优化 + 质量过滤）" className="@lg/section:grid-cols-2">
        <div className="rounded-2xl bg-background p-4">
          <Badge>全身比例</Badge>
          <h3 className="mt-2 text-sm font-semibold">按姿势族动态约束 + 默认身材偏好</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            本机 Qwen 2.1 链路会按姿势族（站 / 跪 / 坐 / 俯卧 / 仰卧 / 双人 / 半身）分别生成比例、入镜范围与关节描述，不再对跪卧姿势追加「站姿」等冲突固定句；同时保留默认身材偏好（成年女性成熟匀称、胸部略丰满但自然不夸张）与正向人体结构描述（头颈肩连接、手指与关节完整）。云端链路仍沿用旧版分点约束。若仍不满意，可换用「上半身单人」姿势或调整画风后重试；本机 ComfyUI 可把「出图质量」切到「高质量」模式（更多采样步数 + 解剖负面词，更慢）。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>质量过滤</Badge>
          <h3 className="mt-2 text-sm font-semibold">定时任务自动丢弃差图</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            定时任务默认开启「质量过滤」：每张生成后自动检测模糊、空白、低清晰度、分辨率与曝光异常，不达标直接丢弃并自动重抽（不写入生成记录、不落盘），连续 5 张不达标会自动暂停；手动生成仅在检出问题时提醒，结果仍保留。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>动漫服装兼容</Badge>
          <h3 className="mt-2 text-sm font-semibold">真人脸 + 动漫服装不违和</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            动漫库服装是 2D 线稿/插画：真人照片画风下会自动把它转译为真实面料、剪裁与自然褶皱（不保留线稿/平涂）；也可把画风切到「日系二次元 / 2.5D」让风格统一。「随机配方 · 服装版本」默认「仅真人写实」，可避免随机/定时任务混搭动漫服装；需要时再切「全部版本 / 仅二次元动漫」。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>双人姿势</Badge>
          <h3 className="mt-2 text-sm font-semibold">双人缠绵 = 两位人物</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            「双人缠绵」姿势参考里是两位人物，生成时会自动追加双人构图约束：画面必须同时出现两位成年女性、按参考还原相对站位与肢体互动、两人都完整入镜且都穿上所选服装，不会被合并成单人；姿势槽位会显示「双人」徽标。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>参考项可选</Badge>
          <h3 className="mt-2 text-sm font-semibold">人像 / 服装 / 姿势任意组合</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            三个参考槽都可以按需纳入随机配方（关掉的槽位随机时会清空），手动生成也可直接清空任意槽位；本机 ComfyUI Qwen 2.1 模板会根据已选参考自动切换为 1~3 图灵活参考工作流（未选槽位不参与，脸部由模型自由生成）；「定时任务」自动随机出图同样生效。
          </p>
        </div>
      </Section>

      <Section title="生图保存位置（导出到本地文件夹）" className="@lg/section:grid-cols-3">
        <div className="rounded-2xl bg-background p-4">
          <Badge>1. 选择文件夹</Badge>
          <h3 className="mt-2 text-sm font-semibold">「生成结果」下方 · 生图保存位置</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            点击「选择文件夹」并授权一个本地目录（Chrome / Edge 桌面版支持）。授权结果会保存在当前浏览器，下次打开自动恢复；权限失效时可点「重新授权」。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>2. 自动保存</Badge>
          <h3 className="mt-2 text-sm font-semibold">每张生成结果自动写盘</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            开启「生成后自动保存」后，手动生成的图与定时任务自动生成的图都会以时间戳文件名写入该文件夹，不会覆盖旧图；也可随时点「保存当前」手动导出当前结果。
          </p>
        </div>

        <div className="rounded-2xl bg-background p-4">
          <Badge>3. 兼容回退</Badge>
          <h3 className="mt-2 text-sm font-semibold">不支持时自动下载</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Firefox / Safari 等不支持文件夹 API 的浏览器会自动回退为「生成后自动下载」，保存到浏览器默认下载目录（可在浏览器设置中修改下载位置）。
          </p>
        </div>
      </Section>

      <Section title="免责声明与合规使用规范（必读）" className="@lg/section:grid-cols-1">
        <div className="space-y-2.5 rounded-2xl bg-background p-4 text-xs leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">1. 仅供学习与合法艺术创作（严禁违法）：</strong>
            本项目（含网页工作台、本地 ComfyUI 插件与工作流模板）
            <strong className="text-foreground">仅供个人学习、人体结构研究、插画构图参考与技术交流使用</strong>
            。严禁使用本工具生成、制作或传播任何违反法律法规、淫秽色情、暴力违禁内容，严禁未经他人明确授权上传真实人物照片进行换脸或深伪合成（Deepfake）等侵犯他人肖像权、隐私权与名誉权的行为。
          </p>
          <p>
            <strong className="text-foreground">2. NSFW（18+）敏感内容提示：</strong>
            图库中包含部分成人向 3D 素体姿势（全身单人・性感系、双人缠绵）与内衣/性感穿搭参考，旨在服务绘画与动作设计练习。系统默认开启「安全模式 (SFW)」屏蔽上述分类，
            <strong className="text-rose-600 dark:text-rose-400">未满 18 周岁的未成年人严禁关闭安全模式或访问相关内容</strong>。
          </p>
          <p>
            <strong className="text-foreground">3. 隐私保护与使用者责任归属：</strong>
            本工作台为纯前端本地应用，所有 AI 生图请求均由使用者自行配置的云端 API Key 或使用者本机 ComfyUI 环境直接执行，平台不收集、不存储任何用户上传的图片或生成结果。
            <strong className="text-foreground">因使用者违规使用或不当传播所产生的一切法律责任，均由使用者本人独立承担，与本项目及维护者无关。</strong>
          </p>
        </div>
      </Section>

      <Section title="数据来源与版权说明" className="@lg/section:grid-cols-1">
        <div className="space-y-2.5 rounded-2xl bg-background p-4 text-xs leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">• 原作者版权归属：</strong>
            本仓库收录的全部姿势（<code>ai-pose-gallery.pages.dev</code>、<code>ai-pose-depth-gallery.pages.dev</code>）、服装（<code>ai-costume-gallery.pages.dev</code>）、人像（<code>ai-portrait-gallery.pages.dev</code>）参考图与原始元数据均源自原作者{' '}
            <strong className="text-foreground">ギア（@giaaibusi）</strong> 公开站点，著作权归原作者所有。本仓库仅为中文本地化翻译整理与前端工程学习存档，不对原始图片主张任何所有权。
          </p>
          <p>
            <strong className="text-foreground">• 使用与分发限制：</strong>
            人像库遵循 <strong className="text-emerald-600 dark:text-emerald-400">CC0 1.0 协议</strong>；姿势库与服装库免费供个人学习与 AI 生图参考使用，
            <strong className="text-foreground">严禁将本图库原始图片打包转售或用于付费分发</strong>。
          </p>
        </div>
      </Section>
    </>
  )
}
