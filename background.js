const RULES_KEY = 'paintmyweb.rules.v1';
const SCRIPT_PREFIX = 'paintmyweb-restore-';

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

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') return { ok: false, error: 'Invalid request.' };

  switch (message.type) {
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
      const rules = await readRules();
      rules.push({ ...rule, createdAt: Number(rule.createdAt) || Date.now() });
      await writeRules(rules);
      return { ok: true, persisted: true };
    }

    case 'PMW_DELETE_RULE': {
      if (typeof message.ruleId !== 'string' || typeof message.pageKey !== 'string') {
        throw new Error('Missing rule ID or page key.');
      }
      const senderUrl = sender?.tab?.url;
      if (senderUrl && pageKeyFromUrl(senderUrl) !== message.pageKey) {
        throw new Error('The paint rule belongs to a different page.');
      }
      const rules = await readRules();
      const index = rules.findIndex(rule => rule.id === message.ruleId && rule.pageKey === message.pageKey);
      if (index >= 0) {
        rules.splice(index, 1);
        await writeRules(rules);
      }
      return { ok: true };
    }

    case 'PMW_CLEAR_PAGE': {
      if (typeof message.pageKey !== 'string') throw new Error('Missing page key.');
      const senderUrl = sender?.tab?.url;
      if (senderUrl && pageKeyFromUrl(senderUrl) !== message.pageKey) {
        throw new Error('PaintMyWeb can only clear paints for the current page.');
      }
      const rules = await readRules();
      const remaining = rules.filter(rule => rule.pageKey !== message.pageKey);
      await writeRules(remaining);
      return { ok: true, removed: rules.length - remaining.length };
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(RULES_KEY).then(result => {
    if (!Array.isArray(result[RULES_KEY])) return chrome.storage.local.set({ [RULES_KEY]: [] });
    return undefined;
  }).catch(() => {});
});
