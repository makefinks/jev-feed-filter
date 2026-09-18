import { PROVIDERS, isProvider, type HideMode, type Message, type Provider, type Settings } from './contracts';

const apiKeyEl = document.getElementById('apiKey') as HTMLInputElement;
const apiKeyProviderEl = document.getElementById('apiKeyProvider') as HTMLSpanElement;
const providerMenuEl = document.getElementById('providerMenu') as HTMLDetailsElement;
const apiKeyFieldEl = document.getElementById('apiKeyField') as HTMLElement;
const saveKeyEl = document.getElementById('saveKey') as HTMLButtonElement;
const removeKeyEl = document.getElementById('removeKey') as HTMLButtonElement;
const guidanceEl = document.getElementById('guidance') as HTMLTextAreaElement;
const guidanceFieldEl = document.getElementById('guidanceField') as HTMLElement;
const guidanceStatusEl = document.getElementById('guidanceStatus') as HTMLSpanElement;
const thresholdEl = document.getElementById('threshold') as HTMLInputElement;
const thresholdValueEl = document.getElementById('thresholdValue') as HTMLOutputElement;
const hideModeEl = document.getElementById('hideMode') as HTMLSelectElement;
const debugEl = document.getElementById('debug') as HTMLInputElement;
const EMPTY_GUIDANCE_WARNING = 'Enter Guidance to start filtering.';
const GUIDANCE_PLACEHOLDER = 'Describe the posts you want to see or avoid, e.g. show only posts about hiking, or hide posts about politics';
const GUIDANCE_DEBOUNCE_MS = 800;
let guidanceTimer: ReturnType<typeof setTimeout> | null = null;
const statePillEl = document.getElementById('statePill') as HTMLButtonElement;
const stateLabelEl = document.getElementById('stateLabel') as HTMLSpanElement;
const stateReasonEl = document.getElementById('stateReason') as HTMLSpanElement;
const warningEl = document.getElementById('warning') as HTMLDivElement;
const warningTextEl = document.getElementById('warningText') as HTMLSpanElement;
const setupHintEl = document.getElementById('setupHint') as HTMLSpanElement;
const settingsControlEl = document.querySelector('.settings-control') as HTMLElement;
const errorEl = document.getElementById('error') as HTMLParagraphElement;
const mainViewEl = document.getElementById('mainView') as HTMLElement;
const settingsViewEl = document.getElementById('settingsView') as HTMLElement;
const openSettingsEl = document.getElementById('openSettings') as HTMLButtonElement;
const backSettingsEl = document.getElementById('backSettings') as HTMLButtonElement;

function showView(name: 'main' | 'settings'): void {
  const settings = name === 'settings';
  mainViewEl.hidden = settings;
  settingsViewEl.hidden = !settings;
}

let appliedGuidance = '';
let keyConfigured = false;
let filteringEnabled = true;
let toggleInFlight = false;
let debugEnabled = false;
let currentProvider: Provider = 'typesafe';
let providerRequest = 0;

const UNEXPECTED_RESPONSE = 'Unexpected response from the extension background. Reload the extension at chrome://extensions and try again.';

// Version skew or corrupt storage must not reach the DOM, so every response is validated first.
function isSettings(value: unknown): value is Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!('guidance' in value) || !('threshold' in value) || !('configured' in value)) return false;
  if (!('revision' in value) || !('warning' in value)) return false;
  const { guidance, threshold, configured, revision, warning } = value;
  const provider = 'provider' in value ? value.provider : null;
  if (!isProvider(provider)) return false;
  const hideMode = 'hideMode' in value ? value.hideMode : 'blur';
  const enabled = 'enabled' in value ? value.enabled : true;
  const keyPreview = 'keyPreview' in value ? value.keyPreview : null;
  const keyLength = 'keyLength' in value ? value.keyLength : 0;
  if (typeof guidance !== 'string' || typeof configured !== 'boolean') return false;
  if (typeof revision !== 'string') return false;
  if (typeof threshold !== 'number' || Number.isFinite(threshold) === false) return false;
  if (threshold < 0 || threshold > 1) return false;
  if (hideMode !== 'blur' && hideMode !== 'collapse') return false;
  if (typeof enabled !== 'boolean') return false;
  if ('debug' in value && typeof value.debug !== 'boolean') return false;
  if (keyPreview !== null && typeof keyPreview !== 'string') return false;
  if (typeof keyLength !== 'number' || Number.isInteger(keyLength) === false || keyLength < 0) return false;
  return warning === null || typeof warning === 'string';
}

function rpc(message: Message): Promise<Settings> {
  return new Promise<Settings>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message ?? 'Extension message failed.'));
        return;
      }
      if (isSettings(response) === false) {
        reject(new Error(UNEXPECTED_RESPONSE));
        return;
      }
      resolve(response);
    });
  });
}

