import {
  ASSESSMENT_TIMEOUT,
  PROVIDERS,
  QUESTION,
  isProvider,
  type DebugStats,
  type DecisionLogEntry,
  type Evidence,
  type HideMode,
  type Message,
  type Outcome,
  type Provider,
  type Settings,
} from './contracts';
import { FEED_MATCHES, isFeedUrl } from './sites';

interface Persisted {
  provider: Provider;
  apiKeys: Partial<Record<Provider, string>>;
  guidance: string;
  threshold: number;
  hideMode: HideMode;
  enabled: boolean;
  debug: boolean;
  revision: string;
}

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_HIDE_MODE: HideMode = 'blur';
const DEFAULT_ENABLED = true;

// Abbreviations spelled out before assessment. Keep this table to entries
// proven to help: broader expansions also catch posts that merely mention
// the term, so add rows only when the recall gain is worth it.
const GUIDANCE_EXPANSIONS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bAI\b/gi, replacement: 'Artificial intelligence' },
  { pattern: /\bLLMs\b/gi, replacement: 'Large language models' },
  { pattern: /\bLLM\b/gi, replacement: 'Large language model' },
];
function expandGuidance(guidance: string): string {
  return GUIDANCE_EXPANSIONS.reduce((next, { pattern, replacement }) => next.replace(pattern, replacement), guidance);
}
const MAX_CONCURRENT = 8;
const CACHE_LIMIT = 300;
const MAX_DECISIONS = 50;
const MAX_TEXT_LENGTH = 20000;
const MAX_KEY_LENGTH = 10000;
const STORAGE_ERROR =
  'Could not save settings to extension-local storage. Changes were not applied; retry from extension controls.';

const successCache = new Map<string, number>();
interface PendingEntry {
  promise: Promise<Outcome>;
  controller: AbortController;
}
const pending = new Map<string, PendingEntry>();

interface DebugSession {
  id: string;
  latencies: number[];
  decisions: DecisionLogEntry[];
  cacheHits: number;
  failures: number;
  timeouts: number;
}
let debugSession: DebugSession | null = null;

function resetDebug(): DebugSession {
  return debugSession = { id: crypto.randomUUID(), latencies: [], decisions: [], cacheHits: 0, failures: 0, timeouts: 0 };
}

// Debug-only ring buffer: full evidence plus the guidance that scored it, so the
// reader can judge free-phrase guidance after the fact. Local memory only,
// cleared on reset/restart, recorded only while debug is on.
function logDecision(session: DebugSession | null, entry: DecisionLogEntry): void {
  if (!session || session !== debugSession) return;
  session.decisions.push(entry);
  while (session.decisions.length > MAX_DECISIONS) session.decisions.shift();
}

function debugSnapshot(): DebugStats {
  const session = debugSession ?? resetDebug();
  const sorted = [...session.latencies].sort((a, b) => a - b);
  return {
    session: session.id,
    samples: sorted.length,
    latest: session.latencies.at(-1) ?? null,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    inFlight: pending.size,
    limit: MAX_CONCURRENT,
    cacheHits: session.cacheHits,
    failures: session.failures,
    timeouts: session.timeouts,
    recent: [...session.decisions],
  };
}

let writeChain: Promise<void> = Promise.resolve();
let transientWarning: string | null = null;
let authBlocked = false;
let generation = 0;
let accessLevelReady: Promise<void> | null = null;

function newRevision(): string {
  return crypto.randomUUID();
}

function ensureTrustedStorage(): Promise<void> {
  if (accessLevelReady === null) {
    accessLevelReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
  return accessLevelReady;
}

let storageRestricted = false;
function logStorageRestriction(outcome: string): void {
  try {
    console.warn(`[jev-feed-filter] credential storage restriction: ${outcome}`);
  } catch {
    // Logging must never break assessment handling.
  }
}
void ensureTrustedStorage().then(() => { storageRestricted = true; logStorageRestriction('restricted'); }).catch((error: unknown) => {
  transientWarning = 'Could not restrict credential storage. Filtering is disabled; reload the extension.';
  logStorageRestriction(`failed: ${error instanceof Error ? error.message : String(error)}`);
});

function conservativeDefaults(): Settings {
  return {
    provider: 'typesafe',
    guidance: '',
    threshold: DEFAULT_THRESHOLD,
    hideMode: DEFAULT_HIDE_MODE,
    enabled: DEFAULT_ENABLED,
    debug: false,
    configured: false,
    keyPreview: null,
    keyLength: 0,
    revision: 'unconfigured',
    warning:
      'Complete setup: add an API key for the selected provider and enter Guidance.',
  };
}

function isValidThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidHideMode(value: unknown): value is HideMode {
  return value === 'blur' || value === 'collapse';
}

function isValidMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  switch (record['type']) {
    case 'settings':
    case 'debugStats':
    case 'debugReset':
    case 'changed':
      return true;
    case 'apply': return typeof record['guidance'] === 'string';
    case 'provider': return isProvider(record['provider']);
    case 'key': return isProvider(record['provider']) && typeof record['apiKey'] === 'string';
    case 'threshold': return typeof record['threshold'] === 'number';
    case 'hideMode': return typeof record['hideMode'] === 'string';
    case 'enabled': return typeof record['enabled'] === 'boolean';
    case 'debug': return typeof record['debug'] === 'boolean';
    case 'assess': return typeof record['revision'] === 'string';
    default: return false;
  }
}

