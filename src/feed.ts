import { ASSESSMENT_TIMEOUT, type Evidence, type Outcome, type Settings } from './contracts';
import { syncDebug } from './debug';
import { siteForUrl, type Site } from './sites';
import type { FeedAdapter } from './sites/adapter';
import { x } from './sites/x';
import { youtube } from './sites/youtube';

const site = siteForUrl(location.href);
const adapters: Record<Site, FeedAdapter> = { x, youtube };
const adapter = site ? adapters[site] : null;

interface Post {
  id: string;
  evidence: Evidence;
  fingerprint: string;
  revision: string;
  state: 'waiting' | 'pending' | 'complete';
  probability?: number;
  overlay?: HTMLElement;
  backdrop?: HTMLElement;
  stopAnimation?: () => void;
}
let settings: Settings | undefined;
const posts = new Map<HTMLElement, Post>();
const revealed = new Set<string>();
let scheduled = false;
const ARTICLE_SELECTOR = adapter?.selector ?? ':not(*)';
const EYE_OFF_SVG = '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const MAX_CONCURRENT = 16;
const CACHE_LIMIT = 300;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const animations = new Set<() => void>();
const articles = new Set<HTMLElement>();
const dirty = new Set<HTMLElement>();
const results = new Map<string, number>();
const requests = new Set<string>();
let cacheRevision: string | undefined;
let currentSurface: HTMLElement | null = null;
let wasActive = false;
let discover = true;
let retryAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let dead = false;
function filteringEnabled(): boolean {
  return settings?.enabled !== false;
}

function eligibleSurface(): HTMLElement | null {
  return adapter?.surface() ?? null;
}

function evidenceFor(article: HTMLElement): { id: string; evidence: Evidence; fingerprint: string } | null {
  const extracted = adapter?.extract(article);
  return extracted ? { ...extracted, fingerprint: JSON.stringify([extracted.id, extracted.evidence]) } : null;
}

