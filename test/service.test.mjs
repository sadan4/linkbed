import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCard, embedJson, payloadBytes } from '../public/model.mjs';
import { isPublicAddress, resolvePublicUrl, publicUrl, metadataFromHtml } from '../metadata.mjs';
import { createApp } from '../server.mjs';

const card = { title: 'hello', description: 'a launch', url: 'https://example.com/', color: '#5865f2', buttons: [{ label: 'visit', url: 'https://example.com/' }], images: [] };

test('payload uses one container, link buttons, escaped script text and byte limit', () => {
  const value = normalizeCard({ ...card, description: '</script><script>alert("x")</script>', images: ['https://example.com/a.png'] });
  const text = embedJson(value);
  const embed = JSON.parse(text).component;
  assert.equal(embed.type, 17);
  assert.equal(embed.components[1].type, 12);
  assert.equal(embed.components[3].components[0].style, 5);
  assert.ok(!text.includes('</script>'));
  assert.equal(payloadBytes(value), Buffer.byteLength(text));
  assert.throws(() => normalizeCard({ ...card, description: '界'.repeat(1100) }), /3,000-byte/);
  assert.throws(() => normalizeCard({ ...card, buttons: Array(6).fill(card.buttons[0]) }), /five/);
  assert.throws(() => normalizeCard({ ...card, images: Array(11).fill('https://example.com/a.png') }), /ten/);
  assert.throws(() => normalizeCard({ ...card, url: 'javascript:alert(1)' }), /https/);
  assert.throws(() => normalizeCard({ ...card, color: ['#abcdef'] }), /color/);
  assert.throws(() => normalizeCard({ ...card, buttons: [{ label: 'visit', url: 'https://example.com/' + '界'.repeat(60) }] }), /encoding/);
});

test('URL import rejects private and disguised addresses, validates every DNS result', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  for (const url of ['https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://localhost/', 'https://me:secret@example.com/', 'https://example.com:8443/']) assert.throws(() => publicUrl(url));
  await assert.rejects(resolvePublicUrl('https://example.com', async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]), /private/);
  const resolved = await resolvePublicUrl('https://example.com', async () => [{ address: '1.1.1.1', family: 4 }]);
  assert.equal(resolved.record.address, '1.1.1.1');
});

test('metadata import parses entities, relative images and fallbacks without executing html', () => {
  const result = metadataFromHtml('<title>fallback</title><meta property="og:title" content="fish &amp; chips"><meta name="description" content="hello"><meta property="og:image" content="/image.png"><script>throw 1</script>', 'https://example.com/page');
  assert.equal(result.title, 'fish & chips');
  assert.equal(result.description, 'hello');
  assert.deepEqual(result.images, ['https://example.com/image.png']);
  assert.deepEqual(metadataFromHtml('<meta property="og:image" content="http://127.0.0.1/x">', 'https://example.com').images, []);
});

