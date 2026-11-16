import { normalizeCard, payloadBytes, embedScript, httpsUrl, MAX_BYTES } from './model.mjs';

const $ = selector => document.querySelector(selector);
const fields = { url: $('#source-url'), title: $('#title'), description: $('#description'), color: $('#color'), images: $('#images'), slug: $('#slug') };
let editing = null;
let published = null;
let saved = [];
let dirty = false;
let slugEdited = false;
let toastTimer;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2800);
}

function slugify(value) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '');
}

function addButton(button = { label: '', url: '' }) {
  const index = $('#button-list').children.length;
  const row = element('div', undefined, 'button-row');
  const label = element('label', 'button text');
  const input = element('input', undefined, 'button-label-input');
  input.id = 'button-label-' + index + '-' + Date.now();
  label.htmlFor = input.id;
  input.maxLength = 80;
  input.required = true;
  input.placeholder = 'take a look';
  input.value = button.label;
  const urlLabel = element('label', 'destination', 'url-label');
  const url = element('input', undefined, 'button-url-input');
  url.id = input.id + '-url';
  urlLabel.htmlFor = url.id;
  url.type = 'url';
  url.maxLength = 512;
  url.required = true;
  url.placeholder = 'https://example.com';
  url.value = button.url;
  const remove = element('button', '×', 'remove-button');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'remove button ' + (index + 1));
  remove.addEventListener('click', () => { row.remove(); changed(); });
  row.append(label, input, urlLabel, url, remove);
  $('#button-list').append(row);
}

function draft() {
  return {
    title: fields.title.value.trim(),
    description: fields.description.value.trim(),
    url: fields.url.value.trim(),
    color: fields.color.value,
    images: fields.images.value.split('\n').map(value => value.trim()).filter(Boolean),
    buttons: [...document.querySelectorAll('.button-row')].map(row => ({
      label: row.querySelector('.button-label-input').value.trim(),
      url: row.querySelector('.button-url-input').value.trim(),
    })),
  };
}

function previewMarkdown(text) {
  const fragment = document.createDocumentFragment();
  // small preview subset; the actual embed is rendered by discord.
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (part.startsWith('**') && part.endsWith('**')) fragment.append(element('strong', part.slice(2, -2)));
    else fragment.append(document.createTextNode(part));
  }
  return fragment;
}

function update() {
  const card = draft();
  $('#title-count').textContent = card.title.length + ' / 100';
  $('#button-count').textContent = card.buttons.length + ' / 5';
  $('#image-count').textContent = card.images.length + ' / 10';
  $('#add-button').disabled = card.buttons.length >= 5;
  $('#preview-title').textContent = card.title || 'your next good thing.';
  $('#preview-description').replaceChildren(previewMarkdown(card.description || 'a launch, a project, an open invitation.\ngive it a title. let the card do the talking.'));
  $('#preview-url').textContent = location.host + '/p/' + (fields.slug.value || 'your-next-thing');
  $('#preview-card').style.borderColor = card.color;
  const buttons = card.buttons.length ? card.buttons : [{ label: 'take a look', url: '' }];
  $('#preview-buttons').replaceChildren(...buttons.map(button => {
    let url;
    try { url = httpsUrl(button.url); } catch {}
    const node = element(url ? 'a' : 'span', button.label || 'your button', 'preview-button');
    if (url) { node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    node.append(element('span', '↗'));
    return node;
  }));
  const gallery = $('#preview-gallery');
  gallery.hidden = !card.images.length;
  gallery.replaceChildren(...card.images.slice(0, 10).map(url => {
    const img = element('img');
    img.alt = card.title ? card.title + ' preview image' : 'card preview image';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    try { img.src = httpsUrl(url, 'image url'); } catch {
      return element('div', 'enter a public https image url', 'broken-image');
    }
    img.addEventListener('error', () => img.replaceWith(element('div', 'image could not load — check its url', 'broken-image')), { once: true });
    return img;
  }));
  const bytes = payloadBytes(card);
  $('#byte-count').textContent = bytes.toLocaleString() + ' / 3,000 bytes';
  $('#byte-count').classList.toggle('over-limit', bytes > MAX_BYTES);
  $('#preview-warning').textContent = bytes > MAX_BYTES ? 'too much for one card. shorten text or remove links and images.' : '';
  $('#publish-button').disabled = bytes > MAX_BYTES;
  $('#publish-button').firstChild.textContent = editing ? 'publish changes ' : 'publish card ';
  document.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === card.color)));
  $('#embed-code').value = embedScript(card);
  $('#copy-code').disabled = !card.title || !card.url || bytes > MAX_BYTES;
  $('#publish-result').hidden = !published || dirty;
}

function changed() {
  dirty = true;
  $('#form-status').textContent = '';
  update();
}

function fill(card, slug = '') {
  for (const name of ['url', 'title', 'description', 'color']) fields[name].value = card[name] ?? '';
  fields.images.value = (card.images ?? []).join('\n');
  fields.slug.value = slug;
  fields.slug.disabled = !!editing;
  $('#slug-hint').textContent = editing ? 'this link stays the same when you publish changes.' : 'lowercase letters, numbers, and hyphens.';
  $('#button-list').replaceChildren();
  (card.buttons ?? []).forEach(addButton);
  update();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'request failed.');
  return data;
}

