import { icon } from './icons.mjs';

const toggle = document.querySelector('#theme-toggle');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  toggle.setAttribute('aria-label', 'switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode');
  toggle.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
}
let saved;
try { saved = localStorage.getItem('theme'); } catch {}
applyTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
toggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('theme', theme); } catch {}
});
