import { defineConfig, type Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:build-info';
const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_ID;

function formatYmdHis(date = new Date()): string {
  const Y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const H = String(date.getHours()).padStart(2, '0');
  const i = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${Y}${m}${d}${H}${i}${s}`;
}

function buildTrackerPlugin(): Plugin {
  let latestStamp = formatYmdHis();
  return {
    name: 'goat-build-tracker',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      return null;
    },
    load(id) {
      if (id === RESOLVED_VIRTUAL_ID) {
        return `export const BUILD_STAMP = ${JSON.stringify(latestStamp)};`;
      }
      return null;
    },
    configureServer(server) {
      server.middlewares.use('/__build-info', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ stamp: latestStamp }));
      });

      const onFileChange = (file: string) => {
        if (file.includes('/src/') || file.endsWith('index.html')) {
          latestStamp = formatYmdHis();
          const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
          }
          server.ws.send({
            type: 'custom',
            event: 'goat:update',
            data: { stamp: latestStamp },
          });
        }
      };

      server.watcher.on('change', onFileChange);
      server.watcher.on('add', onFileChange);
    },
  };
}

function normalizeBase(base?: string): string {
  if (!base) return './';
  const trimmed = base.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : normalizeBase(process.env.VITE_BASE),
  plugins: [buildTrackerPlugin()],
  server: {
    port: 5173,
    strictPort: true,
  },
}));
