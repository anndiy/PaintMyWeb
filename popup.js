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

function setError(message) {
  errorNote.textContent = message;
  errorNote.hidden = !message;
}

function patternForUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return `${url.protocol}//${url.hostname}/*`;
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
    if (status?.ok && status.granted) {
      remember.checked = true;
      permissionNote.textContent = status.savedCount
        ? `${status.savedCount} saved paint${status.savedCount === 1 ? '' : 's'}`
        : 'Saving enabled';
    } else {
      remember.checked = true;
      permissionNote.textContent = 'Site access is needed to save.';
    }
    startButton.disabled = false;
  } catch (error) {
    siteName.textContent = 'Cannot read this tab';
    setError(error?.message || 'Initialization failed.');
  }
}

remember.addEventListener('change', () => {
  if (!currentOriginPattern) return;
  permissionNote.textContent = remember.checked
    ? 'Site access needed to save.'
    : 'Session only';
});

startButton.addEventListener('click', async () => {
  if (!activeTab?.id || !activeUrl || !canInject) return;
  startButton.disabled = true;
  startButton.querySelector('span').textContent = 'Opening…';
  setError('');

  let persistent = false;
  try {
    if (remember.checked) {
      try {
        persistent = await chrome.permissions.request({ origins: [currentOriginPattern] });
      } catch (_) {
        persistent = false;
      }
      if (persistent) {
        const registered = await chrome.runtime.sendMessage({ type: 'PMW_REGISTER_SITE', url: activeUrl });
        if (!registered?.ok) {
          persistent = false;
          permissionNote.textContent = 'Saving unavailable. Session only.';
        }
      } else {
        permissionNote.textContent = 'Session only';
      }
    }

    await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] });
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: 'PMW_OPEN',
      persistent,
      sourceUrl: activeUrl
    });
    if (response && response.ok === false) throw new Error(response.error || 'Could not open the palette.');
    window.close();
  } catch (error) {
    setError(error?.message || 'Could not open this page.');
    startButton.disabled = false;
    startButton.querySelector('span').textContent = 'Try again';
  }
});

initialize();
