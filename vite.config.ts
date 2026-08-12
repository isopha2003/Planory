import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig({
  base: './',
  clearScreen: false,
  plugins: [
    figmaAssetResolver(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  server: {
    // vite 기본 포트(5173)를 피해 Tauri 스캐폴드 관례 포트를 쓴다 — 다른 vite 프로젝트의
    // dev 서버가 떠 있으면 5173 이 선점돼 "Port 5173 is already in use" 로 죽었음.
    // strictPort 는 유지: tauri.conf.json 의 devUrl 이 이 포트로 고정돼 있어서 자동으로
    // 다음 포트로 넘어가면 Tauri 창이 빈 화면을 띄운다. 바꿀 때 devUrl 도 같이 고칠 것.
    port: 1420,
    strictPort: true,
  },

  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        timer: path.resolve(__dirname, 'timer.html'),
      },
    },
  },
})
