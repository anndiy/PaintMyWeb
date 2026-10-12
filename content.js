(() => {
  // The popup may inject this file even when the persistent content script is already running.
  if (globalThis.__PAINTMYWEB_CONTENT_V2__) return;
  globalThis.__PAINTMYWEB_CONTENT_V2__ = true;

  const HOST_ID = 'paintmyweb-floating-host';
  const MODES = {
    element: { property: 'background-color', label: 'FILL' },
    text: { property: 'color', label: 'TEXT' }
  };

  let host = null;
  let shadow = null;
  let panel = null;
  let highlight = null;
  let highlightLabel = null;
  let canvas = null;
  let canvasContext = null;
  let mode = 'element';
  let currentColor = '#F1B39E';
  let hue = 13;
  let saturation = 0.34;
  let shadePosition = 52.75;
  let persistentForThisSession = false;
  let isSelecting = false;
  let currentTarget = null;
  let confirmClear = false;
  let activePageKey = getPageKey();
  let activeActions = [];
  let originalInlineStyles = new Map();
  let refreshScheduled = false;
  let pageCheckTimer = null;
  let toastTimer = null;

  function getPageKey() {
    return `${location.origin}${location.pathname}${location.search}`;
  }

  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    let hex = value.trim();
    if (!hex.startsWith('#')) hex = `#${hex}`;
    if (/^#[0-9a-f]{3}$/i.test(hex)) {
      hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }
    return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null;
  }

  function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    let rgb;
    if (h < 60) rgb = [c, x, 0];
    else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return rgb.map(channel => Math.round((channel + m) * 255));
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map(n => Math.round(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  }

  function hexToHsv(hex) {
    const raw = hex.replace('#', '');
    const r = parseInt(raw.slice(0, 2), 16) / 255;
    const g = parseInt(raw.slice(2, 4), 16) / 255;
    const b = parseInt(raw.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta !== 0) {
      if (max === r) h = 60 * (((g - b) / delta) % 6);
      else if (max === g) h = 60 * ((b - r) / delta + 2);
      else h = 60 * ((r - g) / delta + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max === 0 ? 0 : delta / max, v: max };
  }

  const initialHsv = hexToHsv(currentColor);
  hue = initialHsv.h;
  saturation = initialHsv.s;
  shadePosition = 50 + (1 - initialHsv.v) * 50;

  function colorFromWheel() {
    const base = hsvToRgb(hue, saturation, 1);
    const position = Math.max(0, Math.min(100, shadePosition));
    let rgb;
    if (position <= 50) {
      const mix = position / 50;
      rgb = base.map(channel => 255 + (channel - 255) * mix);
    } else {
      const mix = 1 - (position - 50) / 50;
      rgb = base.map(channel => channel * mix);
    }
    currentColor = rgbToHex(...rgb);
    updateColorReadout();
  }

  function updateColorReadout() {
    const swatch = shadow?.getElementById('selected-color');
    const hexField = shadow?.getElementById('hex-value');
    const shadeControl = shadow?.getElementById('brightness');
    if (swatch) swatch.style.background = currentColor;
    if (hexField && hexField !== shadow.activeElement) hexField.value = currentColor;
    if (shadeControl) {
      const base = rgbToHex(...hsvToRgb(hue, saturation, 1));
      shadeControl.style.setProperty('--shade-color', base);
      if (shadeControl !== shadow.activeElement) shadeControl.value = String(Math.round(shadePosition));
    }
    const contrast = relativeLuminance(currentColor) > 0.55 ? '#171312' : '#fff7f2';
    if (swatch) swatch.style.color = contrast;
    drawWheel();
  }

  function relativeLuminance(hex) {
    const raw = hex.replace('#', '');
    const channels = [0, 2, 4].map(start => parseInt(raw.slice(start, start + 2), 16) / 255).map(channel =>
      channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4));
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  function drawWheel() {
    if (!canvas || !canvasContext) return;
    const width = canvas.width;
    const height = canvas.height;
    const image = canvasContext.createImageData(width, height);
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) / 2 - 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - centerX;
        const dy = y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const index = (y * width + x) * 4;
        if (distance <= radius) {
          const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
          const sat = Math.min(1, distance / radius);
          const [r, g, b] = hsvToRgb(angle, sat, 1);
          image.data[index] = r;
          image.data[index + 1] = g;
          image.data[index + 2] = b;
          image.data[index + 3] = 255;
        } else {
          image.data[index + 3] = 0;
        }
      }
    }
    canvasContext.putImageData(image, 0, 0);

    const angle = hue * Math.PI / 180;
    const markerRadius = saturation * radius;
    const markerX = centerX + Math.cos(angle) * markerRadius;
    const markerY = centerY + Math.sin(angle) * markerRadius;
    canvasContext.beginPath();
    canvasContext.arc(markerX, markerY, 6, 0, Math.PI * 2);
    canvasContext.lineWidth = 3;
    canvasContext.strokeStyle = relativeLuminance(currentColor) > 0.55 ? '#171312' : '#ffffff';
    canvasContext.stroke();
    canvasContext.beginPath();
    canvasContext.arc(markerX, markerY, 3.6, 0, Math.PI * 2);
    canvasContext.fillStyle = currentColor;
    canvasContext.fill();
  }

  function ensureOriginalStyle(element, property) {
    let properties = originalInlineStyles.get(element);
    if (!properties) {
      properties = new Map();
      originalInlineStyles.set(element, properties);
    }
    if (!properties.has(property)) {
      properties.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property)
      });
    }
  }

  function restoreOriginalStyles() {
    for (const [element, properties] of originalInlineStyles.entries()) {
      for (const [property, original] of properties.entries()) {
        if (!element?.style) continue;
        if (original.value) element.style.setProperty(property, original.value, original.priority);
        else element.style.removeProperty(property);
      }
    }
    originalInlineStyles.clear();
  }

  function buildSelector(element) {
    if (!(element instanceof Element) || element === document.documentElement) return null;
    const parts = [];
    let current = element;

    while (current && current instanceof Element) {
      if (current.id) {
        const escapedId = `#${CSS.escape(current.id)}`;
        try {
          if (document.querySelectorAll(escapedId).length === 1) {
            parts.unshift(escapedId);
            break;
          }
        } catch (_) { /* Continue using a structural selector. */ }
      }

      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTagSiblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);
      const position = sameTagSiblings.indexOf(current) + 1;
      if (!position) return null;
      parts.unshift(`${tag}:nth-of-type(${position})`);
      current = parent;
      if (current === document.documentElement && parts[0] !== 'html') {
        parts.unshift('html');
        break;
      }
    }

    return parts.join(' > ');
  }

  function resolveSelector(selector, expectedTag) {
    if (typeof selector !== 'string' || !selector) return null;
    try {
      const matches = document.querySelectorAll(selector);
      if (matches.length !== 1) return null;
      const element = matches[0];
      if (!(element instanceof Element) || element === document.documentElement) return null;
      if (expectedTag && element.tagName.toLowerCase() !== expectedTag) return null;
      if (isInsideUi(element)) return null;
      return element;
    } catch (_) {
      return null;
    }
  }

  function isInsideUi(node) {
    if (!host || !node || !(node instanceof Node)) return false;
    if (node === host || host.contains(node)) return true;
    try { return node.getRootNode() === shadow; } catch (_) { return false; }
  }

  function createRule(element, property, color) {
    const selector = buildSelector(element);
    if (!selector) return null;
    const now = Date.now();
    return {
      id: `pmw-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      origin: location.origin,
      pageKey: getPageKey(),
      url: location.href,
      path: `${location.pathname}${location.search}`,
      selector,
      targetTag: element.tagName.toLowerCase(),
      property,
      value: color,
      createdAt: now
    };
  }

  function applyRuleToElement(element, rule) {
    if (!element || !element.style || !['background-color', 'color'].includes(rule.property)) return false;
    const color = normalizeHex(rule.value);
    if (!color) return false;
    ensureOriginalStyle(element, rule.property);
    element.style.setProperty(rule.property, color, 'important');
    return true;
  }

  function applyActiveActionsToCurrentDom() {
    for (const action of activeActions) {
      const element = resolveSelector(action.rule.selector, action.rule.targetTag);
      if (!element) continue;
      if (action.element === element && action.applied) continue;
      if (applyRuleToElement(element, action.rule)) {
        action.element = element;
        action.applied = true;
      }
    }
  }

  async function loadSavedRulesForCurrentPage() {
    const key = getPageKey();
    const response = await chrome.runtime.sendMessage({ type: 'PMW_GET_RULES', pageKey: key });
    const rules = response?.ok && Array.isArray(response.rules) ? response.rules : [];
    return rules.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  async function restoreSavedRules() {
    const rules = await loadSavedRulesForCurrentPage();
    // Keep any same-page session-only actions on a soft refresh, but drop saved actions
    // and repopulate them from storage so deletes/undo always reflect the source of truth.
    const temporary = activeActions.filter(action => !action.persisted && action.rule.pageKey === getPageKey());
    restoreOriginalStyles();
    const savedEntries = rules.map(rule => ({ rule, persisted: true, element: null, applied: false }));
    activeActions = [...savedEntries, ...temporary];
    applyActiveActionsToCurrentDom();
    updateHistoryStatus();
  }

  function updateHistoryStatus() {
    const label = shadow?.getElementById('history-status');
    if (label) label.textContent = `${activeActions.length} paint${activeActions.length === 1 ? '' : 's'}`;
  }

  async function sendSaveRule(rule, persist) {
    if (!persist) return { persisted: false };
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PMW_SAVE_RULE', rule });
      return { persisted: Boolean(response?.ok && response.persisted), error: response?.error || null };
    } catch (error) {
      return { persisted: false, error: error?.message || 'Storage could not be reached.' };
    }
  }

  async function paintElement(element) {
    // Capture the active mode and color at click time. The user may adjust the palette
    // while the storage operation is completing, but this paint must stay deterministic.
    const selectedMode = mode;
    const selectedColor = currentColor;
    const modeConfig = MODES[selectedMode];
    const rule = createRule(element, modeConfig.property, selectedColor);
    if (!rule) {
      showToast('Cannot target that element.');
      return;
    }

    const action = { rule, persisted: false, element, applied: false };
    if (!applyRuleToElement(element, rule)) {
      showToast('Cannot paint that element.');
      return;
    }
    action.applied = true;
    activeActions.push(action);
    updateHistoryStatus();

    // IMPORTANT: remain in selection mode so a user can paint any number of targets
    // after choosing Element or Text once. Escape or the Done painting button exits.
    const selectionButton = shadow?.getElementById('start-selecting');
    if (selectionButton) { selectionButton.textContent = 'Done'; selectionButton.setAttribute('aria-label', 'Done painting'); }

    const result = await sendSaveRule(rule, persistentForThisSession);
    action.persisted = result.persisted;

    // Undo or Clear may be clicked while the storage request is still pending. If this
    // action has already been removed from the active stack, remove its late-saved rule.
    if (!activeActions.includes(action)) {
      if (action.persisted) {
        try {
          await chrome.runtime.sendMessage({ type: 'PMW_DELETE_RULE', ruleId: rule.id, pageKey: rule.pageKey });
        } catch (_) { /* The user-facing undo/clear already happened. */ }
      }
      updateHistoryStatus();
      return;
    }

    if (result.persisted) {
      showToast('Saved');
    } else if (persistentForThisSession) {
      showToast('Painted, not saved');
    } else {
      showToast('Painted');
    }
    updateHistoryStatus();
  }

  async function undoLastPaint() {
    if (!activeActions.length) {
      showToast('Nothing to undo');
      return;
    }
    const last = activeActions[activeActions.length - 1];
    activeActions.pop();
    if (last.persisted) {
      try {
        await chrome.runtime.sendMessage({ type: 'PMW_DELETE_RULE', ruleId: last.rule.id, pageKey: getPageKey() });
      } catch (_) { /* The visual undo still proceeds in this tab. */ }
    }
    restoreOriginalStyles();
    // A removed paint may reveal an earlier paint of the same element/property.
    // Re-apply the remaining in-memory action stack in original order.
    for (const action of activeActions) {
      action.element = null;
      action.applied = false;
    }
    applyActiveActionsToCurrentDom();
    updateHistoryStatus();
    showToast('Undone');
  }

  async function clearPagePaints() {
    const key = getPageKey();
    try {
      await chrome.runtime.sendMessage({ type: 'PMW_CLEAR_PAGE', pageKey: key });
    } catch (_) { /* Also clear local visual changes if storage fails. */ }
    restoreOriginalStyles();
    activeActions = [];
    updateHistoryStatus();
    confirmClear = false;
    const clearButton = shadow.getElementById('clear-page');
    clearButton.textContent = 'Clear';
    clearButton.removeAttribute('data-confirm');
    showToast('Cleared');
  }

  function showToast(message) {
    const node = shadow?.getElementById('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('visible'), 2800);
  }

  function setMode(nextMode) {
    if (!MODES[nextMode]) return;
    mode = nextMode;
    for (const button of shadow.querySelectorAll('[data-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    const selectionButton = shadow.getElementById('start-selecting');
    if (selectionButton) {
      selectionButton.textContent = isSelecting ? 'Done' : 'Paint';
      selectionButton.setAttribute('aria-label', isSelecting ? 'Done painting' : `Paint ${mode === 'element' ? 'elements' : 'text'}`);
    }
    if (isSelecting) updateHighlightLabel();
  }

  function setPersistentMode(enabled) {
    persistentForThisSession = Boolean(enabled);
    const status = shadow?.getElementById('save-status');
    const dot = shadow?.getElementById('save-dot');
    if (status) {
      status.textContent = persistentForThisSession ? 'Saved on site' : 'Session only';
    }
    if (dot) dot.classList.toggle('is-on', persistentForThisSession);
  }

  function openPanel(persistent) {
    if (!host) createUi();
    setPersistentMode(persistent);
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    shadow.getElementById('start-selecting').focus({ preventScroll: true });
  }

  function closePanel() {
    if (!panel) return;
    stopSelecting();
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
  }

  function startSelecting() {
    isSelecting = true;
    currentTarget = null;
    highlight.style.display = 'none';
    highlightLabel.style.display = 'none';
    panel.classList.add('is-picking');
    shadow.getElementById('start-selecting').textContent = 'Done';
    shadow.getElementById('start-selecting').setAttribute('aria-label', 'Done painting');
  }

  function toggleSelecting() {
    if (isSelecting) {
      stopSelecting();
      showToast('Done');
      return;
    }
    startSelecting();
  }

  function stopSelecting() {
    isSelecting = false;
    currentTarget = null;
    if (highlight) highlight.style.display = 'none';
    if (highlightLabel) highlightLabel.style.display = 'none';
    panel?.classList.remove('is-picking');
    if (shadow?.getElementById('start-selecting')) {
      shadow.getElementById('start-selecting').textContent = 'Paint';
      shadow.getElementById('start-selecting').setAttribute('aria-label', `Paint ${mode === 'element' ? 'elements' : 'text'}`);
    }
  }

  function pageTargetFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    if (path.some(node => node === host || node === shadow || isInsideUi(node))) return null;
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (node === document.documentElement || node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'LINK') continue;
      if (isInsideUi(node)) continue;
      return node;
    }
    return null;
  }

  function updateHighlightLabel() {
    if (!highlightLabel) return;
    highlightLabel.textContent = MODES[mode].label;
  }

  function drawHighlight(element) {
    if (!element || !highlight || !highlightLabel) return;
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      highlight.style.display = 'none';
      highlightLabel.style.display = 'none';
      return;
    }
    const left = Math.max(0, Math.min(window.innerWidth, rect.left));
    const top = Math.max(0, Math.min(window.innerHeight, rect.top));
    const right = Math.max(left, Math.min(window.innerWidth, rect.right));
    const bottom = Math.max(top, Math.min(window.innerHeight, rect.bottom));
    const width = right - left;
    const height = bottom - top;
    highlight.style.display = 'block';
    highlight.style.left = `${left}px`;
    highlight.style.top = `${top}px`;
    highlight.style.width = `${Math.max(0, width)}px`;
    highlight.style.height = `${Math.max(0, height)}px`;
    updateHighlightLabel();
    highlightLabel.style.display = 'block';
    highlightLabel.style.left = `${Math.max(6, Math.min(left, window.innerWidth - 150))}px`;
    highlightLabel.style.top = `${Math.max(5, top - 25)}px`;
  }

  function onDocumentPointerMove(event) {
    if (!isSelecting) return;
    const target = pageTargetFromEvent(event);
    if (!target) return;
    currentTarget = target;
    drawHighlight(target);
  }

  function onDocumentPointerDown(event) {
    if (!isSelecting) return;
    const target = pageTargetFromEvent(event);
    if (!target || !target.isConnected) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    currentTarget = target;
    void paintElement(target);
  }

  function handleWheelPointer(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX - canvas.width / 2;
    const y = (event.clientY - rect.top) * scaleY - canvas.height / 2;
    const radius = Math.min(canvas.width, canvas.height) / 2 - 2;
    const distance = Math.min(radius, Math.sqrt(x * x + y * y));
    hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    saturation = distance / radius;
    colorFromWheel();
  }

  function createUi() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-paintmyweb-extension', 'true');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    (document.documentElement || document.body).appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: dark; font-family: "Segoe UI Variable", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-feature-settings: "cv11" 1, "ss01" 1; -webkit-font-smoothing: antialiased; }
        * { box-sizing: border-box; }
        button, input { font: inherit; }
        button { -webkit-tap-highlight-color: transparent; }
        .panel { position: fixed; right: 22px; bottom: 22px; width: 306px; max-height: min(760px, calc(100vh - 32px)); overflow: auto; overscroll-behavior: contain; display: none; pointer-events: auto; color: #f2eeeb; background: rgba(13, 12, 12, .97); border: 1px solid #39312e; border-radius: 13px; box-shadow: 0 20px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.025); backdrop-filter: blur(18px); scrollbar-width: thin; scrollbar-color: #52443e transparent; font-size: 12px; line-height: 1.45; }
        .panel.is-open { display: block; animation: pmw-enter .16s ease-out; }
        .panel.is-picking { border-color: #f1b39e; box-shadow: 0 20px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(241,179,158,.28); }
        @keyframes pmw-enter { from { opacity: .5; transform: translateY(7px) scale(.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .header { display: flex; align-items: center; gap: 10px; padding: 13px 14px; border-bottom: 1px solid #2b2624; cursor: grab; user-select: none; }
        .header:active { cursor: grabbing; }
        .brand-mark { width: 31px; height: 31px; flex: 0 0 auto; display: grid; grid-template-columns: repeat(2, 7px); place-content: center; gap: 3px; background: #241a17; border: 1px solid #63483e; border-radius: 8px; }
        .brand-mark i { display: block; width: 7px; height: 7px; border-radius: 2px; background: #f1b39e; }
        .brand-mark i:nth-child(2) { background: #f0d17d; } .brand-mark i:nth-child(3) { background: #9dd3be; } .brand-mark i:nth-child(4) { background: #9db8fb; }
        .brand { flex: 1; min-width: 0; }
        .title { margin: 0; font-size: 15px; font-weight: 720; letter-spacing: -.035em; line-height: 1.2; }
        .title span { color: #f1b39e; }
        .subtitle { display: none; }
        .icon-button { display: grid; place-items: center; width: 27px; height: 27px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #a99e97; cursor: pointer; }
        .icon-button:hover { background: #211c1a; border-color: #3b302c; color: #fff; }
        .icon-button svg { width: 15px; height: 15px; }
        .body { padding: 13px 14px 14px; }
        .eyebrow { margin: 0 0 7px; color: #a8978e; font-size: 10px; font-weight: 650; letter-spacing: .025em; }
        .wheel-layout { display: grid; grid-template-columns: 164px 1fr; gap: 10px; align-items: center; }
        .wheel-frame { width: 164px; height: 164px; display: grid; place-items: center; position: relative; }
        canvas { display: block; width: 160px; height: 160px; border-radius: 50%; cursor: crosshair; touch-action: none; }
        .color-side { min-width: 0; display: flex; flex-direction: column; gap: 9px; }
        .swatch { width: 100%; height: 43px; display: grid; place-items: center; border: 1px solid rgba(255,255,255,.25); border-radius: 7px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; font-weight: 800; text-shadow: 0 1px 1px rgba(255,255,255,.12); }
        .field-label { display: block; margin-bottom: 4px; color: #9d928b; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
        .hex-input { width: 100%; min-width: 0; height: 31px; padding: 0 7px; outline: 0; border: 1px solid #3a302c; border-radius: 6px; background: #181514; color: #f4e8e2; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; text-transform: uppercase; }
        .hex-input:focus { border-color: #ba8a78; box-shadow: 0 0 0 2px rgba(241,179,158,.1); }
        .brightness { --shade-color: #F1B39E; appearance: none; display: block; width: 100%; height: 20px; margin: 3px 0 0; padding: 0; background: transparent; cursor: ew-resize; }
        .brightness::-webkit-slider-runnable-track { height: 8px; border: 1px solid rgba(255,255,255,.28); border-radius: 999px; background: linear-gradient(90deg, #fff 0%, var(--shade-color) 50%, #000 100%); }
        .brightness::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; margin-top: -4px; border: 2px solid #fff; border-radius: 50%; background: var(--shade-color); box-shadow: 0 1px 5px rgba(0,0,0,.55); }
        .brightness::-moz-range-track { height: 8px; border: 1px solid rgba(255,255,255,.28); border-radius: 999px; background: linear-gradient(90deg, #fff 0%, var(--shade-color) 50%, #000 100%); }
        .brightness::-moz-range-thumb { width: 10px; height: 10px; border: 2px solid #fff; border-radius: 50%; background: var(--shade-color); box-shadow: 0 1px 5px rgba(0,0,0,.55); }
        .brightness:focus-visible { outline: 2px solid #f1b39e; outline-offset: 3px; border-radius: 999px; }
        .slider-label { display: none; }
        .section-separator { height: 1px; background: #2a2523; margin: 14px 0 13px; }
        .mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
        .mode-button { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 8px 9px; text-align: left; border: 1px solid #37302d; border-radius: 8px; color: #c4bab4; background: #171514; cursor: pointer; transition: background .14s,border-color .14s,color .14s; }
        .mode-button svg { width: 18px; height: 18px; flex: 0 0 auto; }
        .mode-button strong { display: block; font-size: 11px; font-weight: 750; }
        .mode-button small { display: none; }
        .mode-button[aria-pressed="true"] { border-color: #9b6c5c; color: #ffe3d8; background: #2a1d19; box-shadow: inset 0 0 0 1px rgba(241,179,158,.05); }
        .mode-button[aria-pressed="true"] small { color: #c39b8d; }
        .primary { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 37px; padding: 8px 12px; margin-top: 9px; border: 1px solid #e7ad98; border-radius: 7px; background: #f1b39e; color: #231714; font-size: 12px; font-weight: 700; cursor: pointer; transition: background .15s,transform .15s; }
        .primary:hover { background: #ffd0bf; transform: translateY(-1px); }
        .primary svg { width: 15px; height: 15px; }
        .hint { display: none; }
        .hint b { font-weight: 700; }
        .save-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 7px 9px; border: 1px solid #2c2725; border-radius: 7px; background: #121110; }
        .dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: #77706b; box-shadow: 0 0 0 3px rgba(119,112,107,.12); }
        .dot.is-on { background: #90d1a0; box-shadow: 0 0 0 3px rgba(144,209,160,.1); }
        .save-copy { flex: 1; min-width: 0; color: #a99e97; font-size: 10px; }
        .save-copy b { color: #e3d9d3; font-weight: 650; }
        .save-copy small { display: none; }
        .history-status { margin-top: 6px; color: #8b817b; font-size: 10px; }
        .footer-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 11px; }
        .secondary { min-height: 30px; padding: 6px 8px; border: 1px solid #39312e; border-radius: 6px; background: #171514; color: #c6bbb4; font-size: 11px; font-weight: 600; cursor: pointer; }
        .secondary:hover { border-color: #806153; background: #211a17; color: #fff0e8; }
        .secondary[data-confirm="true"] { border-color: #a95a50; background: #2c1715; color: #ffd2ca; }
        .toast { position: fixed; left: 50%; bottom: 20px; z-index: 2147483647; max-width: min(360px,calc(100vw - 24px)); transform: translate(-50%,8px); opacity: 0; visibility: hidden; pointer-events: none; padding: 10px 13px; border: 1px solid #57453e; border-radius: 7px; background: #211a17; color: #f4ded4; font-size: 11px; line-height: 1.45; box-shadow: 0 10px 35px rgba(0,0,0,.35); transition: opacity .16s,transform .16s,visibility .16s; }
        .toast.visible { opacity: 1; visibility: visible; transform: translate(-50%,0); }
        .highlight { position: fixed; display: none; z-index: 2147483646; pointer-events: none; border: 2px solid #ffe0d3; outline: 1px solid #5a3026; border-radius: 3px; background: rgba(241,179,158,.10); box-shadow: 0 0 0 3px rgba(241,179,158,.17), 0 0 22px rgba(241,179,158,.36); }
        .highlight-label { position: fixed; display: none; z-index: 2147483647; pointer-events: none; padding: 4px 6px; border-radius: 4px; background: #f1b39e; color: #211613; box-shadow: 0 4px 15px rgba(0,0,0,.3); font: 700 9px/1.2 "Segoe UI Variable",system-ui,sans-serif; letter-spacing: .06em; white-space: nowrap; }
        .drag-hint { display: grid; place-items: center; width: 24px; height: 24px; margin-left: auto; border-radius: 5px; color: #897a72; cursor: grab; }
        .drag-hint:hover { background: #211c1a; color: #ead5cc; }
        .drag-hint svg { width: 16px; height: 16px; }
        @media (max-width: 380px) { .panel { right: 8px; bottom: 8px; width: min(306px,calc(100vw - 16px)); max-height: calc(100vh - 16px); } }
        @media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
      </style>
      <div class="highlight" id="highlight" aria-hidden="true"></div>
      <div class="highlight-label" id="highlight-label" aria-hidden="true">FILL</div>
      <section class="panel" id="panel" aria-label="PaintMyWeb palette" aria-hidden="true">
        <header class="header" id="drag-handle">
          <div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
          <div class="brand"><h2 class="title">PaintMyWeb<span>.</span></h2></div>
          <span class="drag-hint" title="Drag palette" aria-label="Drag palette">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>
          </span>
          <button class="icon-button" id="close-panel" type="button" aria-label="Close PaintMyWeb palette" title="Close palette">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </header>
        <div class="body">
          <div class="wheel-layout">
            <div class="wheel-frame"><canvas id="color-wheel" width="220" height="220" tabindex="0" role="application" aria-label="Color wheel. Click or drag to choose a hue and saturation."></canvas></div>
            <div class="color-side">
              <div class="swatch" id="selected-color">#F1B39E</div>
              <label><span class="field-label">HEX</span><input class="hex-input" id="hex-value" type="text" maxlength="7" value="#F1B39E" autocomplete="off" spellcheck="false" aria-label="HEX color value"></label>
              <label><span class="field-label">Shade</span><input class="brightness" id="brightness" type="range" min="0" max="100" value="53" aria-label="Shade from white through the selected color to black" title="White to black"></label>
            </div>
          </div>

          <div class="section-separator"></div>
          <p class="eyebrow">Paint</p>
          <div class="mode-grid">
            <button class="mode-button" type="button" data-mode="element" aria-pressed="true" title="Paint element background">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 13 8-8 7 7-8 8-7-7Z" fill="currentColor" fill-opacity=".13"/><path d="m4 13 8-8 7 7-8 8-7-7Z"/><path d="m12 5 3-3 6 6-3 3"/><path d="M3 16 9 10"/><path d="M18.5 18.5c0-1 1.5-2.6 1.5-2.6s1.5 1.6 1.5 2.6a1.5 1.5 0 0 1-3 0Z" fill="currentColor" fill-opacity=".25"/></svg>
              <span><strong>Element</strong></span>
            </button>
            <button class="mode-button" type="button" data-mode="text" aria-pressed="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6V4h16v2M12 4v16M8 20h8"/></svg>
              <span><strong>Text</strong></span>
            </button>
          </div>
          <button class="primary" id="start-selecting" type="button" aria-label="Start painting">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 3 14 10-7 1-3 7L5 3Z"/></svg>
            Paint
          </button>

          <div class="save-row" title="Paints stay on this device."><span class="dot" id="save-dot"></span><span class="save-copy"><b id="save-status">Session only</b></span></div>
          <div class="history-status" id="history-status">0 paints</div>
          <div class="footer-actions">
            <button class="secondary" id="undo-paint" type="button" aria-label="Undo last paint" title="Undo last paint">↶ Undo</button>
            <button class="secondary" id="clear-page" type="button" aria-label="Clear page paints" title="Clear page paints">Clear</button>
          </div>
        </div>
      </section>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    `;

    panel = shadow.getElementById('panel');
    highlight = shadow.getElementById('highlight');
    highlightLabel = shadow.getElementById('highlight-label');
    canvas = shadow.getElementById('color-wheel');
    canvasContext = canvas.getContext('2d', { willReadFrequently: true });

    for (const button of shadow.querySelectorAll('[data-mode]')) {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    }
    shadow.getElementById('start-selecting').addEventListener('click', toggleSelecting);
    shadow.getElementById('close-panel').addEventListener('click', closePanel);
    shadow.getElementById('undo-paint').addEventListener('click', () => void undoLastPaint());
    shadow.getElementById('clear-page').addEventListener('click', async () => {
      const button = shadow.getElementById('clear-page');
      if (!confirmClear) {
        confirmClear = true;
        button.dataset.confirm = 'true';
        button.textContent = 'Confirm';
        showToast('Confirm clear');
        setTimeout(() => {
          if (confirmClear) {
            confirmClear = false;
            button.textContent = 'Clear';
            button.removeAttribute('data-confirm');
          }
        }, 3500);
        return;
      }
      await clearPagePaints();
    });

    canvas.addEventListener('pointerdown', event => {
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      handleWheelPointer(event);
    });
    canvas.addEventListener('pointermove', event => {
      if (event.buttons || event.pressure > 0) handleWheelPointer(event);
    });
    canvas.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft') { hue = (hue + 350) % 360; colorFromWheel(); }
      if (event.key === 'ArrowRight') { hue = (hue + 10) % 360; colorFromWheel(); }
    });

    shadow.getElementById('brightness').addEventListener('input', event => {
      shadePosition = Number(event.target.value);
      colorFromWheel();
    });

    const hexField = shadow.getElementById('hex-value');
    hexField.addEventListener('change', () => {
      const hex = normalizeHex(hexField.value);
      if (!hex) {
        hexField.value = currentColor;
        showToast('Invalid HEX');
        return;
      }
      currentColor = hex;
      const hsv = hexToHsv(hex);
      hue = hsv.h;
      saturation = hsv.s;
      shadePosition = 50 + (1 - hsv.v) * 50;
      shadow.getElementById('brightness').value = String(Math.round(shadePosition));
      updateColorReadout();
    });
    hexField.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        hexField.blur();
      }
    });

    attachDragBehavior();
    updateColorReadout();
    setMode('element');
    setPersistentMode(false);
    updateHistoryStatus();
  }

  function attachDragBehavior() {
    const handle = shadow.getElementById('drag-handle');
    let drag = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!drag) return;
      const left = Math.max(6, Math.min(window.innerWidth - panel.offsetWidth - 6, drag.left + event.clientX - drag.startX));
      const top = Math.max(6, Math.min(window.innerHeight - panel.offsetHeight - 6, drag.top + event.clientY - drag.startY));
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });
    const endDrag = () => { drag = null; };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && isSelecting) {
      event.preventDefault();
      stopSelecting();
      showToast('Cancelled');
    }
  }

  function scheduleDomReattach() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    requestAnimationFrame(() => {
      refreshScheduled = false;
      const nextKey = getPageKey();
      if (nextKey !== activePageKey) {
        activePageKey = nextKey;
        restoreOriginalStyles();
        activeActions = [];
        void restoreSavedRules();
        return;
      }
      applyActiveActionsToCurrentDom();
    });
  }

  async function handlePageChange() {
    const nextKey = getPageKey();
    if (nextKey === activePageKey) return;
    activePageKey = nextKey;
    stopSelecting();
    restoreOriginalStyles();
    activeActions = [];
    await restoreSavedRules();
  }

  function initialize() {
    createUi();
    document.addEventListener('pointermove', onDocumentPointerMove, true);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', () => {
      if (isSelecting && currentTarget) drawHighlight(currentTarget);
    }, true);
    window.addEventListener('resize', () => {
      if (isSelecting && currentTarget) drawHighlight(currentTarget);
    });
    window.addEventListener('popstate', () => void handlePageChange());
    window.addEventListener('hashchange', () => void handlePageChange());
    const observer = new MutationObserver(() => scheduleDomReattach());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    pageCheckTimer = setInterval(() => void handlePageChange(), 700);
    void restoreSavedRules();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PMW_OPEN') {
      openPanel(Boolean(message.persistent));
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'PMW_CLOSE') {
      closePanel();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  initialize();
})();
