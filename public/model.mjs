export const MAX_BYTES = 3000;

export class ValidationError extends Error {
  status = 400;
}

export function httpsUrl(value, label = 'url', max = 2048) {
  if (typeof value !== 'string' || value.length > max) throw new ValidationError(`${label} is too long.`);
  let url;
  try { url = new URL(value); } catch { throw new ValidationError(`enter a valid ${label}.`); }
  if (url.href.length > max) throw new ValidationError(`${label} is too long after url encoding.`);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new ValidationError(`${label} must use https, without a password or custom port.`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /(?:^|\.)(localhost|local|internal|lan|invalid|test)$/.test(host)) {
    throw new ValidationError(`${label} must be a public website.`);
  }
  return url.href;
}

function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new ValidationError(`${label} ${required ? 'is required and' : ''} must be under ${max + 1} characters.`);
  }
  return value.trim();
}

export function normalizeCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('invalid card.');
  const title = text(value.title, 'title', 100, true);
  const description = text(value.description ?? '', 'description', 1200);
  const url = httpsUrl(value.url, 'destination url', 512);
  const color = value.color ?? '#5865f2';
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new ValidationError('choose a six-digit hex color.');
  if (!Array.isArray(value.buttons) || value.buttons.length > 5) throw new ValidationError('use up to five buttons.');
  if (!Array.isArray(value.images) || value.images.length > 10) throw new ValidationError('use up to ten images.');
  const buttons = value.buttons.map(button => ({
    label: text(button?.label, 'button label', 80, true),
    url: httpsUrl(button?.url, 'button url', 512),
  }));
  const images = value.images.map(image => httpsUrl(image, 'image url'));
  const card = { title, description, url, color: color.toLowerCase(), buttons, images };
  if (payloadBytes(card) > MAX_BYTES) throw new ValidationError('card exceeds discord’s 3,000-byte limit. shorten text or remove a link or image.');
  return card;
}

export function buildEmbed(card) {
  const title = card.title.replace(/([\\*_`~|\[\]<>#])/g, '\\$1');
  const components = [{ type: 10, content: `## ${title}${card.description ? '\n' + card.description : ''}` }];
  if (card.images.length) components.push({ type: 12, items: card.images.map(url => ({ media: { url } })) });
  if (card.buttons.length) {
    components.push({ type: 14, spacing: 1 });
    components.push({ type: 1, components: card.buttons.map(button => ({ type: 2, style: 5, label: button.label, url: button.url })) });
  }
  return { component: { type: 17, accent_color: parseInt(card.color.slice(1), 16), components } };
}

export function embedJson(card) {
  return JSON.stringify(buildEmbed(card)).replace(/</g, '\\u003c');
}

export function payloadBytes(card) {
  return new TextEncoder().encode(embedJson(card)).length;
}

export function embedScript(card) {
  return '<script id="discord:component-embed" type="application/json">' + embedJson(card) + '</script>';
}
