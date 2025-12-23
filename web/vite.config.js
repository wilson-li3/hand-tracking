import { defineConfig } from 'vite'

export default defineConfig({
  // Ensure Vite dev server serves these as real static assets (not index.html)
  assetsInclude: ['**/*.wasm', '**/*.data', '**/*.tflite'],
  server: {
    middlewareMode: false,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''

        // Set correct Content-Type for MediaPipe assets
        if (url.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm')
        } else if (url.endsWith('.data') || url.endsWith('.tflite')) {
          res.setHeader('Content-Type', 'application/octet-stream')
        }

        next()
      })
    },
  },
})