function sanitizePersisted(raw: Record<string, unknown>): Persisted | null {
  const provider = raw['provider'];
  const storedKeys = raw['apiKeys'];
  const guidance = raw['guidance'];
  const threshold = raw['threshold'];
  const hideMode = raw['hideMode'];
  const enabled = raw['enabled'];
  const debug = raw['debug'];
  const revision = raw['revision'];
  if (
    !isProvider(provider) ||
    typeof storedKeys !== 'object' || storedKeys === null || Array.isArray(storedKeys) ||
    typeof guidance !== 'string' ||
    typeof threshold !== 'number' ||
    typeof revision !== 'string'
  ) {
    return null;
  }
  if (!isValidThreshold(threshold)) return null;
  if (!isValidHideMode(hideMode)) return null;
  if (typeof enabled !== 'boolean' || typeof debug !== 'boolean') return null;
  if (revision.length === 0 || revision.length > 200) return null;
  if (guidance.length > MAX_TEXT_LENGTH) return null;
  const apiKeys: Persisted['apiKeys'] = {};
  for (const id of Object.keys(PROVIDERS)) {
    if (!isProvider(id)) continue;
    const key = (storedKeys as Record<string, unknown>)[id];
    if (key === undefined) continue;
    if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) return null;
    apiKeys[id] = key;
  }
  return { provider, apiKeys, guidance, threshold, hideMode, enabled, debug, revision };
}

function isControlsSender(sender: chrome.runtime.MessageSender): boolean {
  const url = sender.url ?? '';
  if (url.length === 0) return false;
  let expected = '';
  try {
    expected = chrome.runtime.getURL('controls.html');
  } catch {
    return false;
  }
  return url === expected || url.startsWith(expected + '?') || url.startsWith(expected + '#');
}

function isEligibleFeedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  return isFeedUrl(sender.url ?? sender.tab?.url ?? '');
}

function isExtensionContext(sender: chrome.runtime.MessageSender): boolean {
  let origin = '';
  try {
    origin = chrome.runtime.getURL('');
  } catch {
    origin = '';
  }
  const url = sender.url ?? '';
  if (origin.length > 0 && url.startsWith(origin)) return true;
  if (url.length === 0 && sender.tab === undefined) {
    return sender.id === undefined || sender.id === chrome.runtime.id;
  }
  return false;
}

function canReadCredentials(sender: chrome.runtime.MessageSender): boolean {
  return isExtensionContext(sender) || isEligibleFeedSender(sender);
}

async function loadPersisted(): Promise<Persisted> {
  const fallback: Persisted = {
    provider: 'typesafe',
    apiKeys: {},
    guidance: '',
    threshold: DEFAULT_THRESHOLD,
    hideMode: DEFAULT_HIDE_MODE,
    enabled: DEFAULT_ENABLED,
    debug: false,
    revision: newRevision(),
  };
  try {
    const stored: Record<string, unknown> = await chrome.storage.local.get(Object.keys(fallback));
    return sanitizePersisted(stored) ?? fallback;
  } catch {
    return fallback;
  }
}

function setupWarning(state: Persisted): string | null {
  if (!state.apiKeys[state.provider]) {
    return 'Add your API key to start filtering.';
  }
  if (state.guidance.trim().length === 0) {
    return 'Enter Guidance to start filtering.';
  }
  return null;
}

