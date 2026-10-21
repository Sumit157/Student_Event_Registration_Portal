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
    const toastEl = el('div', { class: `toast toast--${type}` }, [
      el('div', { class: 'grow', text: message }),
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

  function emptyState(title, message, icon = '📭') {
    return el('div', { class: 'state' }, [
      el('div', { class: 'state__icon', 'aria-hidden': 'true', text: icon }),
      el('h3', { text: title }),
      message ? el('p', { text: message }) : null,
    ]);
  }

  function errorState(message, onRetry) {
    const children = [
      el('div', { class: 'state__icon', 'aria-hidden': 'true', text: '⚠️' }),
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
    toast, loadingState, emptyState, errorState,
    renderFieldErrors, clearFieldErrors,
    confirmDialog, withButtonBusy,
    buildNavbar,
  };
})();
