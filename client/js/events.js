'use strict';

/**
 * js/events.js
 * Event discovery, detail view, registration / cancellation and the
 * "My Registrations" screen. (Front half of assignment Task 4.)
 *
 * All rendering goes through UI.el() with textContent, so a title such as
 * `<img onerror=...>` displays as literal text rather than executing.
 */

const Events = (() => {
  const PAGE_SIZE = 10; // required by the assignment

  // -------------------------------------------------------------------------
  // Shared card renderer
  // -------------------------------------------------------------------------

  /** Human friendly category slug used to pick the banner gradient. */
  function categoryKey(category) {
    const value = String(category || 'general').toLowerCase();
    if (value.includes('workshop') || value.includes('tech')) return 'workshop';
    if (value.includes('cultur') || value.includes('fest')) return 'cultural';
    if (value.includes('sport')) return 'sports';
    if (value.includes('career') || value.includes('placement') || value.includes('network')) return 'career';
    return 'general';
  }

  /** Seat counter with colour + wording (never colour alone). */
  function seatsLabel(event) {
    const remaining = event.seatsRemaining;
    if (remaining === undefined || remaining === null) return null;
    if (remaining <= 0) {
      const waitlisted = event.waitlistedCount || 0;
      return UI.el('span', {
        class: 'seats seats--full',
        text: waitlisted > 0 ? `Full · ${waitlisted} waiting` : 'Full',
      });
    }
    if (remaining <= 5) {
      return UI.el('span', { class: 'seats seats--low', text: `Only ${remaining} seat${remaining === 1 ? '' : 's'} left` });
    }
    return UI.el('span', { class: 'seats seats--available', text: `${remaining} seats left` });
  }

  /** Live countdown chip. Returns null once the event has started. */
  function countdownChip(eventDate) {
    const label = UI.countdownLabel(eventDate);
    if (!label) return null;
    return UI.el('span', { class: 'countdown', text: `⏳ ${label}` });
  }

  /**
   * Render one event card.
   * @param {Object} event
   * @param {{onRegister?:Function, onOpen?:Function, actionLabel?:string, disableAction?:boolean}} [options]
   */
  function renderEventCard(event, options = {}) {
    const date = new Date(event.eventDate);
    const day = Number.isNaN(date.getTime()) ? '--' : date.getDate();
    const month = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short' });

    const banner = UI.el('div', { class: `event-card__banner event-card__banner--${categoryKey(event.category)}` }, [
      UI.el('div', { class: 'event-card__date-chip' }, [
        UI.el('div', { class: 'd', text: String(day) }),
        UI.el('div', { class: 'm', text: month }),
      ]),
      UI.el('span', { class: 'badge badge--neutral', text: event.category || 'general' }),
    ]);

    const meta = UI.el('div', { class: 'stack-sm' }, [
      UI.el('p', { class: 'event-card__meta', text: `🕐 ${UI.formatDateTime(event.eventDate)}` }),
      event.venue ? UI.el('p', { class: 'event-card__meta', text: `📍 ${event.venue}` }) : null,
      countdownChip(event.eventDate),
    ]);

    const footerChildren = [seatsLabel(event)];
    const openLink = UI.el('a', { class: 'btn btn--ghost btn--sm', href: `/event-detail.html?id=${event.id}`, text: 'Details' });
    footerChildren.push(openLink);

    if (options.actionLabel) {
      const action = UI.el('button', {
        class: `btn btn--sm ${options.dangerAction ? 'btn--danger' : 'btn--primary'}`,
        type: 'button',
        text: options.actionLabel,
        disabled: options.disableAction ? 'disabled' : null,
      });
      if (options.onRegister) {
        action.addEventListener('click', () => options.onRegister(event, action));
      }
      footerChildren.push(action);
    }

    return UI.el('article', { class: 'event-card' }, [
      banner,
      UI.el('div', { class: 'event-card__body' }, [
        UI.el('h3', { class: 'event-card__title' }, [
          UI.el('a', { href: `/event-detail.html?id=${event.id}`, text: event.title }),
        ]),
        UI.el('p', {
          class: 'alumni-card__bio',
          text: event.description ? String(event.description).slice(0, 110) + (event.description.length > 110 ? '…' : '') : 'No description provided.',
        }),
        meta,
        UI.el('div', { class: 'event-card__footer' }, footerChildren),
      ]),
    ]);
  }

  // -------------------------------------------------------------------------
  // Events listing page
  // -------------------------------------------------------------------------

  async function initEventsPage() {
    const grid = document.getElementById('events-grid');
    const paginationSlot = document.getElementById('events-pagination');
    if (!grid) return;

    const state = { page: 1, q: '', category: '', from: '', to: '' };

    // Populate the category filter from the API.
    try {
      const body = await Api.get('/events/categories', { auth: false });
      const select = document.getElementById('filter-category');
      if (select && body.data.categories) {
        for (const item of body.data.categories) {
          select.appendChild(UI.el('option', { value: item.category, text: `${item.category} (${item.count})` }));
        }
      }
    } catch (_) { /* filter simply stays empty */ }

    async function load() {
      UI.replace(grid, UI.loadingState('Loading events…'));
      UI.clear(paginationSlot);

      const params = new URLSearchParams({ page: String(state.page), pageSize: String(PAGE_SIZE) });
      if (state.q) params.set('q', state.q);
      if (state.category) params.set('category', state.category);
      if (state.from) params.set('from', `${state.from}T00:00:00`);
      if (state.to) params.set('to', `${state.to}T23:59:59`);

      try {
        const body = await Api.get(`/events?${params.toString()}`, { auth: false });
        const { events, pagination } = body.data;

        if (!events || events.length === 0) {
          UI.replace(grid, UI.emptyState(
            'No events found',
            state.q || state.category || state.from || state.to
              ? 'Try clearing the filters or searching for something else.'
              : 'Check back soon - new events are published regularly.',
            '📅'
          ));
          return;
        }

        UI.replace(grid, events.map((event) => renderEventCard(event)));
        renderPagination(paginationSlot, pagination, (page) => {
          state.page = page;
          load();
          grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      } catch (error) {
        UI.replace(grid, UI.errorState(error.message, load));
      }
    }

    // Filter form wiring.
    const filterForm = document.getElementById('events-filters');
    if (filterForm) {
      filterForm.addEventListener('submit', (event) => {
        event.preventDefault();
        state.q = filterForm.q.value.trim();
        state.category = filterForm.category.value;
        state.from = filterForm.from.value;
        state.to = filterForm.to.value;
        state.page = 1;
        load();
      });
      const clearBtn = document.getElementById('filters-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          filterForm.reset();
          state.q = ''; state.category = ''; state.from = ''; state.to = ''; state.page = 1;
          load();
        });
      }
    }

    load();
  }

  /** Shared pagination renderer. */
  function renderPagination(slot, pagination, onChange) {
    UI.clear(slot);
    if (!pagination || pagination.totalPages <= 1) return;

    const nav = UI.el('nav', { class: 'pagination', 'aria-label': 'Pagination' });

    nav.appendChild(UI.el('button', {
      class: 'page-btn', type: 'button', text: '‹ Prev',
      disabled: !pagination.hasPrev ? 'disabled' : null,
      'aria-label': 'Previous page',
      onClick: () => onChange(pagination.page - 1),
    }));

    // Window of page numbers around the current one.
    const start = Math.max(1, pagination.page - 2);
    const end = Math.min(pagination.totalPages, pagination.page + 2);
    if (start > 1) {
      nav.appendChild(UI.el('button', { class: 'page-btn', type: 'button', text: '1', onClick: () => onChange(1) }));
      if (start > 2) nav.appendChild(UI.el('span', { class: 'pagination__info', text: '…' }));
    }
    for (let page = start; page <= end; page += 1) {
      nav.appendChild(UI.el('button', {
        class: `page-btn${page === pagination.page ? ' is-current' : ''}`,
        type: 'button', text: String(page),
        'aria-current': page === pagination.page ? 'page' : null,
        'aria-label': `Page ${page}`,
        onClick: () => { if (page !== pagination.page) onChange(page); },
      }));
    }
    if (end < pagination.totalPages) {
      if (end < pagination.totalPages - 1) nav.appendChild(UI.el('span', { class: 'pagination__info', text: '…' }));
      nav.appendChild(UI.el('button', {
        class: 'page-btn', type: 'button', text: String(pagination.totalPages),
        onClick: () => onChange(pagination.totalPages),
      }));
    }

    nav.appendChild(UI.el('button', {
      class: 'page-btn', type: 'button', text: 'Next ›',
      disabled: !pagination.hasNext ? 'disabled' : null,
      'aria-label': 'Next page',
      onClick: () => onChange(pagination.page + 1),
    }));

    nav.appendChild(UI.el('span', {
      class: 'pagination__info',
      text: `Page ${pagination.page} of ${pagination.totalPages} · ${pagination.total} event${pagination.total === 1 ? '' : 's'}`,
    }));

    slot.appendChild(nav);
  }

  // -------------------------------------------------------------------------
  // Event detail page
  // -------------------------------------------------------------------------

  async function initEventDetailPage() {
    const slot = document.getElementById('event-detail');
    if (!slot) return;

    const id = new URLSearchParams(window.location.search).get('id');
    if (!id || !/^\d+$/.test(id)) {
      UI.replace(slot, UI.errorState('That event link is not valid.', () => { window.location.href = '/events.html'; }));
      return;
    }

    UI.replace(slot, UI.loadingState('Loading event…'));

    // We need a user to know whether they are already registered.
    const user = await Auth.init();

    async function load() {
      try {
        const body = await Api.get(`/events/${id}`, { auth: Boolean(user) });
        const event = body.data.event;
        renderDetail(slot, event, user, load);
      } catch (error) {
        if (error.status === 404) {
          UI.replace(slot, UI.el('div', { class: 'state' }, [
            UI.el('div', { class: 'state__icon', text: '🔍' }),
            UI.el('h3', { text: 'Event not found' }),
            UI.el('p', { text: 'This event may have been removed or the link is incorrect.' }),
            UI.el('a', { class: 'btn btn--primary', href: '/events.html', text: 'Browse all events' }),
          ]));
          return;
        }
        UI.replace(slot, UI.errorState(error.message, load));
      }
    }

    load();

    // Live countdown ticker.
    setInterval(() => {
      const chip = document.getElementById('detail-countdown');
      if (!chip) return;
      const target = chip.dataset.date;
      const label = UI.countdownLabel(target);
      if (label) chip.textContent = `⏳ ${label}`;
      else {
        chip.textContent = '🔴 In progress / started';
        chip.classList.add('is-live');
      }
    }, 1000);
  }

  function renderDetail(slot, event, user, reload) {
    UI.clear(slot);

    const info = event.capacityInfo || {};
    const myReg = event.myRegistration;

    // ---- capacity summary ----
    const capacityBox = UI.el('div', { class: 'card' }, [
      UI.el('h2', { class: 'card__title', text: 'Availability' }),
      UI.el('div', { class: 'stack-sm' }, [
        UI.el('p', { text: `${info.confirmed || 0} of ${event.capacity} seats taken` }),
        UI.el('div', { class: 'seats' }, [seatsLabel({ ...event, seatsRemaining: info.seatsRemaining }) || UI.el('span', { text: '—' })]),
        info.waitlisted > 0 ? UI.el('p', { class: 'field__hint', text: `${info.waitlisted} student(s) currently waitlisted.` }) : null,
      ]),
    ]);

    // ---- action area ----
    const actionArea = UI.el('div', { class: 'stack-sm' });

    if (!user) {
      actionArea.appendChild(UI.el('p', { class: 'field__hint', text: 'Sign in with a student account to register for this event.' }));
      actionArea.appendChild(UI.el('a', { class: 'btn btn--primary btn--block', href: `/login.html?returnTo=/event-detail.html?id=${event.id}`, text: 'Sign in to register' }));
    } else if (user.role !== 'student') {
      actionArea.appendChild(UI.el('p', { class: 'field__hint', text: `Only student accounts can register for events. You are signed in as ${user.role}.` }));
    } else if (myReg && myReg.status !== 'cancelled') {
      const badge = statusBadge(myReg.status);
      actionArea.appendChild(UI.el('div', { class: 'row' }, [
        UI.el('span', { text: 'Your registration:' }), badge,
      ]));
      if (myReg.status === 'waitlisted') {
        actionArea.appendChild(UI.el('p', { class: 'field__hint', text: `You are number ${myReg.waitlistPosition} in the queue.` }));
      }
      const cancelBtn = UI.el('button', { class: 'btn btn--danger btn--block', type: 'button', text: 'Cancel my registration' });
      cancelBtn.addEventListener('click', () => confirmAndCancel(event, cancelBtn, reload));
      actionArea.appendChild(cancelBtn);
    } else {
      const registerBtn = UI.el('button', {
        class: 'btn btn--primary btn--block',
        type: 'button',
        text: info.isFull ? 'Join the waitlist' : 'Register for this event',
      });
      registerBtn.addEventListener('click', () => doRegister(event, registerBtn, reload));
      actionArea.appendChild(registerBtn);
      if (myReg && myReg.status === 'cancelled') {
        actionArea.appendChild(UI.el('p', { class: 'field__hint', text: 'You had previously cancelled your place for this event.' }));
      }
    }

    // ---- main layout ----
    const main = UI.el('div', { class: 'card stack' }, [
      UI.el('div', { class: 'row row--between' }, [
        UI.el('span', { class: 'badge badge--role', text: event.category || 'general' }),
        UI.el('span', {
          class: 'countdown',
          id: 'detail-countdown',
          dataset: { date: event.eventDate || '' },
          text: UI.countdownLabel(event.eventDate) ? `⏳ ${UI.countdownLabel(event.eventDate)}` : '🔴 Started',
        }),
      ]),
      UI.el('h1', { text: event.title }),
      UI.el('div', { class: 'stack-sm' }, [
        UI.el('p', { class: 'event-card__meta', text: `🕐 ${UI.formatDateTime(event.eventDate)}${event.endDate ? `  →  ${UI.formatDateTime(event.endDate)}` : ''}` }),
        event.venue ? UI.el('p', { class: 'event-card__meta', text: `📍 ${event.venue}` }) : null,
        event.createdBy ? UI.el('p', { class: 'event-card__meta', text: `Organised by ${event.createdBy}` }) : null,
      ]),
      UI.el('div', { class: 'alert alert--info' }, [
        UI.el('div', { class: 'grow', text: event.description || 'No further details were provided for this event.' }),
      ]),
    ]);

    slot.appendChild(UI.el('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)' } }, [
      main,
      UI.el('div', { class: 'stack' }, [capacityBox, UI.el('div', { class: 'card' }, [UI.el('h2', { class: 'card__title', text: 'Actions' }), actionArea])]),
    ]));
  }

  /** Status pill used across the portal. */
  function statusBadge(status) {
    const map = {
      confirmed: ['badge--confirmed', '✓ Confirmed'],
      waitlisted: ['badge--waitlisted', '⏳ Waitlisted'],
      cancelled: ['badge--cancelled', '✕ Cancelled'],
    };
    const [className, label] = map[status] || ['badge--neutral', status];
    return UI.el('span', { class: `badge ${className}`, text: label });
  }

  async function doRegister(event, button, reload) {
    const restore = UI.withButtonBusy(button, 'Registering…');
    try {
      const body = await Api.post(`/events/${event.id}/register`, {});
      UI.toast(body.message, body.data.status === 'confirmed' ? 'success' : 'warning');
      if (typeof reload === 'function') reload();
    } catch (error) {
      UI.toast(error.message, 'error');
      restore();
    }
  }

  async function confirmAndCancel(event, button, reload) {
    const confirmed = await UI.confirmDialog({
      title: 'Cancel your registration?',
      body: `Your place at "${event.title}" will be released. If you are later re-registered you may lose your waitlist position.`,
      confirmLabel: 'Yes, cancel it',
      danger: true,
    });
    if (!confirmed) return;

    const restore = UI.withButtonBusy(button, 'Cancelling…');
    try {
      const body = await Api.post(`/events/${event.id}/cancel`, {});
      UI.toast(body.message, 'success');
      if (typeof reload === 'function') reload();
      else window.location.reload();
    } catch (error) {
      UI.toast(error.message, 'error');
      restore();
    }
  }

  // -------------------------------------------------------------------------
  // My registrations page
  // -------------------------------------------------------------------------

  async function initMyRegistrationsPage() {
    const slot = document.getElementById('registrations-list');
    const tabsSlot = document.getElementById('registrations-tabs');
    if (!slot) return;

    const user = await Auth.requireRole(['student']);
    if (!user) return;

    let filter = 'active';

    async function load() {
      UI.replace(slot, UI.loadingState('Loading your registrations…'));

      try {
        const body = await Api.get('/events/me/registrations');
        let rows = body.data.registrations || [];

        if (filter === 'active') rows = rows.filter((r) => r.status !== 'cancelled');
        else if (filter === 'upcoming') rows = rows.filter((r) => r.status !== 'cancelled' && new Date(r.event.eventDate) >= new Date());
        else if (filter === 'past') rows = rows.filter((r) => new Date(r.event.eventDate) < new Date());

        if (rows.length === 0) {
          UI.replace(slot, UI.emptyState(
            'Nothing here yet',
            filter === 'active'
              ? 'You have no active registrations. Browse the events list to find something to join.'
              : 'No registrations match this filter.',
            '🎟️'
          ));
          slot.appendChild(UI.el('a', { class: 'btn btn--primary', href: '/events.html', text: 'Browse events' }));
          return;
        }

        UI.replace(slot, rows.map((row) => renderRegistrationRow(row, load)));
      } catch (error) {
        UI.replace(slot, UI.errorState(error.message, load));
      }
    }

    // Tab strip
    const tabs = [
      { key: 'active', label: 'Active' },
      { key: 'upcoming', label: 'Upcoming' },
      { key: 'past', label: 'Past' },
      { key: 'all', label: 'All' },
    ];
    UI.replace(tabsSlot, UI.el('div', { class: 'tabs', role: 'tablist' }, tabs.map((tab) => {
      const button = UI.el('button', {
        class: 'tab', type: 'button', role: 'tab', text: tab.label,
        'aria-selected': String(tab.key === filter),
      });
      button.addEventListener('click', () => {
        filter = tab.key;
        tabsSlot.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', 'false'));
        button.setAttribute('aria-selected', 'true');
        load();
      });
      return button;
    })));

    load();
  }

  function renderRegistrationRow(row, reload) {
    const event = row.event;
    const cancelled = row.status === 'cancelled';

    const actionArea = UI.el('div', { class: 'row row--end' });
    if (!cancelled) {
      const cancelBtn = UI.el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Cancel' });
      cancelBtn.addEventListener('click', async () => {
        const ok = await UI.confirmDialog({
          title: 'Cancel registration?',
          body: `Release your place at "${event.title}"?`,
          confirmLabel: 'Cancel registration',
          danger: true,
        });
        if (!ok) return;
        const restore = UI.withButtonBusy(cancelBtn, 'Cancelling…');
        try {
          const body = await Api.post(`/events/${event.id}/cancel`, {});
          UI.toast(body.message, 'success');
          reload();
        } catch (error) {
          UI.toast(error.message, 'error');
          restore();
        }
      });
      actionArea.appendChild(cancelBtn);
    }
    actionArea.appendChild(UI.el('a', { class: 'btn btn--ghost btn--sm', href: `/event-detail.html?id=${event.id}`, text: 'View' }));

    return UI.el('article', { class: 'card' }, [
      UI.el('div', { class: 'row row--between' }, [
        UI.el('div', { class: 'grow' }, [
          UI.el('h3', { class: 'card__title', text: event.title }),
          UI.el('p', { class: 'event-card__meta', text: `🕐 ${UI.formatDateTime(event.eventDate)}` }),
          event.venue ? UI.el('p', { class: 'event-card__meta', text: `📍 ${event.venue}` }) : null,
        ]),
        UI.el('div', { class: 'stack-sm', style: { alignItems: 'flex-end' } }, [
          statusBadge(row.status),
          row.status === 'waitlisted' && row.waitlistPosition
            ? UI.el('span', { class: 'field__hint', text: `Position ${row.waitlistPosition} in queue` })
            : null,
          row.cancelledAt ? UI.el('span', { class: 'field__hint', text: `Cancelled ${UI.formatDateTime(row.cancelledAt)}` })
            : UI.el('span', { class: 'field__hint', text: `Registered ${UI.formatDateTime(row.registeredAt)}` }),
        ]),
      ]),
      UI.el('div', { class: 'row row--between', style: { marginTop: '12px' } }, [
        UI.el('span', { class: 'seats', text: row.seatsRemaining === 0 ? 'Event is full' : `${row.seatsRemaining} seat(s) remaining` }),
        actionArea,
      ]),
    ]);
  }

  return {
    initEventsPage, initEventDetailPage, initMyRegistrationsPage,
    renderEventCard, statusBadge, renderPagination,
  };
})();