function showError(message: string | null): void {
  if (message === null) {
    errorEl.hidden = true;
    errorEl.textContent = '';
  } else {
    errorEl.hidden = false;
    errorEl.textContent = message;
  }
}

// Saving with an empty field would clear the stored key, so it mirrors the Remove key button instead.
function syncSaveKey(): void {
  saveKeyEl.disabled = apiKeyEl.value.length === 0;
  apiKeyFieldEl.classList.toggle('needs-key', !keyConfigured && apiKeyEl.value.length === 0);
}

function setupHint(s: Settings): string | null {
  return s.configured ? null : 'Add your API key to start filtering.';
}

function status(s: Settings): { label: string; on: boolean; reason: string } {
  if (!s.configured) return { label: 'Inactive', on: false, reason: 'Filtering inactive: API key missing.' };
  if (s.guidance.trim() === '') return { label: 'Inactive', on: false, reason: 'Filtering inactive: Guidance is empty.' };
  if (!s.enabled) return { label: 'Paused', on: false, reason: 'Filtering paused.' };
  return { label: 'Active', on: true, reason: 'Filtering active.' };
}

function syncGuidancePulse(): void {
  guidanceFieldEl.classList.toggle('needs-key', !guidanceEl.disabled && guidanceEl.value.trim().length === 0);
}
function syncGuidanceStatus(): void {
  const next = !guidanceEl.disabled && guidanceEl.value !== appliedGuidance ? 'Pending...' : '';
  if (guidanceStatusEl.textContent !== next) guidanceStatusEl.textContent = next;
}

function render(s: Settings): void {
  const hadUnsavedDraft = guidanceEl.value !== appliedGuidance;
  appliedGuidance = s.guidance;
  if (!hadUnsavedDraft) guidanceEl.value = s.guidance;
  const pct = Math.round(s.threshold * 100);
  thresholdEl.value = String(pct);
  thresholdValueEl.textContent = `${pct}%`;
  hideModeEl.value = s.hideMode ?? 'blur';
  currentProvider = s.provider;
  apiKeyProviderEl.textContent = PROVIDERS[s.provider].name;
  debugEnabled = s.debug === true;
  debugEl.checked = debugEnabled;
  const preview = typeof s.keyPreview === 'string' && s.keyPreview.length > 0 ? s.keyPreview : null;
  const masked = typeof s.keyLength === 'number' && Number.isInteger(s.keyLength) && preview
    ? '•'.repeat(Math.max(0, s.keyLength - preview.length))
    : '••••••••';
  apiKeyEl.placeholder = s.configured
    ? (preview ? `${preview}${masked}` : '••••••••')
    : 'Enter key to set or replace';
  keyConfigured = s.configured;
  const filteringDisabled = !s.configured;
  guidanceEl.disabled = filteringDisabled;
  syncGuidancePulse();
  thresholdEl.disabled = filteringDisabled;
  hideModeEl.disabled = filteringDisabled;
  statePillEl.disabled = filteringDisabled || s.guidance.trim() === '' || toggleInFlight;
  filteringEnabled = s.enabled;
  statePillEl.setAttribute('aria-pressed', String(s.enabled));
  statePillEl.setAttribute('aria-label', s.enabled ? 'Disable filtering' : 'Enable filtering');
  apiKeyFieldEl.classList.toggle('needs-key', filteringDisabled && apiKeyEl.value.length === 0);
  removeKeyEl.disabled = !s.configured;
  const st = status(s);
  stateLabelEl.textContent = st.label;
  statePillEl.title = st.reason;
  statePillEl.classList.toggle('on', st.on);
  stateReasonEl.textContent = st.reason;
  const hint = setupHint(s);
  settingsControlEl.classList.toggle('setup-required', hint !== null);
  setupHintEl.hidden = hint === null;
  setupHintEl.textContent = hint ?? '';
  if (hint === null) {
    openSettingsEl.removeAttribute('aria-describedby');
  } else {
    openSettingsEl.setAttribute('aria-describedby', 'setupHint');
  }
  guidanceEl.placeholder = GUIDANCE_PLACEHOLDER;
  syncGuidanceStatus();
  if (s.warning === null || s.warning === hint || s.warning === EMPTY_GUIDANCE_WARNING) {
    warningEl.hidden = true;
    warningTextEl.textContent = '';
  } else {
    warningEl.hidden = false;
    warningTextEl.textContent = s.warning;
  }
}

async function refresh(): Promise<void> {
  try {
    render(await rpc({ type: 'settings' }));
    showError(null);
  } catch (e) {
    showError(e instanceof Error ? e.message : 'Could not load settings.');
  }
}