function animateBlur(article: HTMLElement, post: Post): void {
  const layer = post.backdrop;
  if (!layer || document.hidden || reducedMotion.matches ||
      !article.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return;
  const rect = article.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.height > innerHeight * 2 ||
      rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return;

  const id = `jev-pixel-${crypto.randomUUID()}`;
  // Roughly 144 square tiles, including narrow Shorts cards; skip oversized posts.
  const cols = Math.max(1, Math.min(144, Math.round(Math.sqrt(144 * rect.width / rect.height))));
  const rows = Math.max(1, Math.round(144 / cols));
  const order = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  // One masked backdrop, not copies of site DOM or a blur filter per tile.
  // Eight groups fade independently; the whole mask is opaque after 420ms.
  const groups = Array.from({ length: 8 }, (_, group) => {
    const tiles = order.filter((_, i) => i % 8 === group).map(cell =>
      `<rect x="${cell % cols / cols}" y="${Math.floor(cell / cols) / rows}" width="${1 / cols}" height="${1 / rows}"/>`).join('');
    return `<g style="--jev-delay:${group * 120 / 7}ms">${tiles}</g>`;
  }).join('');
  layer.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><mask id="${id}" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox" x="0" y="0" width="1" height="1" mask-type="alpha"><g fill="white" shape-rendering="crispEdges">${groups}</g></mask></defs></svg>`;
  const maskUrl = new URL(location.href);
  maskUrl.hash = id;
  layer.style.setProperty('--jev-pixel-mask', `url("${maskUrl.href}")`);
  const finish = () => {
    clearTimeout(timer);
    layer.removeEventListener('animationend', onEnd);
    // Keep the same filtered pixels; only discard the now-opaque mask.
    layer.style.removeProperty('--jev-pixel-mask');
    layer.replaceChildren();
    animations.delete(finish);
    if (post.stopAnimation === finish) post.stopAnimation = undefined;
  };
  const lastGroup = layer.querySelector('mask > g > g:last-child');
  const onEnd = (event: AnimationEvent) => { if (event.target === lastGroup) finish(); };
  layer.addEventListener('animationend', onEnd);
  // Also settle if the host page suppresses animations or animationend is lost.
  const timer = setTimeout(finish, 450);
  post.stopAnimation = finish;
  animations.add(finish);
}

function clearPresentation(article: HTMLElement, post: Post): void {
  post.stopAnimation?.();
  post.backdrop?.remove();
  post.backdrop = undefined;
  article.classList.remove('jev-blurred', 'jev-collapsed', 'jev-post');
  post.overlay?.remove();
  post.overlay = undefined;
}

function present(article: HTMLElement, post: Post, freshAssessment = false): void {
  const filtered = post.probability !== undefined && settings !== undefined && post.probability > settings.threshold && !revealed.has(post.id);
  // Collapse zeroes item content; on YouTube's grid that leaves a stray bar inside the
  // cell, so YouTube always blurs and the hide-mode setting only affects X.
  // A stale background predates hideMode; fall back to blur until the extension reloads.
  const hideMode = site === 'youtube' ? 'blur' : settings?.hideMode ?? 'blur';
  const pct = post.probability === undefined ? 0 : Math.round(post.probability * 100);
  // ponytail: one badge per kept post while debugging; drop the mode if this ever costs scroll perf.
  const showDebug = !filtered && settings?.debug === true && post.probability !== undefined;
  const mode = filtered
    ? hideMode === 'collapse' ? 'collapsed' : 'blurred'
    : showDebug ? 'debug' : '';
  // X rewrites the article class attribute on scroll, wiping jev- classes while leaving the
  // overlay node behind. Class mutations are ignored by the observer, and scroll/interval only
  // re-runs present(), so a mode-only early return never repairs the presentation. Verify DOM state.
  // The handle resolves from rendered DOM, so it can arrive after the collapsed bar first
  // paints (or change when X recycles the node); track it on the overlay so a stale label rebuilds.
  const author = mode === 'collapsed' ? adapter?.author(article) ?? '' : '';
  const existing = post.overlay;
  const backdropAttached = !post.backdrop || (post.backdrop.isConnected && post.backdrop.parentElement === article);
  const attached = backdropAttached && !!existing && existing.isConnected && existing.parentElement === article && existing.dataset.mode === mode && (mode !== 'collapsed' || (existing.dataset.author ?? '') === author) && (mode !== 'debug' || existing.dataset.pct === String(pct));
  const classesOk = mode === ''
    ? !article.classList.contains('jev-blurred') && !article.classList.contains('jev-collapsed') && !article.classList.contains('jev-post')
    : mode === 'debug'
      ? article.classList.contains('jev-post') && !article.classList.contains('jev-blurred') && !article.classList.contains('jev-collapsed')
      : article.classList.contains('jev-post') && article.classList.contains(mode === 'blurred' ? 'jev-blurred' : 'jev-collapsed');
  if (classesOk && (mode === '' ? !existing : attached)) return;
  // Repair host class rewrites without restarting an in-flight tile fade.
  if (attached && mode) {
    if (mode === 'debug') {
      article.classList.add('jev-post');
      article.classList.remove('jev-blurred', 'jev-collapsed');
      return;
    }
    article.classList.add('jev-post', `jev-${mode}`);
    article.classList.remove(mode === 'blurred' ? 'jev-collapsed' : 'jev-blurred');
    return;
  }
  const animate = freshAssessment && mode === 'blurred' && !existing;
  clearPresentation(article, post);
  if (!mode) return;
  article.classList.add('jev-post');
  const overlay = document.createElement('div');
  overlay.className = 'jev-overlay';
  overlay.dataset.mode = mode;
  if (mode === 'debug') {
    overlay.dataset.pct = String(pct);
    overlay.setAttribute('aria-hidden', 'true');
    const badge = document.createElement('span');
    badge.textContent = `${pct}%`;
    badge.title = 'Filtering probability — a model estimate based on your guidance';
    overlay.title = 'Filtering probability — a model estimate based on your guidance';
    overlay.append(badge);
    post.overlay = overlay;
    article.prepend(overlay);
    return;
  }
  article.classList.add(mode === 'blurred' ? 'jev-blurred' : 'jev-collapsed');
  const label = document.createElement('span');
  if (mode === 'collapsed') label.textContent = author ? `Filtered · ${author} · ${pct}%` : `Filtered · ${pct}%`;
  else label.textContent = `${pct}%`;
  label.title = 'Filtering probability — a model estimate based on your guidance';
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.innerHTML = EYE_OFF_SVG;
  if (mode === 'collapsed') reveal.append('Reveal');
  reveal.setAttribute('aria-label', 'Reveal hidden post');
  reveal.title = 'Reveal';
  reveal.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    revealed.add(post.id);
    for (const [element, current] of posts) if (current.id === post.id) present(element, current);
  });
  overlay.title = 'Hidden by your filter — a model estimate based on your guidance. Select Reveal to show the post.';
  if (mode === 'collapsed') {
    overlay.dataset.author = author;
    overlay.append(label, reveal);
  } else overlay.append(reveal, label);
  post.overlay = overlay;
  article.prepend(overlay);
  // Watch-page metadata text resists backdrop-filter (an invert overlay leaves it untouched),
  // so those cards use the content filter below instead of a backdrop.
  const watchSidebar = site === 'youtube' && location.pathname === '/watch';
  if (mode === 'blurred' && !watchSidebar && CSS.supports('backdrop-filter', 'blur(5px)')) {
    // The same backdrop serves animated and instant hides, including cached posts.
    const backdrop = document.createElement('div');
    backdrop.className = 'jev-overlay jev-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.inert = true;
    post.backdrop = backdrop;
    article.prepend(backdrop);
    if (animate) animateBlur(article, post);
  }
}

