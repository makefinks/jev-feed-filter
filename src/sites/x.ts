import type { FeedAdapter } from './adapter';
import { isFeedUrl } from '../sites';

function eligibleSurface(): HTMLElement | null {
  if (!isFeedUrl(location.href)) return null;
  const main = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]') ?? document.querySelector<HTMLElement>('main');
  const selected = main?.querySelector<HTMLElement>('[role="tablist"] [role="tab"][aria-selected="true"]');
  // The selected tab confirms the Home feed; its label and URL are localized/unstable.
  return selected ? main : null;
}

// X labels the post's own permalink — the timestamp anchor — `role="link"` on the anchor itself,
// and nests a quoted card's links inside a `[role="link"]` wrapper. Skip only nested links, then
// prefer the timestamp anchor so a quotation's status id can never be mistaken for the post's own.
function statusId(article: HTMLElement): string | null {
  const links = [...article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')].filter(
    link => !link.parentElement?.closest('[role="link"]'),
  );
  const link = links.find(candidate => candidate.querySelector('time')) ?? links[0];
  return link?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1] ?? null;
}
// Reserved single-segment paths that can appear as article links but are never profile handles.
const NON_HANDLE_PATHS = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'search', 'settings']);

function profileHandle(href: string | null): string | null {
  const match = (href ?? '').match(/^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/);
  return match && !NON_HANDLE_PATHS.has(match[1]) ? `@${match[1]}` : null;
}

// The post author's handle, for display in the filtered placeholder only. It is never sent
// for assessment: evidence stays text-only per the privacy scope. Use only the rendered
// header's profile link, which is structural and immune to @mentions in display names.
// Quoted cards nest their own headers inside [role="link"], so those are skipped.
function authorHandle(article: HTMLElement): string | null {
  for (const header of article.querySelectorAll<HTMLElement>('[data-testid="User-Name"]')) {
    if (header.closest('[role="link"]')) continue;
    for (const anchor of header.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const handle = profileHandle(anchor.getAttribute('href'));
      if (handle) return handle;
    }
  }
  return null;
}

function extract(article: HTMLElement) {
  const id = statusId(article);
  if (!id) return null;
  const text: string[] = [];
  const quotedText: string[] = [];
  const hidden: HTMLElement[] = [];
  for (const node of article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]')) {
    if (!node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) { hidden.push(node); continue; }
    const rendered = node.innerText.trim();
    if (!rendered) continue;
    // X renders quoted cards as nested links; preserve that relationship in state.
    const quote = node.closest('[role="link"]');
    if (quote && quote !== article && article.contains(quote)) quotedText.push(rendered);
    else text.push(rendered);
  }
  // Ad slots park under a display:none wrapper until X reveals them, so visibility checks
  // can drop real text and leave the post permanently unassessed. Fall back to
  // layout-independent text, deduped, only when nothing visible was found.
  if (!text.length && !quotedText.length) {
    const seen = new Set<string>();
    for (const node of hidden) {
      const rendered = (node.textContent ?? '').trim();
      if (!rendered || seen.has(rendered)) continue;
      seen.add(rendered);
      const quote = node.closest('[role="link"]');
      if (quote && quote !== article && article.contains(quote)) quotedText.push(rendered);
      else text.push(rendered);
    }
  }
  const evidence = { text: text.join('\n'), quotedText };
  return { id: `x:${id}`, evidence };
}

export const x: FeedAdapter = {
  selector: 'article[data-testid="tweet"]',
  surface: eligibleSurface,
  extract,
  author: authorHandle,
};
