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

  server: {
    // `katex` (and other deps) are hoisted to the monorepo-root node_modules, so
    // katex.min.css resolves its font files from outside the app's project root.
    // This app has its own lockfile, so Vite's workspace-root detection stops here
    // and excludes the hoisted assets; allow the monorepo root explicitly (it also
    // contains this app's dir) so those fonts serve in dev. The `..` parent is the
    // `apps/` dir and `../..` is the monorepo root.
    fs: {
      allow: [path.resolve(__dirname, '../..')],
    },
    proxy: {
      '/api': 'http://localhost:8001',
    },
    // The vendored prover holds huge Lean build trees (workspace + SafeVerify
    // .lake/ oleans, the ~189MB safe_verify binary). The frontend never imports
    // from there, so keep the file watcher out of it — otherwise the dev server
    // thrashes with full-reloads on Mathlib/SafeVerify artifacts.
    watch: {
      ignored: ['**/prover/**'],
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