function remember(fingerprint: string, probability: number): void {
  results.delete(fingerprint);
  results.set(fingerprint, probability);
  if (results.size > CACHE_LIMIT) results.delete(results.keys().next().value!);
}

async function assess(article: HTMLElement, post: Post): Promise<void> {
  const requestKey = JSON.stringify([post.revision, post.fingerprint]);
  requests.add(requestKey);
  post.state = 'pending';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: Outcome = { unavailable: true };
  try {
    outcome = await Promise.race([
      chrome.runtime.sendMessage({ type: 'assess', evidence: post.evidence, revision: post.revision }),
      new Promise<Outcome>(resolve => { timer = setTimeout(() => resolve({ unavailable: true }), ASSESSMENT_TIMEOUT + 1000); })
    ]);
  } catch {
    outcome = { unavailable: true };
  } finally {
    clearTimeout(timer);
    requests.delete(requestKey);
  }
  const surface = eligibleSurface();
  if (!filteringEnabled() || settings?.revision !== post.revision || !surface) { schedule(); return; }
  const probability = 'probability' in outcome && Number.isFinite(outcome.probability) && outcome.probability >= 0 && outcome.probability <= 1
    ? outcome.probability : undefined;
  // A detached article can still produce a reusable result, but never decorate a recycled node.
  if (probability !== undefined && cacheRevision === post.revision) remember(post.fingerprint, probability);
  if (posts.get(article) !== post || !article.isConnected || !surface.contains(article)) { schedule(); return; }
  if (evidenceFor(article)?.fingerprint !== post.fingerprint) {
    dirty.add(article);
    schedule();
    return;
  }
  if ('busy' in outcome) {
    post.state = 'waiting';
    // Other tabs share the background's eight slots. Use one cooldown for the entire queue,
    // not one polling loop per post; the next dispatch re-evaluates viewport priority.
    retryAt = performance.now() + 250;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(schedule, 250);
  } else {
    post.probability = probability;
    post.state = 'complete';
    present(article, post, true);
  }
  schedule();
}

