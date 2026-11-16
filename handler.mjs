import { createHash, randomBytes } from 'node:crypto';
import { openDatabase } from './database.mjs';
import { normalizeCard, payloadBytes, embedScript } from './public/model.mjs';
import { fetchMetadata, publicUrl } from './metadata.mjs';
import { renderCard } from './render.mjs';

export const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(value).digest('hex');
const cookie = (req, name) => req.headers.cookie?.match(new RegExp('(?:^|;\\s*)' + name + '=([a-f0-9]{64})(?:;|$)'))?.[1];
const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'send json.');
  let value = req.body;
  if (value === undefined) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) throw fail(413, 'request is too large.');
      chunks.push(chunk);
    }
    try { value = JSON.parse(Buffer.concat(chunks)); } catch { throw fail(400, 'invalid json.'); }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 16384) throw fail(413, 'request is too large.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'invalid json object.');
  return value;
}

export function createHandler(options = {}) {
  const deploymentHost = process.env.VERCEL_ENV === 'production'
    ? process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
    : process.env.VERCEL_URL;
  const origin = options.origin || process.env.PUBLIC_ORIGIN || (deploymentHost ? 'https://' + deploymentHost : 'http://localhost:3000');
  const canonical = new URL(origin).origin;
  let database;
  const connect = () => database ||= openDatabase(options).catch(error => { database = undefined; throw error; });

  function setSession(res, token, maxAge = 2592000) {
    res.setHeader('set-cookie', `lembed_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${canonical.startsWith('https:') ? '; Secure' : ''}`);
  }

  async function session(db, req) {
    const token = cookie(req, 'lembed_session');
    if (!token) return undefined;
    const result = await db.execute({ sql: 'SELECT owner FROM sessions WHERE hash = ? AND expires_at > ?', args: [hash(token), Date.now()] });
    return result.rows[0]?.owner;
  }

  async function rate(db, req, kind, max) {
    const ip = process.env.VERCEL ? req.headers['x-forwarded-for']?.split(',')[0].trim() : req.socket.remoteAddress;
    const now = Date.now();
    const results = await db.batch([
      { sql: 'DELETE FROM rate_limits WHERE expires_at < ?', args: [now] },
      { sql: 'INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count', args: [hash(kind + ':' + (ip || 'unknown')), now + 60000] },
    ], 'write');
    if (results[1].rows[0].count > max) throw fail(429, 'too many requests. wait a minute and try again.');
  }

  async function handle(req, res) {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    if (canonical.startsWith('https:')) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      const url = new URL(req.url, canonical);
      let path = url.pathname;
      if (path === '/api/index') {
        if (url.searchParams.has('card')) path = '/p/' + url.searchParams.get('card');
        else if (url.searchParams.has('route')) path = '/api/' + url.searchParams.get('route');
        else if (url.searchParams.has('health')) path = '/healthz';
      }
      const db = await connect();
      const write = !['GET', 'HEAD'].includes(req.method);
      if (write) {
        const origins = [canonical];
        if (process.env.VERCEL_URL) origins.push('https://' + process.env.VERCEL_URL);
        if (!origins.includes(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'request must come from this site.');
        await rate(db, req, 'write', 60);
      }
      if (req.method === 'GET' && path === '/healthz') {
        await db.execute('SELECT 1');
        return json(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && path === '/api/session') return json(res, 200, { authenticated: !!await session(db, req) });
      if (req.method === 'POST' && (path === '/api/signup' || path === '/api/login')) {
        await rate(db, req, 'auth', 10);
        let owner;
        let token;
        if (path === '/api/signup') {
          token = 'lembed_' + randomBytes(32).toString('base64url');
          owner = hash(token);
        } else {
          const input = await body(req);
          if (typeof input.token !== 'string' || !/^lembed_[A-Za-z0-9_-]{43}$/.test(input.token)) throw fail(401, 'token not recognized.');
          owner = hash(input.token);
          const found = await db.execute({ sql: 'SELECT token_hash FROM accounts WHERE token_hash = ?', args: [owner] });
          if (!found.rows.length) throw fail(401, 'token not recognized.');
        }
        const sessionToken = randomBytes(32).toString('hex');
        const commands = [
          { sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [Date.now()] },
          { sql: 'INSERT INTO sessions (hash, owner, expires_at) VALUES (?, ?, ?)', args: [hash(sessionToken), owner, Date.now() + 2592000000] },
        ];
        if (token) {
          commands.unshift({ sql: 'INSERT INTO accounts (token_hash, created_at) VALUES (?, ?)', args: [owner, Date.now()] });
          const legacy = cookie(req, 'lembed_owner');
          if (legacy) commands.push({ sql: 'UPDATE cards SET owner = ? WHERE owner = ?', args: [owner, hash(legacy)] });
        }
        await db.batch(commands, 'write');
        setSession(res, sessionToken);
        return json(res, token ? 201 : 200, token ? { authenticated: true, token } : { authenticated: true });
      }
      if (req.method === 'POST' && path === '/api/logout') {
        const token = cookie(req, 'lembed_session');
        if (token) await db.execute({ sql: 'DELETE FROM sessions WHERE hash = ?', args: [hash(token)] });
        setSession(res, '', 0);
        return json(res, 200, { authenticated: false });
      }
      if (req.method === 'POST' && path === '/api/import') {
        await rate(db, req, 'import', 10);
        const input = await body(req);
        try { return json(res, 200, await fetchMetadata(input.url)); } catch (error) {
          if (error.status) throw error;
          throw fail(400, 'could not import that website. fill in the card manually.');
        }
      }
      if (path === '/api/cards' || path.startsWith('/api/cards/')) {
        const owner = await session(db, req);
        if (!owner) throw fail(401, 'sign in with your token or create an account to save cards.');
        if (path === '/api/cards' && req.method === 'GET') {
          const result = await db.execute({ sql: 'SELECT slug, card, revision, updated_at FROM cards WHERE owner = ? ORDER BY updated_at DESC LIMIT 100', args: [owner] });
          return json(res, 200, result.rows.map(row => ({ slug: row.slug, ...JSON.parse(row.card), revision: row.revision, updatedAt: row.updated_at })));
        }
        const api = path.match(/^\/api\/cards\/([a-z0-9-]+)$/);
        if (api && req.method === 'GET') {
          const result = await db.execute({ sql: 'SELECT card, revision FROM cards WHERE slug = ? AND owner = ?', args: [api[1], owner] });
          if (!result.rows.length) throw fail(404, 'card not found.');
          return json(res, 200, { slug: api[1], ...JSON.parse(result.rows[0].card), revision: result.rows[0].revision });
        }
        if (api && req.method === 'DELETE') {
          const result = await db.execute({ sql: 'DELETE FROM cards WHERE slug = ? AND owner = ? RETURNING slug', args: [api[1], owner] });
          if (!result.rows.length) throw fail(404, 'card not found.');
          return json(res, 200, { deleted: true });
        }
        const create = path === '/api/cards' && req.method === 'POST';
        if (!create && !(api && req.method === 'PUT')) throw fail(405, 'method not allowed.');
        const input = await body(req);
        const slug = api?.[1] ?? input.slug;
        if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) throw fail(400, 'use 1–60 lowercase letters, numbers, and single hyphens for the link.');
        const card = normalizeCard(input);
        for (const link of [card.url, ...card.images, ...card.buttons.map(button => button.url)]) publicUrl(link);
        let result;
        if (create) {
          try {
            result = await db.execute({
              sql: 'INSERT INTO cards (slug, owner, card, revision, updated_at) SELECT ?, ?, ?, 1, ? WHERE (SELECT COUNT(*) FROM cards WHERE owner = ?) < 100 RETURNING revision',
              args: [slug, owner, JSON.stringify(card), Date.now(), owner],
            });
          } catch (error) {
            if (String(error.code).includes('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/.test(error.message)) throw fail(409, 'that link is taken. choose another.');
            throw error;
          }
          if (!result.rows.length) throw fail(400, 'your account has reached its 100-card limit.');
        } else {
          result = await db.execute({ sql: 'UPDATE cards SET card = ?, revision = revision + 1, updated_at = ? WHERE slug = ? AND owner = ? RETURNING revision', args: [JSON.stringify(card), Date.now(), slug, owner] });
          if (!result.rows.length) throw fail(404, 'card not found.');
        }
        const revision = result.rows[0].revision;
        return json(res, create ? 201 : 200, { slug, revision, url: `${canonical}/p/${slug}`, freshUrl: `${canonical}/p/${slug}?v=${revision}`, bytes: payloadBytes(card), script: embedScript(card) });
      }
      const publicPage = path.match(/^\/p\/([a-z0-9-]+)$/);
      if (publicPage && ['GET', 'HEAD'].includes(req.method)) {
        const result = await db.execute({ sql: 'SELECT card FROM cards WHERE slug = ?', args: [publicPage[1]] });
        if (!result.rows.length) throw fail(404, 'card not found.');
        const html = renderCard(JSON.parse(result.rows[0].card), `${canonical}/p/${publicPage[1]}`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      throw fail(404, 'page not found.');
    } catch (error) {
      if (!error.status) console.error('lembed request failed:', error.code || error.name);
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'service unavailable. try again shortly.' });
      else res.end();
    }
  }
  handle.close = async () => {
    const current = database;
    database = undefined;
    (await current)?.close();
  };
  return handle;
}
