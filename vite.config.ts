import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type UserConfig } from 'vite'

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

// 开发与预览时：
// 1. 直接挂载仓库根目录下的 data/、thumbs/、img/，避免拷贝 6.8 GB 素材
// 2. 提供 /api/proxy 同源转发接口，解决 DashScope (Qwen) / 火山方舟 (Doubao) 官方接口的浏览器 CORS 限制
function localAssetsAndProxyPlugin(): Plugin {
  const rootDir = import.meta.dirname
  const prefixes = ['/data/', '/thumbs/', '/img/', '/og-cover.jpg', '/robots.txt', '/sitemap.xml']

  const handleProxy = async (req: any, res: any) => {
    try {
      const targetUrl = req.headers['x-target-url'] as string | undefined
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: { message: 'Missing or invalid x-target-url header' } }))
        return
      }

      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const rawBody = Buffer.concat(chunks)

      const forwardHeaders: Record<string, string> = {}
      const contentType = req.headers['content-type']
      if (contentType) forwardHeaders['Content-Type'] = contentType
      const auth = req.headers['authorization']
      if (auth) forwardHeaders['Authorization'] = auth
      const googKey = req.headers['x-goog-api-key']
      if (googKey) forwardHeaders['x-goog-api-key'] = googKey as string
      const dashAsync = req.headers['x-dashscope-async']
      if (dashAsync) forwardHeaders['X-DashScope-Async'] = dashAsync as string

      const upstream = await fetch(targetUrl, {
        method: req.method || 'POST',
        headers: forwardHeaders,
        body: rawBody.length > 0 ? rawBody : undefined,
      })

      res.statusCode = upstream.status
      const upType = upstream.headers.get('content-type') || 'application/json; charset=utf-8'
      res.setHeader('Content-Type', upType)
      const ab = await upstream.arrayBuffer()
      res.end(Buffer.from(ab))
    } catch (err: any) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: { message: err?.message || 'Proxy request failed' } }))
    }
  }

  const serve = (req: any, res: any, next: any) => {
    const rawUrl = (req.url || '').split('?')[0]
    if (rawUrl === '/api/proxy') {
      void handleProxy(req, res)
      return
    }
    const decoded = decodeURIComponent(rawUrl)
    if (!prefixes.some((p) => decoded === p || decoded.startsWith(p))) {
      return next()
    }
    const filePath = path.join(rootDir, decoded)
    if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return next()
    }
    const ext = path.extname(filePath).toLowerCase()
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    fs.createReadStream(filePath).pipe(res)
  }

  return {
    name: 'local-assets-and-proxy-plugin',
    configureServer(server) {
      server.middlewares.use(serve)
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve)
    },
  }
}

// 本地 ComfyUI 同源代理：浏览器请求 /comfy/* → 本机 ComfyUI
// 这样无需修改 ComfyUI 的 --enable-cors-header 白名单。
// 目标端口解析规则（按优先级）：
//   1. 环境变量 COMFYUI_URL（例如 PowerShell: $env:COMFYUI_URL="http://127.0.0.1:8188"; pnpm dev）
//   2. 启动时自动探测本机常见端口：8000(Desktop 旧版) / 8188(便携版/源码版) / 8088 / 8189 / 8080
//   3. 全部未探测到时回退 8188（启动 ComfyUI 后重启 dev 或显式设置 COMFYUI_URL 即可生效）
const COMFYUI_PORT_CANDIDATES = [8000, 8188, 8088, 8189, 8080]
const COMFYUI_FALLBACK_URL = 'http://127.0.0.1:8188'

const probePort = (port: number, host = '127.0.0.1'): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(400)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })

async function resolveComfyTarget(): Promise<string> {
  const explicit = process.env.COMFYUI_URL?.trim()
  if (explicit) {
    const url = explicit.replace(/\/+$/, '')
    console.log(`[comfy] 使用环境变量 COMFYUI_URL = ${url}`)
    return url
  }
  for (const port of COMFYUI_PORT_CANDIDATES) {
    if (await probePort(port)) {
      const url = `http://127.0.0.1:${port}`
      console.log(`[comfy] 已探测到本地 ComfyUI：${url}（/comfy 同源代理指向该端口）`)
      return url
    }
  }
  console.warn(
    `[comfy] 未探测到运行中的 ComfyUI（已尝试端口 ${COMFYUI_PORT_CANDIDATES.join(' / ')}），` +
      `/comfy 代理暂指向 ${COMFYUI_FALLBACK_URL}。请先启动 ComfyUI 再运行 pnpm dev；` +
      `若端口不同，可设置 COMFYUI_URL 后重启，或在合成台「检测本机模型」中自动识别。`
  )
  return COMFYUI_FALLBACK_URL
}

export default defineConfig(async (): Promise<UserConfig> => {
  const comfyTarget = await resolveComfyTarget()
  const comfyProxy = {
    '/comfy': {
      target: comfyTarget,
      changeOrigin: true,
      ws: true,
      rewrite: (p: string) => p.replace(/^\/comfy/, '') || '/',
      configure: (proxy: any) => {
        // ComfyUI 对带 Origin 的跨源请求做校验，代理转发时去掉浏览器 Origin，按同源请求处理
        proxy.on('proxyReq', (proxyReq: any) => proxyReq.removeHeader('origin'))
        proxy.on('proxyReqWs', (proxyReq: any) => proxyReq.removeHeader('origin'))
      },
    },
  }

  return {
    publicDir: false,
    plugins: [
      localAssetsAndProxyPlugin(),
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
              { name: 'tanstack-vendor', test: /node_modules[\\/]@tanstack[\\/]/ },
              { name: 'ui-vendor', test: /node_modules[\\/](radix-ui|@radix-ui|lucide-react|sonner)[\\/]/ },
            ],
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: comfyProxy,
    },
    preview: {
      proxy: comfyProxy,
    },
  }
})
