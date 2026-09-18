import type { FeedAdapter } from './adapter';
import { isFeedUrl } from '../sites';

function surface(): HTMLElement | null {
  if (!isFeedUrl(location.href)) return null;
  // Limit watch pages to recommendations, never the player, description, or comments.
  const container = document.querySelector<HTMLElement>(location.pathname === '/watch'
    ? 'ytd-watch-flexy:not([hidden]) #related'
    : 'ytd-browse[page-subtype="home"]:not([hidden])');
  return container?.checkVisibility({ checkVisibilityCSS: true }) ? container : null;
}

// Rendered channel name for assessment. Shorts cards often show none; empty then.
function channelName(element: HTMLElement): string {
  const named = element.querySelector<HTMLElement>('ytd-channel-name');
  if (named?.innerText.trim()) return named.innerText.trim();
  for (const anchor of element.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!/^\/(?:@|channel\/|c\/|user\/)/.test(anchor.getAttribute('href') ?? '')) continue;
    const name = anchor.innerText.trim();
    if (name) return name;
  }
  return '';
}

function extract(element: HTMLElement) {
  // Only the Shorts shelf qualifies alongside regular video cards and the Explore-topics
  // chips shelf (whose videos nest inside a plain rich shelf); other shelves stay out of scope.
  const shelf = element.closest('ytd-rich-shelf-renderer:not([is-shorts])');
  if ((shelf && !shelf.closest('ytd-chips-shelf-with-video-shelf-renderer')) ||
      element.querySelector('ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer')) return null;
  const title = element.querySelector<HTMLElement>(
    'a#video-title-link, #video-title, .yt-lockup-metadata-view-model__title, .ytLockupMetadataViewModelTitle')
    ?? Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href*="/shorts/"]')).find(link => link.innerText.trim());
  if (!title?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return null;
  const text = title.innerText.trim();
  if (!text) return null;
  // The lockup title is not always the link itself: it may be the anchor, sit inside one,
  // or wrap one. Fall back to any watch link in the card so text and id resolve independently.
  const anchor = title.closest<HTMLAnchorElement>('a[href]')
    ?? title.querySelector<HTMLAnchorElement>('a[href]')
    ?? element.querySelector<HTMLAnchorElement>('a[href*="/watch?v="], a[href*="/shorts/"]');
  const href = anchor?.getAttribute('href');
  if (!href) return null;
  let url: URL;
  try { url = new URL(href, location.origin); } catch { return null; }
  if (url.origin !== 'https://www.youtube.com') return null;
  // Mix cards carry list= but are still single-video recommendations: assess on the video title.
  const id = url.pathname === '/watch'
    ? url.searchParams.get('v')
    : url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] ?? null : null;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return { id: `youtube:${id}`, evidence: { text, quotedText: [], author: channelName(element) } };
}

export const youtube: FeedAdapter = {
  // Modern lockups may be nested inside the classic item container. Never decorate both.
  selector: 'ytd-rich-item-renderer, ytd-compact-video-renderer, yt-lockup-view-model:not(ytd-rich-item-renderer yt-lockup-view-model, ytd-compact-video-renderer yt-lockup-view-model)',
  surface,
  extract,
  author: () => null,
};
