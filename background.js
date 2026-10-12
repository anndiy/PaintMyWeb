const RULES_KEY = 'paintmyweb.rules.v1';
const SCRIPT_PREFIX = 'paintmyweb-restore-';
const PENDING_OPEN_KEY = 'paintmyweb.pending-open.v1';
const LAST_OPEN_ERROR_KEY = 'paintmyweb.last-open-error.v1';
const PENDING_OPEN_TTL_MS = 2 * 60 * 1000;
const pendingOpenInFlight = new Set();

// Multiple clicks can save paints in quick succession. Serialize all storage mutations
// to prevent overlapping read-modify-write operations from dropping a saved rule.
let storageMutationQueue = Promise.resolve();
function queueStorageMutation(task) {
  const result = storageMutationQueue.then(task, task);
  storageMutationQueue = result.catch(() => undefined);
  return result;
}

function pageKeyFromUrl(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname}${url.search}`;
}

function patternFromUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PaintMyWeb only works on regular HTTP and HTTPS websites.');
  }
  // Chrome match patterns do not include ports. The stored page key still does.
  return `${url.protocol}//${url.hostname}/*`;
}

function registrationIdForPattern(pattern) {
  // Keep IDs short even for long internationalized hostnames.
  let hashA = 0x811c9dc5;
  let hashB = 0x45d9f3b;
  for (let index = 0; index < pattern.length; index++) {
    const code = pattern.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 0x01000193);
    hashB = Math.imul(hashB ^ code, 0x5bd1e995);
  }
  const host = pattern.split('://')[1]?.split('/')[0] || 'site';
  const safeHost = host.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 34);
  return `${SCRIPT_PREFIX}${safeHost}-${(hashA >>> 0).toString(16)}${(hashB >>> 0).toString(16)}`;
}

async function hasHostPermission(pattern) {
  return chrome.permissions.contains({ origins: [pattern] });
}

async function registerPersistentRestorer(rawUrl) {
  const pattern = patternFromUrl(rawUrl);
  if (!(await hasHostPermission(pattern))) {
    throw new Error('PaintMyWeb does not have permission to restore colors on this site.');
  }

  const id = registrationIdForPattern(pattern);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  const definition = {
    id,
    matches: [pattern],
    js: ['content.js'],
    runAt: 'document_idle',
    persistAcrossSessions: true
  };

  if (existing.length) {
    await chrome.scripting.updateContentScripts([definition]);
  } else {
    await chrome.scripting.registerContentScripts([definition]);
  }
  return { pattern, id };
}

async function readRules() {
  const result = await chrome.storage.local.get(RULES_KEY);
  return Array.isArray(result[RULES_KEY]) ? result[RULES_KEY] : [];
}

async function writeRules(rules) {
  await chrome.storage.local.set({ [RULES_KEY]: rules });
}



async function preparePendingOpen(tabId, rawUrl, token) {
  if (!Number.isInteger(tabId) || typeof rawUrl !== 'string' || typeof token !== 'string' || !token) {
    throw new Error('Missing tab, URL, or launch token.');
  }
  const pattern = patternFromUrl(rawUrl);
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || patternFromUrl(tab.url) !== pattern) {
    throw new Error('The active page changed. Reopen PaintMyWeb and try again.');
  }
  const pending = { tabId, url: rawUrl, pattern, token, createdAt: Date.now() };
  await chrome.storage.session.set({ [PENDING_OPEN_KEY]: pending });
  return { ok: true, token };
}

async function cancelPendingOpen(token) {
  const result = await chrome.storage.session.get(PENDING_OPEN_KEY);
  const pending = result[PENDING_OPEN_KEY];
  if (pending && (!token || pending.token === token)) {
    await chrome.storage.session.remove(PENDING_OPEN_KEY);
  }
  return { ok: true };
}

