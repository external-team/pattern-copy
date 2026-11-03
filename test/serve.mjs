/*
 * `npm start`: serves test/ on http://localhost and launches Firefox with the
 * extension and the demo page loaded.
 *
 * The page is served over http on purpose. Firefox MV3 grants host access per
 * site, and a file:// page has no site to grant, so the content script never
 * runs there unless the extension has access to all sites.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const port = Number(process.env.PORT) || 8765;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = normalize(join(here, path === '/' ? 'sample.html' : path));
  if (!file.startsWith(here + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(body);
  } catch (_) {
    res.writeHead(404).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}/sample.html`;
  console.log(`Serving the demo page at ${url}`);
  if (process.argv.includes('--serve-only')) return;

  const webExt = spawn('npx', [
    'web-ext', 'run', '--source-dir', root, '--config', join(root, 'web-ext-config.mjs'),
    '--start-url', url, ...process.argv.slice(2)
  ], { stdio: 'inherit', cwd: root });
  webExt.on('exit', (code) => { server.close(); process.exit(code ?? 0); });
});
