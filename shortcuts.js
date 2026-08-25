// YouTube Speed Trainer — Keyboard Shortcut Customizer (issue #7)
// Standalone MV3 extension page. Configures the in-page shortcuts that
// content.js reads from chrome.storage.local as `customShortcuts`.
// Each binding: { code, alt, ctrl, shift, meta } | null.
// All logic lives here (no inline handlers) to satisfy the MV3 CSP.

(function () {
  'use strict';

  // ---- Model -------------------------------------------------------------

  // Must mirror content.js DEFAULT_SHORTCUTS exactly.
  const DEFAULT_SHORTCUTS = {
    'increase-speed': { code: 'ArrowUp', alt: true, ctrl: false, shift: true, meta: false },
    'decrease-speed': { code: 'ArrowDown', alt: true, ctrl: false, shift: true, meta: false },
    'reset-speed': { code: 'KeyR', alt: true, ctrl: false, shift: true, meta: false },
    'toggle-auto': null
  };

  // The four configurable actions, with friendly, non-technical descriptions (#7.16, #7.19).
  const ACTIONS = [
    { id: 'increase-speed', name: 'Increase Speed', desc: 'Nudge playback a little faster.' },
    { id: 'decrease-speed', name: 'Decrease Speed', desc: 'Nudge playback a little slower.' },
    { id: 'reset-speed', name: 'Reset Speed', desc: 'Jump back to normal (1.00×) speed.' },
    { id: 'toggle-auto', name: 'Activate Extension', desc: 'Toggle automatic speed progression on or off.' }
  ];

  // Known reserved / risky combos we warn about (#7.10, #7.11).
  // `mods` lists which modifiers must be pressed; missing = false.
  const RESERVED = [
    { code: 'KeyT', mods: { ctrl: true }, owner: 'Browser: new tab' },
    { code: 'KeyW', mods: { ctrl: true }, owner: 'Browser: close tab' },
    { code: 'KeyN', mods: { ctrl: true }, owner: 'Browser: new window' },
    { code: 'KeyT', mods: { ctrl: true, shift: true }, owner: 'Browser: reopen closed tab' },
    { code: 'KeyN', mods: { ctrl: true, shift: true }, owner: 'Browser: incognito window' },
    { code: 'KeyT', mods: { meta: true }, owner: 'Browser: new tab' },
    { code: 'KeyW', mods: { meta: true }, owner: 'Browser: close tab' },
    { code: 'F5', mods: {}, owner: 'Browser: reload' },
    { code: 'F4', mods: { alt: true }, owner: 'System: close window' },
    // Common YouTube single-key shortcuts (no modifier) — easy to clobber.
    { code: 'Space', mods: {}, owner: 'YouTube: play / pause' },
    { code: 'KeyK', mods: {}, owner: 'YouTube: play / pause' },
    { code: 'KeyF', mods: {}, owner: 'YouTube: fullscreen' },
    { code: 'KeyM', mods: {}, owner: 'YouTube: mute' },
    { code: 'KeyJ', mods: {}, owner: 'YouTube: rewind 10s' },
    { code: 'KeyL', mods: {}, owner: 'YouTube: forward 10s' }
  ];

  // Runtime state.
  let customShortcuts = {};      // action id -> binding | null
  let layout = 'win';            // 'win' | 'mac'
  let selectedAction = null;     // action id being edited
  let pending = null;            // { code, alt, ctrl, shift, meta } | null
  let tested = false;            // has the pending combo passed the Test area?

  // ---- Code -> readable label (#7.19) ------------------------------------

  const SPECIAL_LABELS = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: '⌫',
    Minus: '-', Equal: '=', Backquote: '`',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
    AltLeft: 'Alt', AltRight: 'Alt',
    ShiftLeft: 'Shift', ShiftRight: 'Shift',
    MetaLeft: 'Meta', MetaRight: 'Meta'
  };

  // Translate a KeyboardEvent.code into a short human label. Never shows the
  // raw code to the user.
  function codeToLabel(code) {
    if (!code) return '';
    if (SPECIAL_LABELS[code]) return SPECIAL_LABELS[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);      // KeyR -> R
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);    // Digit1 -> 1
    if (/^Numpad[0-9]$/.test(code)) return 'Num ' + code.slice(6);
    if (/^F[0-9]{1,2}$/.test(code)) return code;            // F5 -> F5
    return code;
  }

  // Is this code a modifier key (never a valid "main" key)?
  function isModifierCode(code) {
    return /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code || '');
  }

  // Modifier display labels per layout (#7.3).
  function modLabel(mod) {
    const M = {
      win: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' },
      mac: { ctrl: '⌃Control', alt: '⌥Option', shift: '⇧Shift', meta: '⌘Command' }
    };
    return M[layout][mod];
  }

  // Compact modifier badge label for chips.
  function modChip(mod) {
    const M = {
      win: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' },
      mac: { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
    };
    return M[layout][mod];
  }

  // Ordered modifier list for a binding.
  function bindingMods(b) {
    const out = [];
    if (b.ctrl) out.push('ctrl');
    if (b.alt) out.push('alt');
    if (b.shift) out.push('shift');
    if (b.meta) out.push('meta');
    return out;
  }

  // Readable one-line string, e.g. "Alt + Shift + ↑".
  function bindingToText(b) {
    if (!b || !b.code) return 'Not assigned';
    const parts = bindingMods(b).map(modChip);
    parts.push(codeToLabel(b.code));
    return parts.join(' + ');
  }

  // ---- Binding helpers ---------------------------------------------------

  function bindingsEqual(a, b) {
    if (!a || !b || !a.code || !b.code) return false;
    return a.code === b.code &&
      !!a.alt === !!b.alt && !!a.ctrl === !!b.ctrl &&
      !!a.shift === !!b.shift && !!a.meta === !!b.meta;
  }

  function hasAnyModifier(b) {
    return !!(b && (b.alt || b.ctrl || b.shift || b.meta));
  }

  // A binding is valid only with a non-modifier main key (#7 helper rule).
  function isValidBinding(b) {
    return !!(b && b.code && !isModifierCode(b.code));
  }

  function eventToBinding(e) {
    return { code: e.code, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey };
  }

  function eventMatchesBinding(e, b) {
    if (!b || !b.code) return false;
    return e.code === b.code &&
      e.altKey === !!b.alt && e.ctrlKey === !!b.ctrl &&
      e.shiftKey === !!b.shift && e.metaKey === !!b.meta;
  }

  // Does a binding match a RESERVED entry?
  function reservedOwner(b) {
    if (!b || !b.code) return null;
    for (const r of RESERVED) {
      if (r.code !== b.code) continue;
      if (!!b.ctrl === !!r.mods.ctrl && !!b.alt === !!r.mods.alt &&
          !!b.shift === !!r.mods.shift && !!b.meta === !!r.mods.meta) {
        return r.owner;
      }
    }
    return null;
  }

  // Which *other* action already owns this binding (#7.10)?
  function conflictingAction(b, exceptId) {
    for (const a of ACTIONS) {
      if (a.id === exceptId) continue;
      if (bindingsEqual(customShortcuts[a.id], b)) return a;
    }
    return null;
  }

  function actionName(id) {
    const a = ACTIONS.find((x) => x.id === id);
    return a ? a.name : id;
  }

  // ---- Keyboard layout data ----------------------------------------------
  // Rows of { code, label } (main keys). Modifier row built separately.

  const NUM_ROW = [
    'Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
    'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'
  ];
  const ROW_Q = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'];
  const ROW_A = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'];
  const ROW_Z = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'];

  function makeKey(code, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'key' + (opts.cls ? ' ' + opts.cls : '');
    el.dataset.code = code || '';
    if (opts.mod) el.dataset.mod = opts.mod;
    el.style.position = 'relative';

    const main = document.createElement('span');
    main.textContent = opts.label != null ? opts.label : codeToLabel(code);
    el.appendChild(main);

    if (opts.sub) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = opts.sub;
      el.appendChild(sub);
    }
    return el;
  }

  function buildKeyboard() {
    const kb = document.getElementById('keyboard');
    kb.innerHTML = '';

    const rowEl = (keys) => {
      const r = document.createElement('div');
      r.className = 'kbd-row';
      keys.forEach((code) => r.appendChild(makeKey(code)));
      return r;
    };

    kb.appendChild(rowEl(NUM_ROW));
    kb.appendChild(rowEl(ROW_Q));
    kb.appendChild(rowEl(ROW_A));
    kb.appendChild(rowEl(ROW_Z));

    // Modifier + space + arrows row (labels depend on layout, #7.3).
    const bottom = document.createElement('div');
    bottom.className = 'kbd-row';

    const mods = layout === 'mac'
      ? [
          { mod: 'ctrl', label: '⌃', sub: 'Control' },
          { mod: 'alt', label: '⌥', sub: 'Option' },
          { mod: 'shift', label: '⇧', sub: 'Shift' },
          { mod: 'meta', label: '⌘', sub: 'Command' }
        ]
      : [
          { mod: 'ctrl', label: 'Ctrl' },
          { mod: 'shift', label: 'Shift' },
          { mod: 'alt', label: 'Alt' },
          { mod: 'meta', label: 'Win' }
        ];

    mods.forEach((m) => {
      bottom.appendChild(makeKey('', { cls: 'mod wide', mod: m.mod, label: m.label, sub: m.sub }));
    });

    bottom.appendChild(makeKey('Space', { cls: 'space', label: 'Space' }));

    // Arrow cluster.
    bottom.appendChild(makeKey('ArrowLeft', { label: '←' }));
    bottom.appendChild(makeKey('ArrowUp', { label: '↑' }));
    bottom.appendChild(makeKey('ArrowDown', { label: '↓' }));
    bottom.appendChild(makeKey('ArrowRight', { label: '→' }));

    kb.appendChild(bottom);

    // Delegate clicks once.
    kb.addEventListener('click', onKeyClick);
  }

  // Click on a visual key: modifiers toggle, main keys set the code (#7.2, #7.18).
  function onKeyClick(e) {
    const keyEl = e.target.closest('.key');
    if (!keyEl || !selectedAction) return;

    if (keyEl.dataset.mod) {
      if (!pending) pending = { code: null, alt: false, ctrl: false, shift: false, meta: false };
      const m = keyEl.dataset.mod;
      pending[m] = !pending[m];
    } else if (keyEl.dataset.code) {
      if (!pending) pending = { code: null, alt: false, ctrl: false, shift: false, meta: false };
      pending.code = keyEl.dataset.code;
    }
    tested = false;
    resetTestArea();
    renderEditor();
  }

  // ---- Rendering ---------------------------------------------------------

  function renderActions() {
    const list = document.getElementById('actions-list');
    list.innerHTML = '';
    ACTIONS.forEach((a) => {
      const b = customShortcuts[a.id];
      const row = document.createElement('div');
      row.className = 'action' + (a.id === selectedAction ? ' selected' : '');
      row.dataset.id = a.id;

      const dot = document.createElement('div');
      dot.className = 'dot';
      row.appendChild(dot);

      const body = document.createElement('div');
      body.style.flex = '1';
      const name = document.createElement('div');
      name.className = 'a-name';
      name.textContent = a.name;
      const desc = document.createElement('div');
      desc.className = 'a-desc';
      desc.textContent = a.desc;
      const bind = document.createElement('div');
      bind.className = 'a-binding' + (isValidBinding(b) ? '' : ' unset');
      bind.textContent = isValidBinding(b) ? bindingToText(b) : 'Not assigned';
      body.appendChild(name);
      body.appendChild(desc);
      body.appendChild(bind);
      row.appendChild(body);

      row.addEventListener('click', () => selectAction(a.id));
      list.appendChild(row);
    });
  }

  function renderChips() {
    const wrap = document.getElementById('chips');
    wrap.innerHTML = '';
    if (!pending || (!pending.code && !hasAnyModifier(pending))) {
      const em = document.createElement('span');
      em.className = 'empty';
      em.textContent = 'No keys chosen yet — click keys below or use the capture box.';
      wrap.appendChild(em);
      return;
    }
    const parts = [];
    bindingMods(pending).forEach((m) => parts.push(modChip(m)));
    if (pending.code) parts.push(codeToLabel(pending.code));

    parts.forEach((p, i) => {
      if (i > 0) {
        const plus = document.createElement('span');
        plus.className = 'chip plus';
        plus.textContent = '+';
        wrap.appendChild(plus);
      }
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = p;
      wrap.appendChild(chip);
    });
  }

  // Paint key highlight state: this action (on), other actions (other), reserved (#7.5).
  function renderKeyboardState() {
    const keys = document.querySelectorAll('#keyboard .key');
    // Collect codes used by OTHER actions.
    const otherCodes = new Set();
    ACTIONS.forEach((a) => {
      if (a.id === selectedAction) return;
      const b = customShortcuts[a.id];
      if (isValidBinding(b)) otherCodes.add(b.code);
    });

    keys.forEach((el) => {
      el.classList.remove('on', 'other', 'reserved-hint');
      const mod = el.dataset.mod;
      const code = el.dataset.code;

      if (mod) {
        if (pending && pending[mod]) el.classList.add('on');
        return;
      }
      if (!code) return;

      if (pending && pending.code === code) el.classList.add('on');
      else if (otherCodes.has(code)) el.classList.add('other');
    });
  }

  // Conflict + validity evaluation, drives warning panel and Save button.
  function evaluate() {
    const warn = document.getElementById('warn');
    const wt = document.getElementById('warn-title');
    const wb = document.getElementById('warn-body');
    const wr = document.getElementById('warn-resolve');
    const saveBtn = document.getElementById('btn-save');
    const forceBox = document.getElementById('force');
    wr.innerHTML = '';
    warn.className = 'warn';

    // Nothing chosen yet.
    if (!pending || (!pending.code && !hasAnyModifier(pending))) {
      warn.classList.remove('show');
      saveBtn.disabled = true;
      return { blocked: true };
    }

    // Hard rule: need a real main key.
    if (!isValidBinding(pending)) {
      warn.classList.add('show', 'error');
      wt.textContent = '⚠ Not a complete shortcut';
      wb.textContent = 'Add a main key (a letter, number or arrow). Modifier keys alone can\'t be a shortcut.';
      saveBtn.disabled = true;
      return { blocked: true };
    }

    const owner = conflictingAction(pending, selectedAction);
    const reserved = reservedOwner(pending);
    const noMod = !hasAnyModifier(pending);

    // Hard conflict: another action already uses it (#7.10, #7.13).
    if (owner) {
      warn.classList.add('show', 'error');
      wt.textContent = '⛔ Conflict with another action';
      wb.innerHTML = 'This exact combo is already assigned to <b>' + owner.name + '</b>. Resolve it before saving:';

      const swap = document.createElement('button');
      swap.className = 'mini-btn accent';
      swap.textContent = 'Swap bindings with ' + owner.name;
      swap.addEventListener('click', () => swapWith(owner.id));
      wr.appendChild(swap);

      const un = document.createElement('button');
      un.className = 'mini-btn';
      un.textContent = 'Unassign ' + owner.name;
      un.addEventListener('click', () => unassignOther(owner.id));
      wr.appendChild(un);

      const pick = document.createElement('button');
      pick.className = 'mini-btn';
      pick.textContent = 'Pick a suggestion instead';
      pick.addEventListener('click', () => document.getElementById('suggest-block').scrollIntoView({ behavior: 'smooth' }));
      wr.appendChild(pick);

      saveBtn.disabled = true; // never allow duplicating another action's binding
      return { blocked: true };
    }

    // Soft conflicts: reserved combo and/or no modifier. Force can override (#7.14).
    if (reserved || noMod) {
      warn.classList.add('show', 'soft');
      wt.textContent = '⚠ Soft conflict';
      const msgs = [];
      if (reserved) msgs.push('This is a known shortcut for <b>' + reserved + '</b>.');
      if (noMod) msgs.push('It has no modifier key, so it may collide with YouTube\'s own single-key shortcuts.');
      msgs.push('Tick <b>Force shortcut</b> to save anyway, or try a suggestion below.');
      wb.innerHTML = msgs.join(' ');
      saveBtn.disabled = !forceBox.checked;
      return { blocked: !forceBox.checked, soft: true };
    }

    // All clear.
    warn.classList.add('show', 'good');
    wt.textContent = '✓ Looks good';
    wb.textContent = 'No conflicts detected. Test it, then save.';
    saveBtn.disabled = false;
    return { blocked: false };
  }

  // Offer up to two conflict-free alternatives (#7.12).
  function renderSuggestions() {
    const block = document.getElementById('suggest-block');
    const row = document.getElementById('suggest-row');
    row.innerHTML = '';

    // Only bother suggesting when there is a conflict/soft issue or nothing valid yet.
    const owner = pending && conflictingAction(pending, selectedAction);
    const reserved = pending && reservedOwner(pending);
    const noMod = pending && isValidBinding(pending) && !hasAnyModifier(pending);
    const show = !!(owner || reserved || noMod);
    block.style.display = show ? 'block' : 'none';
    if (!show) return;

    const candidates = buildSuggestionPool();
    let count = 0;
    for (const c of candidates) {
      if (count >= 3) break;
      if (conflictingAction(c, selectedAction)) continue;
      if (reservedOwner(c)) continue;
      const btn = document.createElement('button');
      btn.className = 'mini-btn accent';
      btn.textContent = bindingToText(c);
      btn.addEventListener('click', () => {
        pending = { ...c };
        tested = false;
        resetTestArea();
        renderEditor();
      });
      row.appendChild(btn);
      count++;
    }
    if (count === 0) {
      const none = document.createElement('span');
      none.style.cssText = 'font-size:11px;color:#666;';
      none.textContent = 'No free suggestions right now.';
      row.appendChild(none);
    }
  }

  // A pool of sensible, modifier-backed candidate combos.
  function buildSuggestionPool() {
    const base = layout === 'mac'
      ? { alt: true, ctrl: false, shift: true, meta: false }   // ⌥⇧
      : { alt: true, ctrl: false, shift: true, meta: false };  // Alt+Shift
    const codes = ['ArrowUp', 'ArrowDown', 'KeyR', 'Period', 'Comma', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash'];
    const pool = [];
    codes.forEach((code) => pool.push({ code, ...base }));
    // A second family with Ctrl+Alt as fallback.
    codes.forEach((code) => pool.push({ code, alt: true, ctrl: true, shift: false, meta: false }));
    return pool;
  }

  function renderSteps() {
    // Current step logic (#7.20).
    let current = 1;
    if (selectedAction) current = 2;
    if (selectedAction && isValidBinding(pending)) current = 3;
    const ev = pending ? evaluateQuiet() : { blocked: true };
    if (selectedAction && isValidBinding(pending) && !ev.hardConflict) current = 4;
    if (selectedAction && isValidBinding(pending) && !ev.blocked && tested) current = 5;

    document.querySelectorAll('#steps .step').forEach((el) => {
      const n = parseInt(el.dataset.step, 10);
      el.classList.remove('active', 'done');
      if (n < current) el.classList.add('done');
      else if (n === current) el.classList.add('active');
    });
  }

  // Lightweight conflict check for step logic (no DOM writes).
  function evaluateQuiet() {
    if (!isValidBinding(pending)) return { blocked: true, hardConflict: false };
    const owner = conflictingAction(pending, selectedAction);
    if (owner) return { blocked: true, hardConflict: true };
    const soft = reservedOwner(pending) || !hasAnyModifier(pending);
    const forced = document.getElementById('force').checked;
    return { blocked: soft && !forced, hardConflict: false };
  }

  function renderEditor() {
    document.getElementById('editor-empty').style.display = selectedAction ? 'none' : 'block';
    document.getElementById('editor-body').style.display = selectedAction ? 'block' : 'none';
    if (!selectedAction) { renderSteps(); return; }

    const a = ACTIONS.find((x) => x.id === selectedAction);
    document.getElementById('editing-name').textContent = a.name;
    document.getElementById('editing-desc').textContent = a.desc;

    renderChips();
    renderKeyboardState();
    evaluate();
    renderSuggestions();
    renderActions();
    renderSteps();
  }

  // ---- Selection & actions ----------------------------------------------

  function selectAction(id) {
    selectedAction = id;
    // Load current binding into the editor so it can be replaced (#7.8).
    const b = customShortcuts[id];
    pending = isValidBinding(b) ? { ...b } : { code: null, alt: false, ctrl: false, shift: false, meta: false };
    tested = false;
    document.getElementById('force').checked = false;
    resetTestArea();
    renderEditor();
  }

  function swapWith(otherId) {
    // Give the other action our (old) binding, take the pending for ourselves.
    const mine = customShortcuts[selectedAction] || null;
    customShortcuts[otherId] = isValidBinding(mine) ? { ...mine } : null;
    // pending stays as-is (it becomes ours on save); apply immediately in model.
    renderEditor();
  }

  function unassignOther(otherId) {
    customShortcuts[otherId] = null;
    renderEditor();
  }

  function resetTestArea() {
    const t = document.getElementById('test');
    if (!t) return;
    t.classList.remove('ok', 'fail');
    t.querySelector('.dt').textContent = '✅ Test it';
    t.querySelector('.dh').textContent = 'Click here and press your combo to verify';
  }

  // ---- Persistence & live apply (#7.15) ----------------------------------

  function persist(showNote) {
    chrome.storage.local.set({ customShortcuts }, () => {
      // Notify any open YouTube tabs so it applies live.
      try {
        chrome.tabs.query({ url: ['*://*.youtube.com/*'] }, (tabs) => {
          (tabs || []).forEach((t) => {
            try {
              const p = chrome.tabs.sendMessage(t.id, { type: 'SHORTCUTS_UPDATED', shortcuts: customShortcuts });
              if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (e) { /* tab without a content script — ignore */ }
          });
        });
      } catch (e) { /* tabs API unavailable — storage.onChanged still applies */ }
      if (showNote) flashSaveNote();
    });
  }

  function flashSaveNote() {
    const note = document.getElementById('save-note');
    note.classList.add('show');
    setTimeout(() => note.classList.remove('show'), 2600);
  }

  function saveShortcut() {
    if (!selectedAction || !isValidBinding(pending)) return;
    if (conflictingAction(pending, selectedAction)) return; // hard conflict guard
    const soft = reservedOwner(pending) || !hasAnyModifier(pending);
    if (soft && !document.getElementById('force').checked) return;

    customShortcuts[selectedAction] = { ...pending };
    persist(true);
    renderEditor();
  }

  function clearShortcut() {
    if (!selectedAction) return;
    customShortcuts[selectedAction] = null;
    pending = { code: null, alt: false, ctrl: false, shift: false, meta: false };
    tested = false;
    resetTestArea();
    persist(true);
    renderEditor();
  }

  function resetToDefaults() {
    customShortcuts = deepDefaults();
    if (selectedAction) selectAction(selectedAction);
    else renderEditor();
    persist(true);
  }

  function deepDefaults() {
    const out = {};
    for (const k of Object.keys(DEFAULT_SHORTCUTS)) {
      out[k] = DEFAULT_SHORTCUTS[k] ? { ...DEFAULT_SHORTCUTS[k] } : null;
    }
    return out;
  }

  // ---- Capture & Test areas (#7.6, #7.9) ---------------------------------

  function setupCapture() {
    const cap = document.getElementById('capture');
    cap.addEventListener('focus', () => cap.classList.add('focused'));
    cap.addEventListener('blur', () => cap.classList.remove('focused'));
    cap.addEventListener('keydown', (e) => {
      if (!selectedAction) return;
      // Ignore a lone modifier press — wait for the main key.
      if (isModifierCode(e.code)) return;
      e.preventDefault();
      pending = eventToBinding(e);
      tested = false;
      resetTestArea();
      renderEditor();
    });
  }

  function setupTest() {
    const test = document.getElementById('test');
    test.addEventListener('focus', () => test.classList.add('focused'));
    test.addEventListener('blur', () => test.classList.remove('focused'));
    test.addEventListener('keydown', (e) => {
      if (!isValidBinding(pending)) return;
      if (isModifierCode(e.code)) return;
      e.preventDefault();
      if (eventMatchesBinding(e, pending)) {
        tested = true;
        test.classList.remove('fail');
        test.classList.add('ok');
        test.querySelector('.dt').textContent = '✓ It works!';
        test.querySelector('.dh').textContent = 'That combo matches — ready to save.';
        flashKeyboard();
      } else {
        test.classList.remove('ok');
        test.classList.add('fail');
        test.querySelector('.dt').textContent = '✗ Not a match';
        test.querySelector('.dh').textContent = 'You pressed ' + bindingToText(eventToBinding(e)) + '. Try again.';
      }
      renderSteps();
    });
  }

  // Briefly light up the pending keys on the visual keyboard on a successful test.
  function flashKeyboard() {
    const on = document.querySelectorAll('#keyboard .key.on');
    on.forEach((el) => {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 450);
    });
  }

  // ---- Layout detection & switching (#7.3, #7.4) -------------------------

  function detectLayout() {
    try {
      const uaPlatform = (navigator.userAgentData && navigator.userAgentData.platform) || '';
      const plat = (uaPlatform || navigator.platform || navigator.userAgent || '').toLowerCase();
      if (plat.includes('mac')) return 'mac';
    } catch (e) { /* ignore */ }
    return 'win';
  }

  function setLayout(next) {
    layout = next;
    document.querySelectorAll('#layout-seg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.layout === next);
    });
    buildKeyboard();
    if (selectedAction) renderEditor();
  }

  // ---- Init --------------------------------------------------------------

  function load() {
    chrome.storage.local.get(['customShortcuts'], (res) => {
      const stored = res && res.customShortcuts;
      customShortcuts = deepDefaults();
      if (stored && typeof stored === 'object') {
        // Merge stored over defaults so any missing action falls back to default.
        for (const k of Object.keys(DEFAULT_SHORTCUTS)) {
          if (k in stored) {
            customShortcuts[k] = (stored[k] && typeof stored[k] === 'object') ? { ...stored[k] } : null;
          }
        }
      } else {
        // First run: seed storage from defaults so content.js and this page agree.
        persist(false);
      }
      renderActions();
      renderEditor();
    });
  }

  function wire() {
    document.getElementById('layout-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) setLayout(b.dataset.layout);
    });
    document.getElementById('btn-save').addEventListener('click', saveShortcut);
    document.getElementById('btn-clear').addEventListener('click', clearShortcut);
    document.getElementById('btn-reset-defaults').addEventListener('click', resetToDefaults);
    document.getElementById('force').addEventListener('change', () => { renderEditor(); });
    document.getElementById('os-shortcuts').addEventListener('click', () => {
      // chrome:// URLs can't be normal hrefs — open via the tabs API.
      try {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      } catch (e) { /* ignore */ }
    });
    setupCapture();
    setupTest();
  }

  function init() {
    layout = detectLayout();
    setLayout(layout);     // builds keyboard + marks the segmented control
    wire();
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
