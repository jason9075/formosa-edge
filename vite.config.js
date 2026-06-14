import { defineConfig } from 'vite';
import { createReadStream, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Serves *.glb files from ./output/ in dev mode when not found in ./public/.
 * Allows `just dev` without running `just stage` first — useful during iteration.
 */
function serveOutputPlugin() {
  return {
    name: 'serve-output-dir',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '/';
        if (!/\.(glb|json)$/i.test(url)) return next();

        const publicPath = join(resolve('public'), url);
        if (existsSync(publicPath)) return next();

        const outputPath = join(resolve('output'), url.replace(/^\//, ''));
        if (existsSync(outputPath)) {
          const { size } = statSync(outputPath);
          const mime = url.endsWith('.json') ? 'application/json' : 'model/gltf-binary';
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Length', String(size));
          createReadStream(outputPath).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/gfx-lab/' : '/',
  plugins: [serveOutputPlugin()],
  server: { port: 8080 },
  build: { outDir: 'dist' },
});
