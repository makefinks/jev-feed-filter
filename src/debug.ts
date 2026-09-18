import type { DebugStats, DecisionLogEntry, Settings } from './contracts';

let host: HTMLElement | undefined;
let statusEl: HTMLElement;
let noteEl: HTMLElement;
let fields: Record<string, HTMLElement>;
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
let epoch = 0;
let collapsed = false;
const PLOT_WIDTH = 260;
const PLOT_HEIGHT = 56;
const PLOT_STEP = 2;
const PLOT_SPEED = 24;
const PLOT_CANVAS_WIDTH = PLOT_WIDTH + PLOT_STEP;
const PLOT_POINTS = Math.floor(PLOT_WIDTH / PLOT_STEP) + 1;
let plotEl: HTMLCanvasElement;
let plotHistory: number[] = [];
let plotCurrent = 0;
let plotLimit = 1;
let plotOffset = 0;
let plotFrame: number | undefined;
let plotLastFrame = 0;
let logCountEl: HTMLElement;
let logCopyEl: HTMLButtonElement;
let lastRecent: DecisionLogEntry[] = [];

function isStats(value: unknown): value is DebugStats {
  if (!value || typeof value !== 'object') return false;
  const stats = value as Record<string, unknown>;
  if (typeof stats.session !== 'string') return false;
  for (const key of ['samples', 'inFlight', 'limit', 'cacheHits', 'failures', 'timeouts']) {
    if (typeof stats[key] !== 'number' || !Number.isSafeInteger(stats[key]) || stats[key] < 0) return false;
  }
  for (const key of ['latest', 'p50', 'p95']) {
    if (stats[key] !== null && (typeof stats[key] !== 'number' || !Number.isFinite(stats[key]) || stats[key] < 0)) return false;
  }
  if (!Array.isArray(stats.recent)) return false;
  return true;
}

function duration(value: number | null): string {
  return value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}