async function launchPaletteInTab(pending) {
  const tab = await chrome.tabs.get(pending.tabId);
  if (!tab?.url) throw new Error('The original tab is no longer available.');
  const currentPattern = patternFromUrl(tab.url);
  if (currentPattern !== pending.pattern) {
    throw new Error('The tab has navigated to a different site. Reopen PaintMyWeb on the current page.');
  }

  const currentUrl = tab.url;
  let persistent = true;
  try {
    await registerPersistentRestorer(currentUrl);
  } catch (error) {
    // Painting can still start in the current tab if persistent registration fails.
    persistent = false;
  }

  await chrome.scripting.executeScript({ target: { tabId: pending.tabId }, files: ['content.js'] });
  const response = await chrome.tabs.sendMessage(pending.tabId, {
    type: 'PMW_OPEN',
    persistent,
    sourceUrl: currentUrl
  });
  if (!response?.ok) {
    throw new Error(response?.error || 'The palette could not connect to this page. Try reopening PaintMyWeb.');
  }

  await chrome.action.setBadgeText({ tabId: pending.tabId, text: '' }).catch(() => {});
  await chrome.storage.session.remove(LAST_OPEN_ERROR_KEY);
  return { ok: true, persistent };
}

async function completePendingOpen(token, requiredPattern = null) {
  // This function can be triggered by both permissions.onAdded and the still-open
  // popup. Claim the token synchronously to avoid opening the palette twice.
  if (pendingOpenInFlight.has(token)) return { ok: true, alreadyOpening: true };
  pendingOpenInFlight.add(token);
  try {
    const result = await chrome.storage.session.get(PENDING_OPEN_KEY);
    const pending = result[PENDING_OPEN_KEY];
    if (!pending || pending.token !== token) return { ok: true, alreadyHandled: true };

    if (Date.now() - pending.createdAt > PENDING_OPEN_TTL_MS) {
      await chrome.storage.session.remove(PENDING_OPEN_KEY);
      return { ok: false, error: 'The permission request expired. Reopen PaintMyWeb and try again.' };
    }
    if (requiredPattern && pending.pattern !== requiredPattern) return { ok: true, ignored: true };
    if (!(await hasHostPermission(pending.pattern))) {
      return { ok: false, waitingForPermission: true };
    }

    try {
      const launched = await launchPaletteInTab(pending);
      await chrome.storage.session.remove(PENDING_OPEN_KEY);
      return launched;
    } catch (error) {
      const message = error?.message || 'PaintMyWeb could not open the palette after permission was granted.';
      await chrome.storage.session.set({
        [LAST_OPEN_ERROR_KEY]: { tabId: pending.tabId, message, createdAt: Date.now() }
      });
      await chrome.action.setBadgeText({ tabId: pending.tabId, text: '!' }).catch(() => {});
      await chrome.action.setBadgeBackgroundColor({ tabId: pending.tabId, color: '#B84A3A' }).catch(() => {});
      await chrome.storage.session.remove(PENDING_OPEN_KEY);
      return { ok: false, error: message };
    }
  } finally {
    pendingOpenInFlight.delete(token);
  }
}

