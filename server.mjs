import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, securityHeaders } from './handler.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/model.mjs': ['model.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
};

export function createApp(options = {}) {
  const handler = createHandler(options);
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000 }, (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (['GET', 'HEAD'].includes(req.method) && staticFiles[path]) {
      const [file, type] = staticFiles[path];
      res.writeHead(200, { ...securityHeaders, 'content-type': type, 'cache-control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : readFileSync(join(root, 'public', file)));
    }
    return handler(req, res);
  });
  server.on('close', () => handler.close());
  return { server, close: handler.close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createApp();
  server.listen(port, host, () => console.log(`lembed ready at http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