function toPublicSettings(state: Persisted): Settings {
  const apiKey = state.apiKeys[state.provider] ?? '';
  return {
    provider: state.provider,
    guidance: state.guidance,
    threshold: state.threshold,
    hideMode: state.hideMode,
    enabled: state.enabled,
    debug: state.debug,
    configured: apiKey.length > 0,
    // Only the selected key's preview reaches controls or content scripts.
    keyPreview: apiKey.length > 8 ? apiKey.slice(0, 8) : null,
    keyLength: apiKey.length,
    revision: state.revision,
    warning: transientWarning ?? setupWarning(state),
  };
}

async function broadcast(settings: Settings): Promise<void> {
  const message: Message = { type: 'changed', settings };
  try {
    const tabs = await chrome.tabs.query({ url: [...FEED_MATCHES, `chrome-extension://${chrome.runtime.id}/*`] });
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id === undefined) return Promise.resolve();
        const id = tab.id;
        return (async (): Promise<void> => {
          try {
            await chrome.tabs.sendMessage(id, message);
          } catch {
            // No listener in this tab; ignore.
          }
        })();
      }),
    );
  } catch {
    // Tab broadcast is best-effort.
  }
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No extension-page listener; ignore.
  }
}

async function refreshBroadcast(): Promise<void> {
  await broadcast(toPublicSettings(await loadPersisted()));
}

async function setTransientWarning(next: string): Promise<void> {
  if (transientWarning === next) return;
  transientWarning = next;
  await refreshBroadcast();
}

async function clearTransientWarning(): Promise<void> {
  if (transientWarning === null || authBlocked) return;
  transientWarning = null;
  await refreshBroadcast();
}

function cacheGet(key: string): number | undefined {
  const hit = successCache.get(key);
  if (hit === undefined) return undefined;
  successCache.delete(key);
  successCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, probability: number): void {
  if (successCache.has(key)) successCache.delete(key);
  successCache.set(key, probability);
  while (successCache.size > CACHE_LIMIT) {
    const oldest = successCache.keys().next();
    if (oldest.done) break;
    successCache.delete(oldest.value);
  }
}

function abortPending(): void {
  generation += 1;
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.controller.abort();
}

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function readNoulProbability(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  if (!('answers' in payload)) return null;
  const answers = payload.answers;
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return null;
  if (!('filter' in answers)) return null;
  const filter = answers.filter;
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return null;
  if (!('type' in filter) || !('noul' in filter)) return null;
  if (filter.type !== 'noul' || typeof filter.noul !== 'number') return null;
  const probability = filter.noul;
  if (Number.isFinite(probability) === false || probability < 0 || probability > 1) return null;
  return probability;
}

async function performAssessment(
  key: string,
  evidence: Evidence,
  guidance: string,
  provider: Provider,
  apiKey: string,
  startedGeneration: number,
  debug: DebugSession | null,
  threshold: number,
  revision: string,
): Promise<Outcome> {
  const { name, endpoint, model } = PROVIDERS[provider];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ASSESSMENT_TIMEOUT);
  const task = (async (): Promise<Outcome> => {
    const obsolete = (): boolean =>
      startedGeneration !== generation || pending.get(key)?.promise !== task;
    const started = debug ? performance.now() : 0;
    const record = (success: boolean): void => {
      if (!debug || debug !== debugSession || obsolete()) return;
      if (success) {
        debug.latencies.push(performance.now() - started);
        if (debug.latencies.length > 100) debug.latencies.shift();
      } else {
        debug.failures += 1;
        if (controller.signal.aborted) debug.timeouts += 1;
      }
    };
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          state: {
            guidance,
            post: { text: evidence.text, quotedText: evidence.quotedText, author: evidence.author ?? '' },
          },
          questions: {
            filter: { type: QUESTION.type, instructions: QUESTION.instructions, criteria: QUESTION.criteria },
          },
        }),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      });
    } catch {
      clearTimeout(timeoutId);
      if (obsolete()) return { unavailable: true };
      record(false);
      if (controller.signal.aborted) {
        await setTransientWarning(
          `${name} request timed out after 12 seconds. Posts stay visible; check the provider and try again.`,
        );
      } else {
        await setTransientWarning(
          `Could not reach ${name} (network error). Posts stay visible; retry shortly.`,
        );
      }
      return { unavailable: true };
    }
    // Headers arrived; the body read below stays under the same timeout.
    let payload: unknown = null;
    if (response.ok) {
      try {
        payload = await response.json();
      } catch {
        clearTimeout(timeoutId);
        if (obsolete()) return { unavailable: true };
        record(false);
        if (controller.signal.aborted) {
          await setTransientWarning(
            `${name} request timed out after 12 seconds. Posts stay visible; check the provider and try again.`,
          );
        } else {
          await setTransientWarning(
            `${name} returned an unreadable response. Posts stay visible.`,
          );
        }
        return { unavailable: true };
      }
    }
    clearTimeout(timeoutId);
    if (obsolete()) return { unavailable: true };
    if (response.ok === false) {
      record(false);
      if (response.status === 401 || response.status === 403) {
        await setTransientWarning(
          `${name} rejected the API key. Check the key in extension controls and save it again.`,
        );
      } else if (response.status === 402) {
        await setTransientWarning(
          `${name} has insufficient credits. Add credits there or switch providers in extension controls.`,
        );
      } else if (response.status === 429) {
        await setTransientWarning(
          `${name} rate limit reached. Posts stay visible; wait before scrolling for more assessments.`,
        );
      } else {
        await setTransientWarning(
          `${name} request failed (status ${response.status}). Posts stay visible; retry shortly.`,
        );
      }
      return { unavailable: true };
    }
    const probability = readNoulProbability(payload);
    if (probability === null) {
      record(false);
      await setTransientWarning(
        `${name} returned an invalid response. Posts stay visible.`,
      );
      return { unavailable: true };
    }
    record(true);
    cacheSet(key, probability);
    logDecision(debug, { at: Date.now(), provider, revision, guidance, evidence, probability, threshold, filtered: probability > threshold, cached: false });
    await clearTransientWarning();
    return { probability };
  })();
  pending.set(key, { promise: task, controller });
  try {
    return await task;
  } finally {
    const current = pending.get(key);
    if (current !== undefined && current.promise === task) pending.delete(key);
  }
}

