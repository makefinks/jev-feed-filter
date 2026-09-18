import type { Evidence } from '../contracts';

export interface FeedAdapter {
  // Selector identifies the single container decorated for each feed item.
  selector: string;
  surface(): HTMLElement | null;
  // Null means unsupported or not yet rendered. IDs include the website namespace.
  extract(element: HTMLElement): { id: string; evidence: Evidence } | null;
  author(element: HTMLElement): string | null;
}