test('token accounts, ownership, logout, expiry, SSR and restart persistence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lembed-test-'));
  const dbPath = join(directory, 'cards.sqlite');
  let server, close, base;
  const start = async () => {
    ({ server, close } = createApp({ dbPath }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await close();
  };
  const request = (path, method = 'GET', data, owner = '', origin = 'http://localhost:3000') => fetch(base + path, {
    method, headers: { 'content-type': 'application/json', origin, cookie: owner },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  await start();
  try {
    assert.equal((await request('/api/cards')).status, 401);
    assert.equal((await request('/api/signup', 'POST', {}, '', 'https://evil.example')).status, 403);
    const signup = await request('/api/signup', 'POST', {});
    assert.equal(signup.status, 201);
    const { token } = await signup.json();
    assert.match(token, /^lembed_[A-Za-z0-9_-]{43}$/);
    let session = signup.headers.get('set-cookie').split(';')[0];
    assert.ok(signup.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(signup.headers.get('set-cookie').includes('SameSite=Strict'));
    assert.ok(!session.includes(token));
    const { DatabaseSync } = await import('node:sqlite');
    const inspect = new DatabaseSync(dbPath);
    const account = inspect.prepare('SELECT token_hash FROM accounts').get();
    assert.equal(account.token_hash.length, 64);
    assert.notEqual(account.token_hash, token);
    assert.ok(!JSON.stringify(inspect.prepare('SELECT * FROM sessions').all()).includes(session.split('=')[1]));
    inspect.close();

    assert.equal((await request('/api/cards', 'POST', null, session)).status, 400);
    assert.equal((await request('/api/cards', 'POST', { ...card, slug: '../escape' }, session)).status, 400);
    assert.equal((await request('/api/cards', 'POST', { ...card, slug: 'private', url: 'https://127.0.0.1/' }, session)).status, 400);
    const created = await request('/api/cards', 'POST', { ...card, title: '<script>alert(1)</script>', slug: 'launch' }, session);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).revision, 1);
    assert.equal((await request('/api/cards', 'POST', { ...card, slug: 'launch' }, session)).status, 409);
    const page = await fetch(base + '/p/launch', { headers: { 'user-agent': 'Discordbot/2.0' } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /property="og:title"/);
    assert.match(html, /script id="discord:component-embed"/);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    const payload = JSON.parse(html.match(/<script id="discord:component-embed" type="application\/json">(.+?)<\/script>/s)[1]);
    assert.equal(payload.component.type, 17);
    assert.equal((await request('/api/index?card=launch')).status, 200);

    const otherSignup = await request('/api/signup', 'POST', {});
    const otherSession = otherSignup.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/cards/launch', 'PUT', card, otherSession)).status, 404);
    assert.equal((await request('/api/cards/launch', 'DELETE', undefined, otherSession)).status, 404);
    const updated = await request('/api/cards/launch', 'PUT', { ...card, title: 'updated' }, session);
    assert.equal((await updated.json()).revision, 2);

    await request('/api/logout', 'POST', {}, session);
    assert.equal((await request('/api/session', 'GET', undefined, session).then(r => r.json())).authenticated, false);
    assert.equal((await request('/api/cards', 'GET', undefined, session)).status, 401);
    assert.equal((await request('/api/login', 'POST', { token: 'wrong' })).status, 401);
    const login = await request('/api/login', 'POST', { token });
    assert.equal(login.status, 200);
    session = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await login.json()).token, undefined);
    assert.equal((await request('/api/cards', 'GET', undefined, session).then(r => r.json()))[0].title, 'updated');

    await stop();
    await start();
    const restored = await request('/api/cards/launch', 'GET', undefined, session);
    assert.equal((await restored.json()).title, 'updated');

    const expiry = new DatabaseSync(dbPath);
    expiry.prepare('UPDATE sessions SET expires_at = 0').run();
    expiry.close();
    assert.equal((await request('/api/cards', 'GET', undefined, session)).status, 401);
    const relogin = await request('/api/login', 'POST', { token });
    session = relogin.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/cards/launch', 'DELETE', undefined, session)).status, 200);
    assert.equal((await fetch(base + '/p/launch')).status, 404);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('auth throttling persists and legacy local cards migrate on account creation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lembed-auth-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', origin: 'http://localhost:3000' };
  try {
    await fetch(base + '/healthz');
    const { DatabaseSync } = await import('node:sqlite');
    const { createHash } = await import('node:crypto');
    const legacyToken = 'a'.repeat(64);
    const inspect = new DatabaseSync(dbPath);
    inspect.prepare('INSERT INTO cards VALUES (?, ?, ?, 1, ?)').run('old-card', createHash('sha256').update(legacyToken).digest('hex'), JSON.stringify(card), Date.now());
    inspect.close();
    const signup = await fetch(base + '/api/signup', { method: 'POST', headers: { ...headers, cookie: 'lembed_owner=' + legacyToken }, body: '{}' });
    const session = signup.headers.get('set-cookie').split(';')[0];
    const cards = await fetch(base + '/api/cards', { headers: { cookie: session } }).then(r => r.json());
    assert.equal(cards[0].slug, 'old-card');
    for (let i = 0; i < 9; i++) assert.equal((await fetch(base + '/api/login', { method: 'POST', headers, body: '{"token":"wrong"}' })).status, 401);
    assert.equal((await fetch(base + '/api/login', { method: 'POST', headers, body: '{"token":"wrong"}' })).status, 429);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
