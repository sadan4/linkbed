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

test('publish, SSR, ownership, update, restart persistence and delete', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lembed-test-'));
  const dbPath = join(directory, 'cards.sqlite');
  let server;
  let base;
  const start = async () => {
    server = createApp({ dbPath }).server;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  await start();
  try {
    const initial = await fetch(base + '/api/cards');
    const cookie = initial.headers.get('set-cookie').split(';')[0];
    assert.ok(initial.headers.get('set-cookie').includes('HttpOnly'));
    const request = (path, method, data, owner = cookie, origin = 'http://localhost:3000') => fetch(base + path, { method, headers: { 'content-type': 'application/json', origin, cookie: owner }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.equal((await request('/api/cards', 'POST', { ...card, slug: 'launch' }, cookie, 'https://evil.example')).status, 403);
    assert.equal((await request('/api/cards', 'POST', null)).status, 400);
    assert.equal((await request('/api/cards', 'POST', { ...card, slug: '../escape' })).status, 400);
    assert.equal((await request('/api/cards', 'POST', { ...card, slug: 'private', url: 'https://127.0.0.1/' })).status, 400);
    const created = await request('/api/cards', 'POST', { ...card, title: '<script>alert(1)</script>', slug: 'launch' });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).revision, 1);
    assert.equal((await request('/api/cards', 'POST', { ...card, slug: 'launch' })).status, 409);
    const page = await fetch(base + '/p/launch', { headers: { 'user-agent': 'Discordbot/2.0' } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /property="og:title"/);
    assert.match(html, /script id="discord:component-embed"/);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    const payload = JSON.parse(html.match(/<script id="discord:component-embed" type="application\/json">(.+?)<\/script>/s)[1]);
    assert.equal(payload.component.type, 17);
    assert.equal((await request('/api/cards/launch', 'PUT', card, '')).status, 404);
    assert.equal((await request('/api/cards/launch', 'DELETE', undefined, '')).status, 404);
    const updated = await request('/api/cards/launch', 'PUT', { ...card, title: 'updated' });
    assert.equal((await updated.json()).revision, 2);
    await stop();
    await start();
    const restored = await fetch(base + '/api/cards/launch', { headers: { cookie } });
    assert.equal((await restored.json()).title, 'updated');
    assert.equal((await request('/api/cards/launch', 'DELETE')).status, 200);
    assert.equal((await fetch(base + '/p/launch')).status, 404);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
