export type Site = 'x' | 'youtube';

interface SiteDef {
  origins: string[];
  matches: string[];
  isFeedPath: (pathname: string) => boolean;
}

const SITES: Record<Site, SiteDef> = {
  x: {
    origins: ['https://x.com'],
    matches: ['https://x.com/*'],
    isFeedPath: pathname => pathname === '/home' || pathname === '/home/',
  },
  youtube: {
    origins: ['https://www.youtube.com'],
    matches: ['https://www.youtube.com/*'],
    isFeedPath: pathname => pathname === '/' || pathname === '/watch',
  },
};

export const FEED_MATCHES = Object.values(SITES).flatMap(def => def.matches);

export function siteForUrl(value: string): Site | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    for (const [site, def] of Object.entries(SITES) as [Site, SiteDef][]) {
      if (def.origins.includes(url.origin)) return site;
    }
  } catch {}
  return null;
}

export function isFeedUrl(value: string): boolean {
  const site = siteForUrl(value);
  if (!site) return false;
  return SITES[site].isFeedPath(new URL(value).pathname);
}