function renderPlot(): void {
  const context = plotEl.getContext('2d');
  if (!context) return;
  const width = plotEl.width;
  const height = plotEl.height;
  const baseline = height - 4;
  const scale = Math.max(plotLimit, 1);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#ffffff18';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, baseline + 0.5);
  context.lineTo(width, baseline + 0.5);
  context.moveTo(0, 0.5);
  context.lineTo(width, 0.5);
  context.stroke();
  context.strokeStyle = '#eeeeee';
  context.lineWidth = 1.5;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  for (let index = 0; index < plotHistory.length; index += 1) {
    const value = plotHistory[index];
    const x = index * PLOT_STEP;
    const y = baseline - Math.min(Math.max(value, 0), scale) / scale * (height - 8);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}
function drawPlot(timestamp: number): void {
  if (!host) {
    plotFrame = undefined;
    plotLastFrame = 0;
    return;
  }
  let redraw = false;
  if (plotLastFrame > 0) {
    plotOffset += Math.min(timestamp - plotLastFrame, 100) / 1000 * PLOT_SPEED;
    while (plotOffset >= PLOT_STEP) {
      plotOffset -= PLOT_STEP;
      plotHistory.shift();
      plotHistory.push(plotCurrent);
      redraw = true;
    }
  }
  plotLastFrame = timestamp;
  if (redraw) renderPlot();
  plotEl.style.transform = `translate3d(${-plotOffset}px, 0, 0)`;
  plotFrame = requestAnimationFrame(drawPlot);
}

function copyLog(): void {
  const button = logCopyEl;
  const done = (label: string): void => {
    button.textContent = label;
    setTimeout(() => { button.textContent = 'Copy JSON'; }, 1500);
  };
  try {
    void navigator.clipboard.writeText(JSON.stringify([...lastRecent].reverse(), null, 1)).then(
      () => done(`Copied ${lastRecent.length}`),
      () => done('Copy failed'),
    );
  } catch {
    done('Copy failed');
  }
}

async function refresh(reset = false): Promise<void> {
  if (!host || busy || (!reset && document.hidden)) return;
  const current = epoch;
  busy = true;
  try {
    const stats: unknown = await chrome.runtime.sendMessage({ type: reset ? 'debugReset' : 'debugStats' });
    if (current !== epoch || !host) return;
    if (!isStats(stats)) throw new Error('Metrics unavailable');
    fields.latest.textContent = duration(stats.latest);
    fields.p50.textContent = duration(stats.p50);
    fields.p95.textContent = duration(stats.p95);
    fields.inFlight.textContent = `${stats.inFlight} / ${stats.limit}`;
    plotCurrent = Math.min(stats.inFlight, stats.limit);
    plotLimit = Math.max(stats.limit, 1);
    renderPlot();
    fields.cacheHits.textContent = String(stats.cacheHits);
    fields.failures.textContent = String(stats.failures);
    fields.timeouts.textContent = String(stats.timeouts);
    fields.failures.dataset.warning = String(stats.failures > 0);
    noteEl.textContent = `${stats.samples} samples · All tabs`;
    logCountEl.textContent = String(stats.recent.length);
    lastRecent = stats.recent;
  } catch {
    if (current !== epoch || !host) return;
    for (const field of Object.values(fields)) field.textContent = '—';
    logCountEl.textContent = '—';
    lastRecent = [];
    noteEl.textContent = 'Metrics unavailable';
  } finally {
    if (current === epoch) busy = false;
  }
}

function mount(): void {
  host = document.createElement('div');
  host.className = 'jev-debug';
  // Keep X styles and the feed observer out of panel internals.
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; left: 18px; bottom: 18px; z-index: 2147483647; color-scheme: dark; }
      * { box-sizing: border-box; }
      section { width: min(292px, calc(100vw - 36px)); max-height: calc(100dvh - 36px); overflow: auto; color: #eee; background: #111111f5; border: 1px solid #ffffff1c; border-radius: 16px; box-shadow: 0 12px 48px #0006, 0 2px 8px #0004; backdrop-filter: blur(20px); font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      button { color: #999; background: none; border: 0; cursor: pointer; font: inherit; padding: 4px 7px; border-radius: 5px; }
      button:hover { color: #eee; background: #ffffff0c; }
      button:focus-visible { outline: 2px solid #eee; outline-offset: 2px; }
      header { display: flex; align-items: center; gap: 8px; padding: 13px 16px; }
      #collapse { margin-left: auto; font-size: 16px; line-height: 1; }
      #body { border-top: 1px solid #ffffff0d; padding: 12px 16px; }
      [hidden] { display: none !important; }
      #status { color: #999; font-size: 10px; margin-left: auto; text-align: right; }
      .label { color: #999; font-size: 11px; }
      .hero { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 12px; }
      #latest { font-size: 30px; font-weight: 500; letter-spacing: -.06em; color: #eee; }
      .plot { margin: 0 0 14px; }
      .plot-heading { display: flex; align-items: baseline; justify-content: space-between; }
      .plot-heading strong { font-size: 14px; }
      .plot-window { overflow: hidden; height: 56px; margin-top: 4px; }
      .plot canvas { display: block; width: calc(100% + 2px); height: 56px; will-change: transform; }
      .percentiles { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 14px; }
      .percentiles strong { display: block; margin-top: 2px; font-weight: 500; font-size: 14px; }
      strong { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
      dl { display: grid; grid-template-columns: 1fr auto; gap: 7px; margin: 0; }
      dt { color: #999; } dd { margin: 0; }
      [data-warning="true"] { color: #fbbf7a; }
      .log { display: flex; align-items: center; justify-content: space-between; margin-top: 14px; border-top: 1px solid #ffffff0d; padding-top: 10px; }
      footer { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; border-top: 1px solid #ffffff0d; padding-top: 8px; }
      #note { color: #888; font-size: 10px; }
    </style>
    <section aria-label="Feed filter debug">
      <header><h2>Jev Debug</h2><span id="status"></span><button id="collapse" type="button" aria-label="Collapse debug panel" aria-expanded="true" aria-controls="body">−</button></header>
      <div id="body">
        <div class="hero" title="Latest successful provider round trip through validation. Excludes cache hits, backpressure and failures."><span class="label">Latency</span><strong id="latest">—</strong></div>
        <div class="percentiles"><div><span class="label" title="Median latency">p50</span><strong id="p50">—</strong></div><div><span class="label" title="95th percentile latency">p95</span><strong id="p95">—</strong></div></div>
        <div class="plot" title="Provider requests currently pending across all tabs.">
          <div class="plot-heading"><span class="label">Requests in flight</span><strong id="inFlight">—</strong></div>
          <div class="plot-window"><canvas id="requestsPlot" width="${PLOT_CANVAS_WIDTH}" height="${PLOT_HEIGHT}" role="img" aria-label="Requests in flight over time"></canvas></div>
        </div>
        <dl>
          <dt title="Assessments served from the success cache; no provider request">Cache hits</dt><dd><strong id="cacheHits">—</strong></dd>
          <dt title="Failed provider requests, including timeouts. Cancelled or obsolete requests excluded.">Failures</dt><dd><strong id="failures">—</strong></dd>
          <dt title="Subset of failures that exceeded the request deadline">Timeouts</dt><dd><strong id="timeouts">—</strong></dd>
        </dl>
        <div class="log" title="Copy recent assessments with the exact evidence and guidance sent to the provider. Local only, newest first, cleared on reset or worker restart.">
          <span class="label">Recent decisions (<strong id="logCount">—</strong>)</span><button id="logCopy" type="button">Copy JSON</button>
        </div>
        <footer><span id="note" title="Last 100 successful requests. Counters reset when debugging is enabled, reset, or the service worker restarts.">Waiting…</span><button id="reset" type="button" title="Reset debug metrics across all tabs, not the assessment cache">Reset</button></footer>
      </div>
    </section>`;
  statusEl = root.querySelector<HTMLElement>('#status')!;
  fields = Object.fromEntries(['latest', 'p50', 'p95', 'inFlight', 'cacheHits', 'failures', 'timeouts'].map(key => [key, root.querySelector<HTMLElement>(`#${key}`)!]));
  noteEl = root.querySelector<HTMLElement>('#note')!;
  logCountEl = root.querySelector<HTMLElement>('#logCount')!;
  logCopyEl = root.querySelector<HTMLButtonElement>('#logCopy')!;
  lastRecent = [];
  logCopyEl.addEventListener('click', copyLog);
  const collapseEl = root.querySelector<HTMLButtonElement>('#collapse')!;
  plotEl = root.querySelector<HTMLCanvasElement>('#requestsPlot')!;
  plotHistory = Array(PLOT_POINTS).fill(0);
  plotCurrent = 0;
  plotLimit = 1;
  plotOffset = 0;
  plotLastFrame = 0;
  const bodyEl = root.querySelector<HTMLElement>('#body')!;
  const collapse = (): void => {
    bodyEl.hidden = collapsed;
    collapseEl.textContent = collapsed ? '+' : '−';
    collapseEl.setAttribute('aria-expanded', String(!collapsed));
    collapseEl.setAttribute('aria-label', collapsed ? 'Expand debug panel' : 'Collapse debug panel');
  };
  collapseEl.addEventListener('click', () => { collapsed = !collapsed; collapse(); });
  collapse();
  root.querySelector('#reset')!.addEventListener('click', () => { void refresh(true); });
  document.body.append(host);
  timer = setInterval(() => { void refresh(); }, 1000);
  renderPlot();
  void refresh();
  plotFrame = requestAnimationFrame(drawPlot);
}

export function syncDebug(settings: Settings | undefined, eligible: boolean): void {
  if (!settings?.debug || !eligible) {
    if (host) {
      host.remove();
      host = undefined;
      clearInterval(timer);
      timer = undefined;
      if (plotFrame !== undefined) cancelAnimationFrame(plotFrame);
      plotFrame = undefined;
      plotLastFrame = 0;
      epoch += 1;
      busy = false;
    }
    return;
  }
  if (!host) mount();
  const status = !settings.configured ? 'No API key' : !settings.guidance.trim() ? 'No Guidance' : !settings.enabled ? 'Paused' : settings.warning ? 'Warning' : 'Active';
  if (statusEl.textContent !== status) statusEl.textContent = status;
}
