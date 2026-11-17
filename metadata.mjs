import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { loadBuffer } from 'cheerio';
import ipaddr from 'ipaddr.js';
import { httpsUrl, publicHttpUrl, ValidationError } from './public/model.mjs';

export function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

export function publicUrl(value, label = 'url', allowHttp = false) {
  const url = new URL((allowHttp ? publicHttpUrl : httpsUrl)(value, label));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new ValidationError('private network addresses are not allowed.');
  return url;
}

export async function resolvePublicUrl(value, resolve = lookup) {
  const url = publicUrl(value);
  const records = await resolve(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new ValidationError('private network addresses are not allowed.');
  }
  return { url, record: records.find(record => record.family === 4) ?? records[0] };
}

export function metadataFromHtml(html, source) {
  const $ = loadBuffer(Buffer.isBuffer(html) ? html : Buffer.from(html));
  const meta = name => $('meta').filter((_, el) => ($(el).attr('property') ?? $(el).attr('name')) === name).first().attr('content')?.trim();
  const title = (meta('og:title') || meta('twitter:title') || $('title').first().text() || new URL(source).hostname).slice(0, 100);
  const description = (meta('og:description') || meta('twitter:description') || meta('description') || '').slice(0, 1200);
  const image = meta('og:image') || meta('twitter:image') || '';
  let images = [];
  try { if (image) images = [publicUrl(new URL(image, source).href, 'image url').href]; } catch {}
  const color = meta('theme-color');
  return { title, description, url: source, images, buttons: [{ label: 'visit website', url: source }], color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#5865f2' };
}

export async function fetchMetadata(value) {
  const signal = AbortSignal.timeout(8000);
  let current = value;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { url, record } = await Promise.race([
      resolvePublicUrl(current),
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new ValidationError('website took too long to respond.')), { once: true })),
    ]);
    signal.throwIfAborted();
    const response = await new Promise((resolve, reject) => {
      get(url, {
        agent: false,
        autoSelectFamily: false,
        signal,
        lookup: (_host, options, callback) => options.all ? callback(null, [record]) : callback(null, record.address, record.family),
        headers: { 'user-agent': 'linkbed/0.1 (link preview importer)', accept: 'text/html, application/xhtml+xml', 'accept-encoding': 'gzip, deflate, br' },
      }, resolve).on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (!response.headers.location) throw new ValidationError('website returned an empty redirect.');
      current = new URL(response.headers.location, url).href;
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      throw new ValidationError('website blocked the import. fill in the card manually.');
    }
    if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(response.headers['content-type'] ?? '')) {
      response.destroy();
      throw new ValidationError('that url does not return an html page.');
    }
    const decompress = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[response.headers['content-encoding']];
    const stream = decompress ? response.pipe(decompress()) : response;
    response.on('error', error => stream.destroy(error));
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new ValidationError('website is too large to import. fill in the card manually.');
        chunks.push(chunk);
      }
    } finally {
      response.destroy();
      if (stream !== response) stream.destroy();
    }
    return metadataFromHtml(Buffer.concat(chunks), url.href);
  }
  throw new ValidationError('website redirected too many times.');
}
