import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// `npm run dev` reaches each Server Manager through /__manage/<id>, so a local
// session works without being in the manager's ALLOWED_ORIGINS and without
// trusting its internal certificate. Production builds call the URLs directly.
const MANAGE_SERVERS = ['DEV', 'QA', 'PROD', 'POC']

function manageProxy(env) {
  const entries = MANAGE_SERVERS.map((id) => [id, env[`VITE_MANAGE_API_${id}_URL`] || env.VITE_MANAGE_API_URL]).filter(([, url]) => url)
  return Object.fromEntries(entries.map(([id, url]) => [`/__manage/${id.toLowerCase()}`, {
    target: url.replace(/\/$/, ''),
    changeOrigin: true,
    secure: false,
    ws: true,
    rewrite: (p) => p.replace(new RegExp(`^/__manage/${id.toLowerCase()}`), ''),
  }]))
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: { port: 3000, proxy: manageProxy(loadEnv(mode, __dirname, 'VITE_')) },
  preview: { port: 3000 },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-vendor')) return 'charts'
          if (id.includes('@azure')) return 'msal'
          if (id.includes('react-router') || id.includes('/react-dom/') || id.includes('/react/') || id.includes('scheduler')) return 'react'
          return 'vendor'
        },
      },
    },
  },
}))