function saveGuidance(value: string): void {
  rpc({ type: 'apply', guidance: value }).then((s) => {
    render(s);
    showError(null);
  }).catch((e: unknown) => {
    showError(e instanceof Error ? e.message : 'Saving guidance failed.');
  });
}
guidanceEl.addEventListener('input', () => {
  if (guidanceTimer !== null) clearTimeout(guidanceTimer);
  syncGuidanceStatus();
  syncGuidancePulse();
  const value = guidanceEl.value;
  guidanceTimer = setTimeout(() => {
    guidanceTimer = null;
    if (value !== appliedGuidance) saveGuidance(value);
  }, GUIDANCE_DEBOUNCE_MS);
});
guidanceEl.addEventListener('blur', () => {
  if (guidanceTimer !== null) {
    clearTimeout(guidanceTimer);
    guidanceTimer = null;
  }
  if (guidanceEl.value !== appliedGuidance) saveGuidance(guidanceEl.value);
});

saveKeyEl.addEventListener('click', () => {
  rpc({ type: 'key', provider: currentProvider, apiKey: apiKeyEl.value }).then((s) => {
    apiKeyEl.value = '';
    syncSaveKey();
    render(s);
    showError(null);
  }).catch((e: unknown) => {
    showError(e instanceof Error ? e.message : 'Saving the key failed.');
  });
});

removeKeyEl.addEventListener('click', () => {
  rpc({ type: 'key', provider: currentProvider, apiKey: '' }).then((s) => {
    apiKeyEl.value = '';
    syncSaveKey();
    render(s);
    showError(null);
  }).catch((e: unknown) => {
    showError(e instanceof Error ? e.message : 'Removing the key failed.');
  });
});

thresholdEl.addEventListener('input', () => {
  const pct = Number(thresholdEl.value);
  thresholdValueEl.textContent = `${pct}%`;
  rpc({ type: 'threshold', threshold: pct / 100 }).then((s) => {
    render(s);
    showError(null);
  }).catch((e: unknown) => {
    showError(e instanceof Error ? e.message : 'Threshold update failed.');
  });
});

hideModeEl.addEventListener('change', () => {
  const hideMode = hideModeEl.value as HideMode;
  if (hideMode !== 'blur' && hideMode !== 'collapse') return;
  rpc({ type: 'hideMode', hideMode }).then((s) => {
    render(s);
    showError(null);
  }).catch((e: unknown) => {
    showError(e instanceof Error ? e.message : 'Hide mode update failed.');
  });
});
debugEl.addEventListener('change', () => {
  debugEl.disabled = true;
  rpc({ type: 'debug', debug: debugEl.checked }).then(s => {
    render(s);
    showError(null);
  }).catch((e: unknown) => {
    debugEl.checked = debugEnabled;
    showError(e instanceof Error ? e.message : 'Debug panel toggle failed.');
  }).finally(() => { debugEl.disabled = false; });
});
statePillEl.addEventListener('click', () => {
  if (statePillEl.disabled || toggleInFlight) return;
  const next = !filteringEnabled;
  toggleInFlight = true;
  statePillEl.disabled = true;
  statePillEl.classList.toggle('on', next);
  stateLabelEl.textContent = next ? 'Active' : 'Paused';
  statePillEl.setAttribute('aria-pressed', String(next));
  rpc({ type: 'enabled', enabled: next }).then((s) => {
    render(s);
    showError(null);
  }).catch((e: unknown) => {
    statePillEl.classList.toggle('on', filteringEnabled);
    stateLabelEl.textContent = filteringEnabled ? 'Active' : 'Paused';
    statePillEl.setAttribute('aria-pressed', String(filteringEnabled));
    showError(e instanceof Error ? e.message : 'Filtering toggle failed.');
  }).finally(() => {
    toggleInFlight = false;
    statePillEl.disabled = !keyConfigured || guidanceEl.value.trim() === '';
  });
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  if (!('type' in message) || message.type !== 'changed') return;
  if (!('settings' in message) || isSettings(message.settings) === false) return;
  render(message.settings);
});

apiKeyEl.addEventListener('input', syncSaveKey);

// A menu pick is the whole switch: the unsaved key field belongs to the old provider.
providerMenuEl.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>('button[data-provider]') : null;
  const provider = button?.dataset['provider'];
  if (!isProvider(provider)) return;
  providerMenuEl.open = false;
  const seq = ++providerRequest;
  apiKeyEl.value = '';
  syncSaveKey();
  rpc({ type: 'provider', provider }).then((s) => {
    if (seq === providerRequest) {
      render(s);
      showError(null);
    }
  }).catch((e: unknown) => {
    if (seq !== providerRequest) return;
    showError(e instanceof Error ? e.message : 'Provider switch failed.');
  });
});

document.addEventListener('click', (event) => {
  if (providerMenuEl.open && event.target instanceof Node && !providerMenuEl.contains(event.target)) providerMenuEl.open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') providerMenuEl.open = false;
});

openSettingsEl.addEventListener('click', () => {
  showView('settings');
});
backSettingsEl.addEventListener('click', () => {
  showView('main');
});

syncSaveKey();
void refresh();