function refreshSettings(previous: Settings | undefined): void {
  // Reloading the extension invalidates this script's context: sendMessage then throws
  // synchronously instead of rejecting. Go quiet permanently; a fresh script runs after navigation.
  let sent: Promise<Settings>;
  try {
    sent = chrome.runtime.sendMessage({ type: 'settings' });
  } catch {
    dead = true;
    return;
  }
  void sent.then((value: Settings) => {
    if (settings === previous) settings = value;
    schedule();
  }).catch(() => {});
}
function reconcile(): void {
  scheduled = false;
  if (dead) return;
  const surface = eligibleSurface();
  syncDebug(settings, surface !== null);
  const active = surface && filteringEnabled() && settings?.configured && settings.guidance.trim();
  // Paused posts are torn down, so resume rebuilds them from cache instantly.
  // Replay the tile fade once for items already in view; off-screen cards stay instant.
  const resuming = !!active && !wasActive;
  wasActive = !!active;
  if (cacheRevision !== settings?.revision) {
    results.clear();
    cacheRevision = settings?.revision;
  }
  if (surface !== currentSurface) {
    currentSurface = surface;
    discover = true;
    // A content script can start on an ineligible route and later navigate Home.
    if (surface) refreshSettings(settings);
  }
  for (const [article, post] of posts) {
    if (!active || !article.isConnected || !surface?.contains(article)) {
      clearPresentation(article, post);
      posts.delete(article);
    }
  }
  if (!active || !settings || !surface) {
    articles.clear();
    dirty.clear();
    discover = true;
    clearTimeout(retryTimer);
    retryAt = 0;
    return;
  }
  if (discover) {
    for (const article of surface.querySelectorAll<HTMLElement>(ARTICLE_SELECTOR)) {
      if (!articles.has(article)) dirty.add(article);
      articles.add(article);
    }
    discover = false;
  }
  for (const article of articles) {
    if (!article.isConnected || !surface.contains(article)) {
      articles.delete(article);
      dirty.delete(article);
      discover = true;
      continue;
    }
    let post = posts.get(article);
    if (!post && !dirty.has(article)) continue;
    if (!post || dirty.has(article) || post.revision !== settings.revision) {
      const extracted = evidenceFor(article);
      dirty.delete(article);
      if (post && (!extracted || post.fingerprint !== extracted.fingerprint || post.revision !== settings.revision)) {
        clearPresentation(article, post);
        posts.delete(article);
        post = undefined;
      }
      if (!extracted) continue;
      if (!post) {
        post = { ...extracted, revision: settings.revision, state: 'waiting' };
        if (!post.evidence.text && !post.evidence.quotedText.length) post.state = 'complete';
        posts.set(article, post);
      }
    }
    const cached = results.get(post.fingerprint);
    if (cached !== undefined) {
      remember(post.fingerprint, cached);
      post.probability = cached;
      post.state = 'complete';
    }
    present(article, post, resuming);
  }
  // Read each candidate's geometry once, after presentation writes. Two viewport heights
  // on either side support scroll reversals without velocity estimates or adaptive tuning.
  const queue: { article: HTMLElement; post: Post; distance: number }[] = [];
  for (const [article, post] of posts) {
    if (post.state !== 'waiting' || !article.checkVisibility({ checkVisibilityCSS: true })) continue;
    const rect = article.getBoundingClientRect();
    const distance = Math.max(0, -rect.bottom, rect.top - innerHeight);
    if (distance <= innerHeight * 2) queue.push({ article, post, distance });
  }
  queue.sort((a, b) => a.distance - b.distance);
  if (performance.now() < retryAt) return;
  for (const { article, post } of queue) {
    if (requests.size >= MAX_CONCURRENT) break;
    if (!requests.has(JSON.stringify([post.revision, post.fingerprint]))) void assess(article, post);
  }
}
function schedule(): void {
  if (!scheduled && !dead) { scheduled = true; requestAnimationFrame(reconcile); }
}
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'changed') { settings = message.settings; schedule(); }
});
refreshSettings(undefined);
new MutationObserver(changes => {
  let changed = false;
  for (const change of changes) {
    const target = change.target instanceof Element ? change.target : change.target.parentElement;
    if (!target || target.closest('.jev-overlay')) continue;
    if (change.type === 'childList' && [...change.addedNodes, ...change.removedNodes].every(node =>
      node instanceof Element && node.classList.contains('jev-overlay'))) continue;
    changed = true;
    const article = target.closest<HTMLElement>(ARTICLE_SELECTOR);
    if (article) dirty.add(article);
    else if (change.type === 'attributes') {
      for (const descendant of target.querySelectorAll<HTMLElement>(ARTICLE_SELECTOR)) dirty.add(descendant);
    }
    if (change.type === 'childList') {
      discover = true;
      for (const node of change.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(ARTICLE_SELECTOR)) dirty.add(node);
        for (const descendant of node.querySelectorAll<HTMLElement>(ARTICLE_SELECTOR)) dirty.add(descendant);
      }
    }
  }
  if (changed) schedule();
}).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-selected', 'href', 'style', 'hidden'] });
function stopAnimations(): void {
  for (const finish of animations) finish();
}
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) stopAnimations(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopAnimations(); });
addEventListener('scroll', schedule, { passive: true });
addEventListener('resize', schedule);
addEventListener('popstate', schedule);
// YouTube hydrates inline previews on thumbnail hover, underneath the blur. Swallow hover
// activation inside filtered cards so previews never start; clicks (including Reveal) still work.
if (site === 'youtube') {
  for (const type of ['mouseenter', 'mouseover', 'pointerover']) {
    document.addEventListener(type, event => {
      if (event.target instanceof Element && event.target.closest('.jev-blurred, .jev-collapsed')) {
        event.stopPropagation();
        event.preventDefault();
      }
    }, true);
  }
}
// pushState does not emit a navigation event in isolated content-script worlds.
setInterval(schedule, 750);
