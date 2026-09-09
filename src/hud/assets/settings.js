/**
 * Baton control-panel preferences.
 *
 * Browser-safe preferences live in localStorage. Native-only preferences are
 * delegated to the macOS host and stored in UserDefaults there.
 */
(function () {
  const KEY = 'baton.preferences.v1';
  const defaults = {
    theme: 'system',
    motion: 'system',
    startupView: 'last',
    restoreProject: true,
    confirmStopAll: true,
  };
  const allowed = {
    theme: ['system', 'light', 'dark'],
    motion: ['system', 'reduce', 'full'],
    startupView: ['last', 'chip', 'inspector'],
  };
  let preferences = load();
  let nativePreferences = { available: false, alwaysOnTop: false, launchAtLogin: false };

  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
      const next = { ...defaults, ...stored };
      for (const [name, values] of Object.entries(allowed)) {
        if (!values.includes(next[name])) next[name] = defaults[name];
      }
      next.restoreProject = next.restoreProject !== false;
      next.confirmStopAll = next.confirmStopAll !== false;
      return next;
    } catch {
      return { ...defaults };
    }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* private mode */ }
  }

  function apply() {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.dataset.motion = preferences.motion;
  }

  function nativeHandler() {
    return window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.batonHud;
  }

  function post(message) {
    const handler = nativeHandler();
    if (handler) handler.postMessage(message);
  }

  function setStatus(message, bad) {
    const node = document.getElementById('nativePreferenceStatus');
    if (!node) return;
    node.textContent = message || '';
    node.className = bad ? 'bad' : '';
  }

  function syncForm() {
    const value = (id, next) => {
      const node = document.getElementById(id);
      if (node) node.value = next;
    };
    const checked = (id, next) => {
      const node = document.getElementById(id);
      if (node) node.checked = Boolean(next);
    };
    value('themePreference', preferences.theme);
    value('motionPreference', preferences.motion);
    value('startupViewPreference', preferences.startupView);
    checked('restoreProjectPreference', preferences.restoreProject);
    checked('confirmStopAllPreference', preferences.confirmStopAll);
    checked('alwaysOnTopPreference', nativePreferences.alwaysOnTop);
    checked('launchAtLoginPreference', nativePreferences.launchAtLogin);
    for (const id of ['alwaysOnTopPreference', 'launchAtLoginPreference']) {
      const node = document.getElementById(id);
      if (node) node.disabled = !nativePreferences.available;
    }
  }

  function open() {
    const panel = document.getElementById('settingsPanel');
    if (!panel) return;
    syncForm();
    panel.hidden = false;
    document.getElementById('themePreference')?.focus();
    post({ type: 'getPreferences' });
  }

  function close() {
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.hidden = true;
    document.getElementById('settingsBtn')?.focus();
  }

  function bindSelect(id, key) {
    document.getElementById(id)?.addEventListener('change', (event) => {
      preferences[key] = event.target.value;
      save();
      apply();
    });
  }

  function bindCheck(id, key) {
    document.getElementById(id)?.addEventListener('change', (event) => {
      preferences[key] = event.target.checked;
      save();
    });
  }

  function applyNative(next) {
    nativePreferences = { ...nativePreferences, ...next, available: true };
    syncForm();
    if (next.error) setStatus(next.error, true);
    else if (next.message) setStatus(next.message, false);
  }

  apply();
  fillIcon(document.getElementById('settingsBtn'), 'settings');
  fillIcon(document.getElementById('settingsClose'), 'close');
  document.getElementById('settingsBtn')?.addEventListener('click', open);
  document.getElementById('settingsClose')?.addEventListener('click', close);
  document.getElementById('settingsDone')?.addEventListener('click', close);
  document.getElementById('settingsPanel')?.addEventListener('click', (event) => {
    if (event.target.id === 'settingsPanel') close();
  });
  bindSelect('themePreference', 'theme');
  bindSelect('motionPreference', 'motion');
  bindSelect('startupViewPreference', 'startupView');
  bindCheck('restoreProjectPreference', 'restoreProject');
  bindCheck('confirmStopAllPreference', 'confirmStopAll');

  document.getElementById('alwaysOnTopPreference')?.addEventListener('change', (event) => {
    post({ type: 'setPreference', key: 'alwaysOnTop', value: event.target.checked });
  });
  document.getElementById('launchAtLoginPreference')?.addEventListener('change', (event) => {
    post({ type: 'setPreference', key: 'launchAtLogin', value: event.target.checked });
  });
  document.getElementById('resetPreferences')?.addEventListener('click', () => {
    preferences = { ...defaults };
    save();
    try {
      for (const key of ['baton.density', 'baton.hud.splits', 'baton.lastProject']) {
        localStorage.removeItem(key);
      }
    } catch { /* private mode */ }
    post({ type: 'setPreference', key: 'alwaysOnTop', value: false });
    post({ type: 'setPreference', key: 'launchAtLogin', value: false });
    apply();
    syncForm();
    setStatus('Defaults restored.', false);
  });
  addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault();
      open();
    } else if (event.key === 'Escape' && !document.getElementById('settingsPanel')?.hidden) {
      close();
    }
  });

  window.BatonSettings = {
    get: () => ({ ...preferences }),
    open,
    close,
    applyNative,
    confirmStopAll: () => preferences.confirmStopAll,
  };
  post({ type: 'getPreferences' });
})();
