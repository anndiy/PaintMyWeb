const siteName = document.getElementById('site-name');
const sitePath = document.getElementById('site-path');
const remember = document.getElementById('remember');
const permissionNote = document.getElementById('permission-note');
const errorNote = document.getElementById('error-note');
const startButton = document.getElementById('start');

let activeTab = null;
let activeUrl = null;
let currentOriginPattern = null;
let canInject = false;
let sitePermissionGranted = false;
let pendingOpenToken = null;
let pendingOpenReady = false;

function setError(message) {
  errorNote.textContent = message;
  errorNote.hidden = !message;
}

function patternForUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return `${url.protocol}//${url.hostname}/*`;
}

function makePendingToken() {
  return `pmw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function preparePendingOpen() {
  if (!activeTab?.id || !activeUrl || sitePermissionGranted) {
    pendingOpenReady = false;
    return { ok: true };
  }
  if (!pendingOpenToken) pendingOpenToken = makePendingToken();
  const result = await chrome.runtime.sendMessage({
    type: 'PMW_PREPARE_OPEN',
    tabId: activeTab.id,
    url: activeUrl,
    token: pendingOpenToken
  });
  pendingOpenReady = Boolean(result?.ok);
  if (!pendingOpenReady) setError(result?.error || 'Could not prepare the permission handoff.');
  return result;
}

async function cancelPendingOpen() {
  if (!pendingOpenToken) {
    pendingOpenReady = false;
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: 'PMW_CANCEL_PENDING_OPEN', token: pendingOpenToken });
  } catch (_) {}
  pendingOpenReady = false;
  pendingOpenToken = null;
}

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = tab || null;
    activeUrl = tab?.url || null;
    if (!activeUrl) {
      siteName.textContent = 'No active webpage';
      sitePath.textContent = 'Open a webpage.';
      permissionNote.textContent = 'Unavailable on browser pages.';
      setError('Open a regular website to use PaintMyWeb.');
      return;
    }

    const url = new URL(activeUrl);
    currentOriginPattern = patternForUrl(activeUrl);
    if (!currentOriginPattern) {
      siteName.textContent = url.protocol === 'file:' ? 'Local file' : url.hostname || url.protocol;
      sitePath.textContent = activeUrl;
      permissionNote.textContent = 'This page is restricted.';
      setError('PaintMyWeb works on regular HTTP and HTTPS websites, not browser-internal pages or the Chrome Web Store.');
      return;
    }

    siteName.textContent = url.hostname;
    sitePath.textContent = `${url.pathname}${url.search}` || '/';
    canInject = true;

    const status = await chrome.runtime.sendMessage({ type: 'PMW_GET_STATUS', url: activeUrl });
    sitePermissionGranted = Boolean(status?.ok && status.granted);
    const previousOpenError = await chrome.runtime.sendMessage({ type: 'PMW_GET_LAST_OPEN_ERROR', tabId: activeTab.id });
    if (previousOpenError?.error) setError(previousOpenError.error);
    remember.checked = true;
    if (sitePermissionGranted) {
      permissionNote.textContent = status.savedCount
        ? `${status.savedCount} saved paint${status.savedCount === 1 ? '' : 's'}`
        : 'Saving enabled';
    } else {
      permissionNote.textContent = 'Site access is needed to save.';
      const prepared = await preparePendingOpen();
      if (!prepared?.ok) {
        startButton.disabled = true;
        return;
      }
    }
    startButton.disabled = false;
  } catch (error) {
    siteName.textContent = 'Cannot read this tab';
    setError(error?.message || 'Initialization failed.');
  }
}

remember.addEventListener('change', async () => {
  if (!currentOriginPattern) return;
  if (remember.checked && !sitePermissionGranted) {
    startButton.disabled = true;
    permissionNote.textContent = 'Preparing site access…';
    try {
      const prepared = await preparePendingOpen();
      permissionNote.textContent = prepared?.ok ? 'Site access is needed to save.' : 'Could not prepare site access.';
    } catch (error) {
      setError(error?.message || 'Could not prepare site access.');
    } finally {
      startButton.disabled = !canInject || !pendingOpenReady;
    }
  } else {
    await cancelPendingOpen();
    permissionNote.textContent = remember.checked ? 'Saving enabled' : 'Session only';
    startButton.disabled = !canInject;
  }
});

startButton.addEventListener('click', async () => {
  if (!activeTab?.id || !activeUrl || !canInject) return;
  startButton.disabled = true;
  startButton.querySelector('span').textContent = 'Opening…';
  setError('');

  let persistent = false;
  try {
    // Important: request permissions directly in the click gesture. Chrome may close
    // this popup after permission is granted, so the service worker has a prepared
    // pending launch and opens the palette from chrome.permissions.onAdded.
    if (remember.checked && !sitePermissionGranted) {
      if (!pendingOpenReady || !pendingOpenToken) {
        throw new Error('Site access is not ready. Reopen PaintMyWeb and try again.');
      }
      let requestPromise;
      try {
        requestPromise = chrome.permissions.request({ origins: [currentOriginPattern] });
      } catch (_) {
        requestPromise = Promise.resolve(false);
      }
      persistent = await requestPromise;
      if (persistent) {
        // This is a second path to the same pending launch. The background safely
        // de-duplicates it against the permissions.onAdded event in case the popup
        // stays alive or Chrome delivered the event just before this message.
        const completed = await chrome.runtime.sendMessage({
          type: 'PMW_COMPLETE_PENDING_OPEN',
          token: pendingOpenToken
        });
        if (!completed?.ok) {
          throw new Error(completed?.error || 'Permission was granted, but PaintMyWeb could not open the palette. Try again.');
        }
        window.close();
        return;
      }
      await cancelPendingOpen();
      permissionNote.textContent = 'Session only';
    } else if (remember.checked && sitePermissionGranted) {
      persistent = true;
      const registered = await chrome.runtime.sendMessage({ type: 'PMW_REGISTER_SITE', url: activeUrl });
      if (!registered?.ok) {
        persistent = false;
        permissionNote.textContent = 'Saving unavailable. Session only.';
      }
    }

    await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] });
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: 'PMW_OPEN',
      persistent,
      sourceUrl: activeUrl
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'PaintMyWeb could not connect to this page. Reload the page and try again.');
    }
    window.close();
  } catch (error) {
    setError(error?.message || 'Could not open this page.');
    startButton.disabled = false;
    startButton.querySelector('span').textContent = 'Try again';
  }
});

initialize();