async function refreshCards() {
  try {
    saved = await api('/api/cards');
    $('#card-count').textContent = saved.length;
    $('#saved-list').replaceChildren(...saved.map(card => {
      const row = element('div', undefined, 'saved-row');
      const info = element('div', undefined, 'saved-title');
      info.append(element('strong', card.title), element('span', '/p/' + card.slug));
      const edit = element('button', 'edit', 'text-button');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        if (dirty && !confirm('replace your unsaved draft with this card?')) return;
        editing = card.slug;
        slugEdited = true;
        published = null;
        dirty = false;
        fill(card, card.slug);
        $('#saved-cards').hidden = true;
        fields.title.focus();
      });
      const remove = element('button', 'delete', 'text-button delete-button');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!confirm('delete this published card? its link will stop working.')) return;
        try {
          await api('/api/cards/' + card.slug, { method: 'DELETE' });
          if (editing === card.slug) reset(false);
          await refreshCards();
          toast('card deleted.');
        } catch (error) { toast(error.message); }
      });
      row.append(info, edit, remove);
      return row;
    }));
    if (!saved.length) $('#saved-list').append(element('p', 'your published cards will appear here.', 'hint'));
  } catch (error) {
    $('#form-status').textContent = 'could not load your cards. ' + error.message;
  }
}

function reset(ask = true) {
  if (ask && dirty && !confirm('start a new card and discard this draft?')) return;
  editing = null;
  published = null;
  dirty = false;
  slugEdited = false;
  fields.slug.disabled = false;
  fill({ url: '', title: '', description: '', color: '#5865f2', images: [], buttons: [{ label: '', url: '' }] });
  $('#form-status').textContent = '';
}

$('#card-form').addEventListener('input', event => {
  if (event.target === fields.slug) slugEdited = true;
  if (event.target === fields.title && !editing && !slugEdited) fields.slug.value = slugify(fields.title.value);
  changed();
});
$('#add-button').addEventListener('click', () => { addButton(); changed(); $('#button-list').lastChild.querySelector('input').focus(); });
document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => { fields.color.value = button.dataset.color; changed(); }));
$('#reset').addEventListener('click', () => reset());
$('#show-cards').addEventListener('click', () => { $('#saved-cards').hidden = !$('#saved-cards').hidden; refreshCards(); });
$('#close-cards').addEventListener('click', () => { $('#saved-cards').hidden = true; });

const templates = {
  launch: { title: 'meet the next version.', description: 'built with care. ready for you.\n\nexplore what’s new, read the docs, and make it your own.', buttons: [{ label: 'try it out', url: 'https://example.com/' }, { label: 'read the docs', url: 'https://example.com/docs' }] },
  portfolio: { title: 'good work. good company.', description: 'a selection of things i’ve made, and a few things i’d love to make with you.\n\nopen for thoughtful projects.', buttons: [{ label: 'see my work', url: 'https://example.com/' }, { label: 'get in touch', url: 'https://example.com/contact' }] },
  event: { title: 'save you a seat?', description: 'good people, fresh ideas, and a reason to step away from your desk.\n\nall the details are one click away.', buttons: [{ label: 'event details', url: 'https://example.com/' }, { label: 'save your spot', url: 'https://example.com/register' }] },
};
document.querySelectorAll('[data-template]').forEach(button => button.addEventListener('click', () => {
  if (dirty && !confirm('replace your unsaved content with this template?')) return;
  const template = templates[button.dataset.template];
  const source = fields.url.value || 'https://example.com/';
  fill({ ...draft(), ...template, url: source, buttons: template.buttons.map((button, index) => ({ ...button, url: index ? new URL(button.url).pathname === '/' ? source : new URL(new URL(button.url).pathname, source).href : source })) }, editing || slugify(template.title));
  changed();
}));

$('#import-button').addEventListener('click', async () => {
  const button = $('#import-button');
  $('#form-status').textContent = '';
  try {
    httpsUrl(fields.url.value.trim());
    button.disabled = true;
    button.textContent = 'importing…';
    const card = await api('/api/import', { method: 'POST', body: JSON.stringify({ url: fields.url.value.trim() }) });
    fill(card, editing || (slugEdited ? fields.slug.value : slugify(card.title)));
    changed();
    toast('link imported. make it yours.');
  } catch (error) {
    $('#form-status').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'import ↓';
  }
});

$('#card-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#form-status').textContent = '';
  const button = $('#publish-button');
  try {
    const card = normalizeCard(draft());
    button.disabled = true;
    button.textContent = 'publishing…';
    published = await api(editing ? '/api/cards/' + editing : '/api/cards', {
      method: editing ? 'PUT' : 'POST',
      body: JSON.stringify({ ...card, slug: fields.slug.value }),
    });
    editing = published.slug;
    dirty = false;
    slugEdited = true;
    fields.slug.disabled = true;
    $('#slug-hint').textContent = 'this link stays the same when you publish changes.';
    $('#published-url').value = published.url;
    $('#open-card').href = published.url;
    $('#local-note').hidden = !['localhost', '127.0.0.1'].includes(new URL(published.url).hostname);
    update();
    $('#publish-result').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
    toast('published. your card is ready.');
    await refreshCards();
  } catch (error) {
    $('#form-status').textContent = error.message;
  } finally {
    button.replaceChildren(document.createTextNode(editing ? 'publish changes ' : 'publish card '), element('span', '↗'));
    button.disabled = payloadBytes(draft()) > MAX_BYTES;
  }
});

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('copied to clipboard.'); } catch {
    $('#form-status').textContent = 'clipboard unavailable. select and copy the text instead.';
  }
}
$('#copy-link').addEventListener('click', () => published && copy(published.url));
$('#copy-fresh').addEventListener('click', () => published && copy(published.freshUrl));
$('#copy-code').addEventListener('click', () => {
  try { normalizeCard(draft()); copy($('#embed-code').value); } catch (error) { $('#form-status').textContent = error.message; }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });

reset(false);
refreshCards();
