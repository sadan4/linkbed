import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCard, payloadBytes, embedScript, ValidationError } from './public/model.mjs';
import { fetchMetadata, publicUrl } from './metadata.mjs';
import { renderCard } from './render.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const validSlug = slug => typeof slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 60;

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'send json.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16 * 1024) throw fail(413, 'request is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail(400, 'invalid json object.'); }
}

export function createApp({ dbPath = process.env.DB_PATH || join(root, 'data/cards.sqlite'), origin = process.env.PUBLIC_ORIGIN || 'http://localhost:3000' } = {}) {
  const canonical = new URL(origin).origin;
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cards (
      slug TEXT PRIMARY KEY, owner TEXT NOT NULL, card TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;`);
  const find = db.prepare('SELECT * FROM cards WHERE slug = ?');
  const list = db.prepare('SELECT slug, card, revision, updated_at FROM cards WHERE owner = ? ORDER BY updated_at DESC LIMIT 100');
  const insert = db.prepare('INSERT INTO cards (slug, owner, card, revision, updated_at) VALUES (?, ?, ?, 1, ?)');
  const update = db.prepare('UPDATE cards SET card = ?, revision = revision + 1, updated_at = ? WHERE slug = ? AND owner = ?');
  const remove = db.prepare('DELETE FROM cards WHERE slug = ? AND owner = ?');
  const limits = new Map();

  function rate(req, kind, max) {
    const now = Date.now();
    if (limits.size > 2000) for (const [key, value] of limits) if (value.until < now) limits.delete(key);
    const key = kind + ':' + req.socket.remoteAddress;
    const value = limits.get(key);
    if (!value || value.until < now) {
      if (limits.size > 10000) throw fail(503, 'please try again shortly.');
      limits.set(key, { count: 1, until: now + 60000 });
    } else if (++value.count > max) throw fail(429, 'too many requests. wait a minute and try again.');
  }

  function owner(req, res) {
    let token = req.headers.cookie?.match(/(?:^|;\s*)lembed_owner=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (!token) {
      token = randomBytes(32).toString('hex');
      res.setHeader('set-cookie', `lembed_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${canonical.startsWith('https:') ? '; Secure' : ''}`);
    }
    return createHash('sha256').update(token).digest('hex');
  }

  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000 }, async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (canonical.startsWith('https:')) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      const url = new URL(req.url, canonical);
      const path = url.pathname;
      const write = !['GET', 'HEAD'].includes(req.method);
      if (write) {
        if (req.headers.origin !== canonical || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'request must come from this site.');
        rate(req, 'write', 60);
      }
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok' });
      if (req.method === 'POST' && path === '/api/import') {
        rate(req, 'import', 10);
        const input = await body(req);
        let card;
        try { card = await fetchMetadata(input.url); } catch (error) {
          if (error.status) throw error;
          throw fail(400, 'could not import that website. fill in the card manually.');
        }
        return json(res, 200, card);
      }
      if (req.method === 'GET' && path === '/api/cards') {
        const id = owner(req, res);
        return json(res, 200, list.all(id).map(row => ({ slug: row.slug, ...JSON.parse(row.card), revision: row.revision, updatedAt: row.updated_at })));
      }
      const api = path.match(/^\/api\/cards\/([a-z0-9-]+)$/);
      if ((path === '/api/cards' && req.method === 'POST') || api) {
        const id = owner(req, res);
        const row = api ? find.get(api[1]) : undefined;
        if (api && (!row || row.owner !== id)) throw fail(404, 'card not found in this browser.');
        if (api && req.method === 'GET') return json(res, 200, { slug: row.slug, ...JSON.parse(row.card), revision: row.revision });
        if (api && req.method === 'DELETE') {
          remove.run(row.slug, id);
          return json(res, 200, { deleted: true });
        }
        if (req.method !== 'POST' && req.method !== 'PUT') throw fail(405, 'method not allowed.');
        if ((api && req.method !== 'PUT') || (!api && req.method !== 'POST')) throw fail(405, 'method not allowed.');
        const input = await body(req);
        const slug = row?.slug ?? input.slug;
        if (!validSlug(slug)) throw fail(400, 'use 1–60 lowercase letters, numbers, and single hyphens for the link.');
        const card = normalizeCard(input);
        for (const link of [card.url, ...card.images, ...card.buttons.map(button => button.url)]) publicUrl(link);
        if (row) update.run(JSON.stringify(card), Date.now(), slug, id);
        else {
          if (find.get(slug)) throw fail(409, 'that link is taken. choose another.');
          if (list.all(id).length >= 100) throw fail(400, 'this browser has reached its 100-card limit.');
          insert.run(slug, id, JSON.stringify(card), Date.now());
        }
        const revision = row ? row.revision + 1 : 1;
        return json(res, row ? 200 : 201, { slug, revision, url: `${canonical}/p/${slug}`, freshUrl: `${canonical}/p/${slug}?v=${revision}`, bytes: payloadBytes(card), script: embedScript(card) });
      }
      const publicPage = path.match(/^\/p\/([a-z0-9-]+)$/);
      if (publicPage && ['GET', 'HEAD'].includes(req.method)) {
        const row = find.get(publicPage[1]);
        if (!row) throw fail(404, 'card not found.');
        const html = renderCard(JSON.parse(row.card), `${canonical}/p/${row.slug}`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      const staticFiles = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
        '/model.mjs': ['model.mjs', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
        '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
      };
      if (['GET', 'HEAD'].includes(req.method) && staticFiles[path]) {
        const [file, type] = staticFiles[path];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : readFileSync(join(root, 'public', file)));
      }
      if (req.method === 'GET' && path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('User-agent: *\nAllow: /p/\nDisallow: /api/\n');
      }
      throw fail(404, 'page not found.');
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'something went wrong. try again.' });
      else res.end();
    }
  });
  server.on('close', () => db.close());
  return { server, db };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createApp();
  server.listen(port, host, () => console.log(`lembed ready at http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