async function handlePermissionAdded(added) {
  if (!Array.isArray(added?.origins) || !added.origins.length) return;
  const result = await chrome.storage.session.get(PENDING_OPEN_KEY);
  const pending = result[PENDING_OPEN_KEY];
  if (!pending) return;
  if (Date.now() - pending.createdAt > PENDING_OPEN_TTL_MS) {
    await chrome.storage.session.remove(PENDING_OPEN_KEY);
    return;
  }
  if (!added.origins.includes(pending.pattern)) return;
  await completePendingOpen(pending.token, pending.pattern);
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') return { ok: false, error: 'Invalid request.' };

  switch (message.type) {
    case 'PMW_PREPARE_OPEN': {
      return preparePendingOpen(message.tabId, message.url, message.token);
    }

    case 'PMW_CANCEL_PENDING_OPEN': {
      return cancelPendingOpen(message.token);
    }

    case 'PMW_COMPLETE_PENDING_OPEN': {
      if (typeof message.token !== 'string' || !message.token) throw new Error('Missing launch token.');
      return completePendingOpen(message.token);
    }

    case 'PMW_GET_LAST_OPEN_ERROR': {
      const result = await chrome.storage.session.get(LAST_OPEN_ERROR_KEY);
      const error = result[LAST_OPEN_ERROR_KEY];
      if (error && message.tabId === error.tabId && Date.now() - error.createdAt < PENDING_OPEN_TTL_MS) {
        await chrome.storage.session.remove(LAST_OPEN_ERROR_KEY);
        await chrome.action.setBadgeText({ tabId: message.tabId, text: '' }).catch(() => {});
        return { ok: true, error: error.message };
      }
      return { ok: true, error: null };
    }

    case 'PMW_REGISTER_SITE': {
      if (typeof message.url !== 'string') throw new Error('Missing site URL.');
      const result = await registerPersistentRestorer(message.url);
      return { ok: true, ...result };
    }

    case 'PMW_GET_RULES': {
      if (typeof message.pageKey !== 'string') throw new Error('Missing page key.');
      const senderUrl = sender?.tab?.url;
      if (senderUrl) {
        const pattern = patternFromUrl(senderUrl);
        if (!(await hasHostPermission(pattern)) || pageKeyFromUrl(senderUrl) !== message.pageKey) {
          return { ok: true, rules: [] };
        }
      }
      const rules = await readRules();
      return { ok: true, rules: rules.filter(rule => rule.pageKey === message.pageKey) };
    }

    case 'PMW_SAVE_RULE': {
      const rule = message.rule;
      if (!rule || typeof rule.id !== 'string' || typeof rule.pageKey !== 'string') {
        throw new Error('The paint rule is incomplete.');
      }
      if (typeof rule.origin !== 'string' || typeof rule.url !== 'string') {
        throw new Error('The paint rule has no page origin.');
      }
      const senderUrl = sender?.tab?.url;
      if (senderUrl) {
        const senderOrigin = new URL(senderUrl).origin;
        if (senderOrigin !== rule.origin) throw new Error('The rule origin did not match the active page.');
      }
      if (pageKeyFromUrl(rule.url) !== rule.pageKey || new URL(rule.url).origin !== rule.origin) {
        throw new Error('The paint rule URL and page key did not match.');
      }
      const pattern = patternFromUrl(rule.url);
      if (!(await hasHostPermission(pattern))) {
        return { ok: true, persisted: false, reason: 'site-permission-missing' };
      }
      await registerPersistentRestorer(rule.url);
      return queueStorageMutation(async () => {
        const rules = await readRules();
        // Replacing by ID makes a retry idempotent instead of creating duplicates.
        const next = rules.filter(existing => existing.id !== rule.id);
        next.push({ ...rule, createdAt: Number(rule.createdAt) || Date.now() });
        await writeRules(next);
        return { ok: true, persisted: true };
      });
    }

    case 'PMW_DELETE_RULE': {
      if (typeof message.ruleId !== 'string' || typeof message.pageKey !== 'string') {
        throw new Error('Missing rule ID or page key.');
      }
      const senderUrl = sender?.tab?.url;
      if (senderUrl && pageKeyFromUrl(senderUrl) !== message.pageKey) {
        throw new Error('The paint rule belongs to a different page.');
      }
      return queueStorageMutation(async () => {
        const rules = await readRules();
        const remaining = rules.filter(rule => !(rule.id === message.ruleId && rule.pageKey === message.pageKey));
        if (remaining.length !== rules.length) await writeRules(remaining);
        return { ok: true };
      });
    }

    case 'PMW_CLEAR_PAGE': {
      if (typeof message.pageKey !== 'string') throw new Error('Missing page key.');
      const senderUrl = sender?.tab?.url;
      if (senderUrl && pageKeyFromUrl(senderUrl) !== message.pageKey) {
        throw new Error('PaintMyWeb can only clear paints for the current page.');
      }
      return queueStorageMutation(async () => {
        const rules = await readRules();
        const remaining = rules.filter(rule => rule.pageKey !== message.pageKey);
        await writeRules(remaining);
        return { ok: true, removed: rules.length - remaining.length };
      });
    }

    case 'PMW_GET_STATUS': {
      if (typeof message.url !== 'string') throw new Error('Missing URL.');
      const pattern = patternFromUrl(message.url);
      const granted = await hasHostPermission(pattern);
      const registered = granted && (await chrome.scripting.getRegisteredContentScripts({
        ids: [registrationIdForPattern(pattern)]
      })).length > 0;
      const rules = await readRules();
      return {
        ok: true,
        granted,
        registered,
        savedCount: rules.filter(rule => rule.origin === new URL(message.url).origin).length
      };
    }

    default:
      return { ok: false, error: 'Unknown PaintMyWeb request.' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error?.message || 'Unexpected extension error.' }));
  return true;
});

chrome.permissions.onAdded.addListener((added) => {
  handlePermissionAdded(added).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(RULES_KEY).then(result => {
    if (!Array.isArray(result[RULES_KEY])) return chrome.storage.local.set({ [RULES_KEY]: [] });
    return undefined;
  }).catch(() => {});
});
