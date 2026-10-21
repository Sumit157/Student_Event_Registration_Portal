'use strict';

/**
 * js/ui.js
 * Shared presentation helpers.
 *
 * SECURITY: this module never assigns user-supplied text via innerHTML.
 * el() builds nodes and sets text with textContent, so a name, bio or comment
 * containing markup is displayed literally rather than executed. That is the
 * client half of the stored-XSS defence (the server sanitises too).
 */

const UI = (() => {
  // -------------------------------------------------------------------------
  // Element building
  // -------------------------------------------------------------------------

  /**
   * Create an element.
   * @param {string} tag
   * @param {Object} [props]  `class`, `text`, `html` (trusted only!), attributes
   * @param {Array<Node|string>} [children]
   */
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value); // safe by construction
      else if (key === 'html') node.innerHTML = value;           // trusted constants ONLY
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, String(value));
    }

    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  /** Clear a container of all children. */
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /** Replace a container's contents with new children. */
  function replace(node, children) {
    clear(node);
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  /** `$("#id")` shorthand. */
  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $$(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  // -------------------------------------------------------------------------
  // Formatters
  // -------------------------------------------------------------------------

  /** "17 Oct 2026" in the viewer's own locale. */
  function formatDate(value) {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** "17 Oct 2026, 10:30 am". */
  function formatDateTime(value) {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  /** Short countdown phrase, or null when the date has passed. */
  function countdownParts(value) {
    const target = value instanceof Date ? value : new Date(value);
    const diff = target.getTime() - Date.now();
    if (Number.isNaN(target.getTime())) return null;
    if (diff <= 0) return null;
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return { days, hours, minutes, seconds, totalMs: diff };
  }

  /** "in 3d 4h" style label. */
  function countdownLabel(value) {
    const p = countdownParts(value);
    if (!p) return null;
    if (p.days > 0) return `starts in ${p.days}d ${p.hours}h`;
    if (p.hours > 0) return `starts in ${p.hours}h ${p.minutes}m`;
    if (p.minutes > 0) return `starts in ${p.minutes}m ${p.seconds}s`;
    return 'starting now';
  }

  /** Build "AV" style initials for an avatar placeholder. */
  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // -------------------------------------------------------------------------
  // Icons — one monoline SVG set for the whole portal.
  // Icons are drawn here (or in CSS) rather than typed as emoji, so their
  // weight and colour stay consistent with the typography everywhere.
  // -------------------------------------------------------------------------

  const ICON_PATHS = {
    ticket: '<path d="M3 9V7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5V9a2.5 2.5 0 0 0 0 6v1.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5V15a2.5 2.5 0 0 0 0-6Z"/><path d="M14 6.5v11" stroke-dasharray="2.2 2.6"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
    pin: '<path d="M12 21s6.8-6 6.8-10.5a6.8 6.8 0 1 0-13.6 0C5.2 15 12 21 12 21Z"/><circle cx="12" cy="10.3" r="2.4"/>',
    calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M7.5 3.5v4M16.5 3.5v4M3.5 10.5h17"/>',
    users: '<circle cx="9.2" cy="8.2" r="3.3"/><path d="M3 19.2a6.2 6.2 0 0 1 12.4 0"/><path d="M16.2 5.3a3.3 3.3 0 0 1 0 5.8M17.6 19.2a6.2 6.2 0 0 0-1.8-4.3"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 7"/>',
    checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.3 11 15l4.8-5.4"/>',
    clipboard: '<path d="M9.5 4.5h5M9.5 4.5a1.5 1.5 0 0 0-1.5 1.5v.5h8V6a1.5 1.5 0 0 0-1.5-1.5M7.5 6H6A1.5 1.5 0 0 0 4.5 7.5v11A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 18 6h-1.5M8.5 11h7M8.5 14.5h5"/>',
    briefcase: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6A1.5 1.5 0 0 1 10.5 4.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 12.5h17"/>',
    link: '<path d="M10.2 13.8a3.8 3.8 0 0 0 5.4 0l2.7-2.7a3.8 3.8 0 0 0-5.4-5.4l-1.3 1.3"/><path d="M13.8 10.2a3.8 3.8 0 0 0-5.4 0l-2.7 2.7a3.8 3.8 0 0 0 5.4 5.4l1.3-1.3"/>',
    news: '<path d="M18.5 6.5H20A1.5 1.5 0 0 1 21.5 8v10.5A1.5 1.5 0 0 1 20 20H5.5A2 2 0 0 1 3.5 18V6a1.5 1.5 0 0 1 1.5-1.5h2"/><path d="M7 9h9M7 12.5h9M7 16h5.5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 20.5 20.5"/>',
    alert: '<path d="M12 4.5 20.5 19.5h-17Z"/><path d="M12 10v4M12 16.7v.3"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4.5 8 7.5 5.2L19.5 8"/>',
    cap: '<path d="M3 9.5 12 5l9 4.5-9 4.5Z"/><path d="M7 11.7V16c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4.3"/>',
    message: '<path d="M20.5 12.2a7.4 7.4 0 0 1-10.7 6.6L4 20.5l1.7-5.6A7.4 7.4 0 1 1 20.5 12.2Z"/>',
    external: '<path d="M14 5h5v5M19 5l-8.5 8.5"/><path d="M17.5 14v4.5A1.5 1.5 0 0 1 16 20H6.5A1.5 1.5 0 0 1 5 18.5V9a1.5 1.5 0 0 1 1.5-1.5H11"/>',
    hourglass: '<path d="M7 4.5h10M7 19.5h10M8 4.5v3.2c0 1.3 4 3.2 4 4.3s-4 3-4 4.3v3.2M16 4.5v3.2c0 1.3-4 3.2-4 4.3s4 3 4 4.3v3.2"/>',
    inbox: '<path d="M3.5 13.5h4l1.5 3h6l1.5-3h4"/><path d="M6 4.5h12l3.5 9v5A1.5 1.5 0 0 1 20 20H5.5A1.5 1.5 0 0 1 4 18.5v-5Z"/>',
  };

  /**
   * Build a monoline icon node.
   * @param {string} name key of ICON_PATHS
   * @param {number} [size] px
   * @returns {SVGElement}
   */
  function icon(name, size = 20) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('width', String(size));
    node.setAttribute('height', String(size));
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.7');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    // Trusted constant strings from ICON_PATHS only — never user input.
    node.innerHTML = ICON_PATHS[name] || ICON_PATHS.inbox;
    return node;
  }

  /**
   * Thin capacity meter — makes availability legible at a glance.
   * Returns null when there is no usable capacity figure to draw.
   * @param {{capacity?:number, seatsRemaining?:number, taken?:number}} info
   * @returns {Node|null}
   */
  function seatMeter(info = {}) {
    const capacity = Number(info.capacity);
    if (!Number.isFinite(capacity) || capacity <= 0) return null;

    const remaining = Number(info.seatsRemaining);
    const explicitTaken = Number(info.taken);
    const taken = Number.isFinite(remaining)
      ? Math.max(0, capacity - Math.min(remaining, capacity))
      : (Number.isFinite(explicitTaken) ? Math.max(0, explicitTaken) : 0);

    const pct = Math.min(100, Math.round((taken / capacity) * 100));
    const tone = taken >= capacity ? 'full' : (capacity - taken <= 5 ? 'low' : '');

    return el('div', { class: 'seat-meter' }, [
      el('div', { class: 'seat-meter__track', 'aria-hidden': 'true' }, [
        el('div', { class: `seat-meter__fill${tone ? ` seat-meter__fill--${tone}` : ''}`, style: { width: `${pct}%` } }),
      ]),
      el('div', { class: 'seat-meter__label', text: `${taken} of ${capacity} seats taken` }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------

  let toastRegion = null;

  function ensureToastRegion() {
    if (toastRegion && document.body.contains(toastRegion)) return toastRegion;
    toastRegion = el('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastRegion);
    return toastRegion;
  }

  /**
   * Show a transient message.
   * @param {string} message
   * @param {'success'|'error'|'warning'|'info'} type
   * @param {number} [timeout]
   */
  function toast(message, type = 'info', timeout = 4500) {
    const region = ensureToastRegion();
    const typeIcon = { success: 'checkCircle', error: 'alert', warning: 'alert', info: 'message' }[type] || 'message';
    const toastEl = el('div', { class: `toast toast--${type}` }, [
      icon(typeIcon, 19),
      el('div', { class: 'toast__body grow', text: message }),
      el('button', {
        class: 'toast__close', type: 'button', 'aria-label': 'Dismiss message',
        onClick: () => toastEl.remove(),
      }, ['×']),
    ]);
    region.appendChild(toastEl);
    if (timeout > 0) setTimeout(() => toastEl.remove(), timeout);
    return toastEl;
  }

  // -------------------------------------------------------------------------
  // Inline states: loading / empty / error blocks inside a container
  // -------------------------------------------------------------------------

  function loadingState(message = 'Loading…') {
    return el('div', { class: 'state' }, [
      el('div', { class: 'spinner', 'aria-hidden': 'true' }),
      el('p', { text: message }),
    ]);
  }

  /**
   * Empty-state block.
   * The third argument is an icon key (see ICON_PATHS); older call sites that
   * still pass an emoji simply fall back to the generic "inbox" mark.
   */
  function emptyState(title, message, iconName = 'inbox') {
    return el('div', { class: 'state' }, [
      el('div', { class: 'state__icon', 'aria-hidden': 'true' }, [icon(iconName, 24)]),
      el('h3', { text: title }),
      message ? el('p', { text: message }) : null,
    ]);
  }

  function errorState(message, onRetry) {
    const children = [
      el('div', { class: 'state__icon state__icon--danger', 'aria-hidden': 'true' }, [icon('alert', 24)]),
      el('h3', { text: 'Something went wrong' }),
      el('p', { text: message }),
    ];
    if (onRetry) {
      children.push(el('button', { class: 'btn btn--primary', type: 'button', onClick: onRetry, text: 'Try again' }));
    }
    return el('div', { class: 'state' }, children);
  }

  /** Render a server-side field validation error list under a form. */
  function renderFieldErrors(form, error) {
    clearFieldErrors(form);
    if (!error || !error.details || !Array.isArray(error.details)) return;

    for (const detail of error.details) {
      const input = form.querySelector(`[name="${CSS.escape(detail.field)}"]`);
      if (!input) continue;
      input.setAttribute('aria-invalid', 'true');
      const field = input.closest('.field');
      if (field) {
        const slot = field.querySelector('.field__error');
        if (slot) slot.textContent = detail.message;
        else field.appendChild(el('p', { class: 'field__error', text: detail.message }));
      }
    }
    // Move focus to the first problem so keyboard users land on it.
    const firstInvalid = form.querySelector('[aria-invalid="true"]');
    if (firstInvalid) firstInvalid.focus();
  }

  function clearFieldErrors(form) {
    if (!form) return;
    $$('[aria-invalid]', form).forEach((node) => node.removeAttribute('aria-invalid'));
    $$('.field__error', form).forEach((node) => { node.textContent = ''; });
  }

  // -------------------------------------------------------------------------
  // Modal dialog (focus trapped, Escape closes)
  // -------------------------------------------------------------------------

  /**
   * Open a confirmation dialog.
   * @param {{title:string, body?:Node|string, confirmLabel?:string, cancelLabel?:string,
   *          danger?:boolean, onConfirm?:Function}} options
   * @returns {Promise<boolean>} resolves true when confirmed
   */
  function confirmDialog(options) {
    const {
      title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
      danger = false, onConfirm = null,
    } = options;

    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      let settled = false;

      const confirmBtn = el('button', {
        class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, type: 'button',
      }, [confirmLabel]);
      const cancelBtn = el('button', { class: 'btn btn--secondary', type: 'button', text: cancelLabel });

      const dialog = el('div', {
        class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title',
      }, [
        el('h2', { class: 'modal__title', id: 'modal-title', text: title }),
        typeof body === 'string' ? el('p', { text: body }) : body,
        el('div', { class: 'modal__actions' }, [cancelBtn, confirmBtn]),
      ]);

      const backdrop = el('div', { class: 'modal-backdrop' }, [dialog]);

      function close(result) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeydown, true);
        backdrop.remove();
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
        resolve(result);
      }

      function onKeydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); close(false); return; }
        if (event.key !== 'Tab') return;
        // Keep focus inside the dialog while it is open.
        const focusables = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }

      cancelBtn.addEventListener('click', () => close(false));
      confirmBtn.addEventListener('click', async () => {
        if (onConfirm) {
          confirmBtn.disabled = true;
          try {
            const ok = await onConfirm();
            if (ok === false) { confirmBtn.disabled = false; return; } // stay open on failure
          } catch (_) {
            confirmBtn.disabled = false;
            return;
          }
        }
        close(true);
      });
      backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop) close(false);
      });

      document.addEventListener('keydown', onKeydown, true);
      document.body.appendChild(backdrop);
      confirmBtn.focus();
    });
  }

  /** Disable a button and show a spinner label while a request is in flight. */
  function withButtonBusy(button, label = 'Working…') {
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = label;
    button.setAttribute('aria-busy', 'true');
    return function restore() {
      button.disabled = false;
      button.innerHTML = original;
      button.removeAttribute('aria-busy');
    };
  }

  /** Build the shared site navbar. Returns the element (caller appends it). */
  function buildNavbar(activeKey) {
    const links = [
      { key: 'home', href: '/index.html', label: 'Home', public: true },
      { key: 'events', href: '/events.html', label: 'Events', public: true },
      { key: 'news', href: '/news.html', label: 'News', public: true },
      { key: 'alumni', href: '/alumni-directory.html', label: 'Alumni', public: true },
      { key: 'jobs', href: '/jobs.html', label: 'Jobs', public: true },
    ];

    const nav = el('nav', { class: 'navbar__nav', id: 'primary-nav', 'aria-label': 'Primary' });
    for (const link of links) {
      nav.appendChild(el('a', {
        class: `navbar__link${activeKey === link.key ? ' is-active' : ''}`,
        href: link.href,
        'aria-current': activeKey === link.key ? 'page' : null,
        text: link.label,
      }));
    }
    return nav;
  }

  return {
    el, clear, replace, $, $$,
    formatDate, formatDateTime, countdownParts, countdownLabel, initials,
    icon, seatMeter,
    toast, loadingState, emptyState, errorState,
    renderFieldErrors, clearFieldErrors,
    confirmDialog, withButtonBusy,
    buildNavbar,
  };
})();
