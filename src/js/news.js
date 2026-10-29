// Recent news from Home Assistant, two ways:
//  - a feed sensor that keeps a list of stories in an attribute (the HACS "feedparser" sensor's
//    `entries`, or a RESTful sensor reading an RSS feed into `item`), which is the full list;
//  - the Feedreader integration's event entities (event.just_in, ...), which only hold the latest
//    story. Each new one seen is added to a short log kept in the Home Assistant profile, so the
//    wall screen that is always on collects them for the phones.
// News websites block being read straight from the browser, so Home Assistant has to fetch them.

import { domainOf, nameOf } from './entities.js';
import { esc } from './controls.js';
import { icon } from './icons.js';

export const NEWS_KEEP = 40;
const NEWS_DAYS = 3;

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/\s+/g, ' ').trim();

function when(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function story(raw, source) {
  const title = strip(raw.title?.['#text'] ?? raw.title);
  if (!title) return null;
  const link = String(raw.link?.['@href'] ?? raw.link ?? raw.guid?.['#text'] ?? raw.guid ?? '');
  const image = raw.image || raw['media:thumbnail']?.['@url'] || [].concat(raw['media:content'] || [])[0]?.['@url'] || '';
  return {
    id: link || title,
    title,
    link: /^https?:\/\//.test(link) ? link : '',
    summary: strip(raw.summary ?? raw.description ?? '').slice(0, 400),
    image: /^https?:\/\//.test(image) ? image : '',
    at: when(raw.published ?? raw.pubDate ?? raw.updated) ?? null,
    source,
  };
}

/** Sensors holding a list of stories, and Feedreader's event entities. */
export function newsSources(states) {
  const lists = [];
  const events = [];
  for (const s of states.values()) {
    const d = domainOf(s.entity_id);
    const a = s.attributes || {};
    if (d === 'event' && (a.event_type === 'feedreader' || (a.event_types || []).includes('feedreader'))) events.push(s);
    else if (d === 'sensor' && [a.entries, a.item, a.items].some(Array.isArray)) lists.push(s);
  }
  return { lists, events };
}

/** The latest story an event entity holds right now. */
export function storyFromEvent(s) {
  const a = s.attributes || {};
  const st = story({ title: a.title, link: a.link, description: a.description || a.content, published: a.published || s.state }, nameOf(s));
  if (st) st.at ||= when(s.state);
  return st;
}

/** Every story on show, newest first, without repeats. */
export function newsItems(states, log = []) {
  const { lists, events } = newsSources(states);
  const all = [...log];
  for (const s of lists) {
    const a = s.attributes;
    for (const raw of [].concat(a.entries || a.items || a.item || [])) {
      const st = story(raw, nameOf(s).replace(/\s*(news)?\s*feed$/i, '') || 'News');
      if (st) all.push(st);
    }
  }
  for (const s of events) {
    const st = storyFromEvent(s);
    if (st) all.push(st);
  }
  return newsMerge(all);
}

export function newsMerge(list) {
  const cutoff = Date.now() - NEWS_DAYS * 86_400_000;
  const seen = new Map();
  for (const n of list) {
    if (!n?.title || (n.at && n.at < cutoff)) continue;
    const key = n.link || n.title.toLowerCase();
    const had = seen.get(key);
    if (!had || (!had.summary && n.summary)) seen.set(key, { ...had, ...n });
  }
  return [...seen.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, NEWS_KEEP);
}

const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

/** Headlines; each opens to its summary and a link to the full story. */
export function newsHtml(items, { limit = 6, open = '' } = {}) {
  if (!items.length) return '';
  return `<ol class="news">${items.slice(0, limit).map((n) => {
    const isOpen = open === n.id;
    return `<li class="story${isOpen ? ' open' : ''}">
      <button type="button" class="story-head" data-story="${esc(n.id)}" aria-expanded="${isOpen}">
        ${n.image ? `<img class="story-img" src="${esc(n.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <span class="story-title">${esc(n.title)}</span>
        <span class="story-meta">${esc([n.source, ago(n.at)].filter(Boolean).join(' · '))}</span>
      </button>
      ${isOpen ? `<div class="story-body">
        ${n.summary ? `<p>${esc(n.summary)}</p>` : ''}
        ${n.link ? `<a class="story-link" href="${esc(n.link)}" target="_blank" rel="noopener">Read the full story ${icon('openNew')}</a>` : ''}
      </div>` : ''}
    </li>`;
  }).join('')}</ol>`;
}
