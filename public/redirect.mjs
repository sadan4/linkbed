import { isSelfDestination } from './model.mjs';

const link = document.querySelector('[data-redirect]');
const pageUrl = document.querySelector('meta[property="og:url"]')?.content || location.href;
if (link && !isSelfDestination(link.href, pageUrl)) location.replace(link.href);