async function reportStorageFailure(): Promise<Settings> {
  transientWarning = STORAGE_ERROR;
  const current = toPublicSettings(await loadPersisted());
  await broadcast(current);
  return current;
}

async function readPublicSettings(): Promise<Settings> {
  return toPublicSettings(await loadPersisted());
}

async function requireControlWrite(sender: chrome.runtime.MessageSender): Promise<Settings | null> {
  if (canReadCredentials(sender) === false) return conservativeDefaults();
  if (isControlsSender(sender) === false) return readPublicSettings();
  return null;
}

function applyRevisionUpdate(message: Extract<Message, { type: 'apply' | 'key' | 'provider' }>): Promise<Settings> {
  return serialize(async (): Promise<Settings> => {
    const state = await loadPersisted();
    if (message.type === 'provider' && state.provider === message.provider) return toPublicSettings(state);
    // Start a new revision without discarding provider-scoped cached assessments.
    const next: Persisted = { ...state, revision: newRevision() };
    if (message.type === 'apply') next.guidance = message.guidance;
    else if (message.type === 'provider') next.provider = message.provider;
    else next.apiKeys = { ...state.apiKeys, [message.provider]: message.apiKey.trim() };
    try {
      await chrome.storage.local.set({ ...next });
    } catch {
      return reportStorageFailure();
    }
    abortPending();
    authBlocked = false;
    transientWarning = null;
    const settings = toPublicSettings(next);
    await broadcast(settings);
    return settings;
  });
}

function applyPolicyUpdate<K extends 'threshold' | 'hideMode' | 'enabled'>(field: K, value: Persisted[K]): Promise<Settings> {
  return serialize(async (): Promise<Settings> => {
    const state = await loadPersisted();
    if (state[field] === value) return toPublicSettings(state);
    try {
      await chrome.storage.local.set({ [field]: value });
    } catch {
      return reportStorageFailure();
    }
    // Presentation policy: existing assessments stay valid, pending work
    // continues, and the revision is unchanged.
    if (field === 'enabled' && (value as unknown as boolean) === false) abortPending();
    const settings = toPublicSettings({ ...state, [field]: value } as Persisted);
    await broadcast(settings);
    return settings;
  });
}

