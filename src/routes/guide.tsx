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
            挑选 5 视角 3D 素体白模或深度图（Depth），结合云端 API 或本地 ComfyUI 一键生成角色立绘。
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

      <Section title="出图质量（比例优化 + 质量过滤）" className="@lg/section:grid-cols-2">
        <div className="rounded-2xl bg-background p-4">
          <Badge>全身比例</Badge>
          <h3 className="mt-2 text-sm font-semibold">头身比 + 默认身材偏好</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            全身 / 双人姿势会自动在提示词中追加「约 7~7.5 头身、头部不要偏大、避免大头小身/幼态比例、躯干与四肢协调、头顶与脚部完整」等约束，减少全身照比例失真；所有带人物的生成还会追加默认身材偏好（成年女性成熟匀称、胸部略丰满但自然不夸张）。若仍不满意，可换用「上半身单人」姿势或调整画风后重试。
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
