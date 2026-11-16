import { embedScript } from './public/model.mjs';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function renderCard(card, url) {
  const e = escapeHtml;
  const images = card.images.map((image, index) => `<img src="${e(image)}" alt="${e(card.title)} — image ${index + 1}" referrerpolicy="no-referrer" loading="lazy">`).join('');
  const buttons = card.buttons.map(button => `<a class="button" href="${e(button.url)}" target="_blank" rel="noopener noreferrer">${e(button.label)} <span aria-hidden="true">↗</span></a>`).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(card.title)} · lembed</title>
<meta name="description" content="${e(card.description)}">
<meta property="og:title" content="${e(card.title)}">
<meta property="og:description" content="${e(card.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="lembed">
<meta property="og:url" content="${e(url)}">
${card.images.map(image => `<meta property="og:image" content="${e(image)}">`).join('\n')}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(card.title)}">
<meta name="twitter:description" content="${e(card.description)}">
<meta name="theme-color" content="${card.color}">
<link rel="stylesheet" href="/style.css">
${embedScript(card)}
</head><body class="public-page">
<header class="public-header"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">p.</span>lembed</a><a class="text-link" href="/">make your own card ↗</a></header>
<main class="public-content"><article class="published-card">
<p class="eyebrow">shared with lembed</p><h1>${e(card.title)}</h1>
<p class="published-description">${e(card.description)}</p>
${images ? `<div class="published-gallery">${images}</div>` : ''}
<div class="published-buttons">${buttons}</div>
<a class="destination" href="${e(card.url)}" rel="noopener noreferrer">${e(new URL(card.url).hostname)} ↗</a>
</article><p class="public-note">paste this page’s link in discord to share its card.</p></main>
</body></html>`;
}