async function handleMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Settings | Outcome | DebugStats> {
  await ensureTrustedStorage();
  if (isValidMessage(raw) === false) {
    return { unavailable: true };
  }
  const message = raw;
  if (message.type === 'settings') {
    if (canReadCredentials(sender) === false) return conservativeDefaults();
    return readPublicSettings();
  }
  if (message.type === 'debug') {
    if (!isControlsSender(sender)) return { unavailable: true };
    return serialize(async () => {
      const state = await loadPersisted();
      if (state.debug === message.debug) return toPublicSettings(state);
      const next = { ...state, debug: message.debug };
      try {
        await chrome.storage.local.set(next);
      } catch {
        return reportStorageFailure();
      }
      if (message.debug) resetDebug();
      else debugSession = null;
      const settings = toPublicSettings(next);
      await broadcast(settings);
      return settings;
    });
  }
  if (message.type === 'debugStats' || message.type === 'debugReset') {
    if (!isControlsSender(sender) && !isEligibleFeedSender(sender)) return { unavailable: true };
    return serialize(async () => {
      if (!(await loadPersisted()).debug) return { unavailable: true };
      if (message.type === 'debugReset') resetDebug();
      return debugSnapshot();
    });
  }
  if (message.type === 'apply') {
    const denied = await requireControlWrite(sender);
    if (denied !== null) return denied;
    if (message.guidance.length > MAX_TEXT_LENGTH) return readPublicSettings();
    return applyRevisionUpdate(message);
  }
  if (message.type === 'key') {
    const denied = await requireControlWrite(sender);
    if (denied !== null) return denied;
    if (message.apiKey.length > MAX_KEY_LENGTH) return readPublicSettings();
    return applyRevisionUpdate(message);
  }
  if (message.type === 'provider') {
    const denied = await requireControlWrite(sender);
    if (denied !== null) return denied;
    return applyRevisionUpdate(message);
  }
  if (message.type === 'threshold') {
    const denied = await requireControlWrite(sender);
    if (denied !== null) return denied;
    if (isValidThreshold(message.threshold) === false) return readPublicSettings();
    return applyPolicyUpdate('threshold', message.threshold);
  }
  if (message.type === 'hideMode') {
    const denied = await requireControlWrite(sender);
    if (denied !== null) return denied;
    if (isValidHideMode(message.hideMode) === false) return readPublicSettings();
    return applyPolicyUpdate('hideMode', message.hideMode);
  }
  if (message.type === 'enabled') {
    const denied = await requireControlWrite(sender);
    if (denied !== null) return denied;
    return applyPolicyUpdate('enabled', message.enabled);
  }
  if (message.type === 'changed') {
    if (canReadCredentials(sender) === false) return conservativeDefaults();
    return readPublicSettings();
  }
  if (storageRestricted === false) return { unavailable: true };
  if (isEligibleFeedSender(sender) === false) return { unavailable: true };
  const evidence = message.evidence;
  const hasText =
    evidence.text.trim().length > 0 ||
    evidence.quotedText.some((part) => part.trim().length > 0);
  if (hasText === false) return { unavailable: true };
  const startedGeneration = generation;
  const state = await loadPersisted();
  if (startedGeneration !== generation || message.revision !== state.revision) return { unavailable: true };
  if (state.enabled === false) return { unavailable: true };
  const apiKey = state.apiKeys[state.provider] ?? '';
  const guidance = expandGuidance(state.guidance);
  if (apiKey.length === 0 || guidance.trim().length === 0) {
    return { unavailable: true };
  }
  if (authBlocked) return { unavailable: true };
  const requestKey = JSON.stringify({
    provider: state.provider,
    model: PROVIDERS[state.provider].model,
    question: QUESTION,
    guidance,
    quotedText: evidence.quotedText.map(part => part.trim()),
    text: evidence.text.trim(),
    author: (evidence.author ?? '').trim(),
  });
  const cached = cacheGet(requestKey);
  const debug = state.debug ? debugSession ?? resetDebug() : null;
  if (cached !== undefined) {
    if (debug) debug.cacheHits += 1;
    logDecision(debug, { at: Date.now(), provider: state.provider, revision: state.revision, guidance, evidence, probability: cached, threshold: state.threshold, filtered: cached > state.threshold, cached: true });
    return { probability: cached };
  }
  const inflight = pending.get(requestKey);
  if (inflight !== undefined) return inflight.promise;
  if (pending.size >= MAX_CONCURRENT) {
    // Backpressure only: leave the bounded session cache intact and do not warn.
    return { busy: true };
  }
  return performAssessment(requestKey, evidence, guidance, state.provider, apiKey, startedGeneration, debug, state.threshold, state.revision);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void (async () => {
    try {
      sendResponse(await handleMessage(message, sender));
    } catch {
      try {
        sendResponse({ unavailable: true });
      } catch {
        // The listener must never throw.
      }
    }
  })();
  return true;
});
