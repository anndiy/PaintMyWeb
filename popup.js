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
      sitePath.textContent = 'Open a regular website first.';
      permissionNote.textContent = 'PaintMyWeb cannot run on browser settings or extension pages.';
      setError('Switch to a regular HTTP or HTTPS page to use PaintMyWeb.');
      return;
    }

    const url = new URL(activeUrl);
    currentOriginPattern = patternForUrl(activeUrl);
    if (!currentOriginPattern) {
      siteName.textContent = url.protocol === 'file:' ? 'Local file' : url.hostname || url.protocol;
      sitePath.textContent = activeUrl;
      permissionNote.textContent = 'Chrome restricts extensions on this page.';
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
        ? `Saved locally: ${status.savedCount} paint${status.savedCount === 1 ? '' : 's'} on this site.`
        : 'Saving is enabled for this site. New paints will survive refreshes.';
    } else {
      remember.checked = true;
      permissionNote.textContent = 'Saving asks for access to this site only. Uncheck to paint for this session only.';
    }
    startButton.disabled = false;
  } catch (error) {
    siteName.textContent = 'Could not inspect this tab';
    setError(error?.message || 'Could not initialize PaintMyWeb.');
  }
}

remember.addEventListener('change', () => {
  if (!currentOriginPattern) return;
  permissionNote.textContent = remember.checked
    ? 'PaintMyWeb will ask for permission to remember changes on this site.'
    : 'Session-only mode: new changes will not be saved for future visits.';
});

startButton.addEventListener('click', async () => {
  if (!activeTab?.id || !activeUrl || !canInject) return;
  startButton.disabled = true;
  startButton.querySelector('span').textContent = 'Opening palette…';
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
          permissionNote.textContent = 'Could not enable automatic restoration. Painting will be session-only.';
        }
      } else {
        permissionNote.textContent = 'Site access was not granted. You can still paint this page for the current session.';
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
    setError(error?.message || 'Could not open PaintMyWeb on this page.');
    startButton.disabled = false;
    startButton.querySelector('span').textContent = 'Try again';
  }
});

initialize();
