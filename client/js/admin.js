'use strict';

/**
 * js/admin.js
 * Administrator dashboard. (Front half of Task 6.)
 *
 * NOTE: hiding these controls is only a usability choice - the server re-checks
 * the administrator role on every /api/admin request. A student who types the
 * URL into the address bar sees a 403, not this screen.
 */

const Admin = (() => {
  /** Which tab section is visible. */
  function showTab(name) {
    UI.$$('[data-tab]').forEach((section) => {
      const active = section.dataset.tab === name;
      section.hidden = !active;
    });
    UI.$$('[role="tab"]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.target === name));
    });
  }

  async function initAdminPage() {
    const user = await Auth.requireRole(['admin']);
    if (!user) return;

    // ---- tab strip wiring ----
    const tabs = document.getElementById('admin-tabs');
    tabs.addEventListener('click', (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (!tab) return;
      showTab(tab.dataset.target);
    });

    // Load every section in parallel - they are independent.
    await Promise.all([
      loadStats(),
      loadEvents(),
      loadUsers(),
      loadPendingAlumni(),
      loadRegistrations(),
      loadEventOptions(),
    ]);

    wireEventForm();
    wireUserFilters();
    wireRegistrationFilters();
    wireExport();
    wireNewsForm();
  }

  // =========================================================================
  // Statistics
  // =========================================================================

  async function loadStats() {
    const slot = document.getElementById('admin-stats');
    UI.replace(slot, UI.loadingState('Loading dashboard…'));
    try {
      const body = await Api.get('/admin/stats');
      const s = body.data;

      const tiles = [
        { label: 'Total users', value: s.users.total, hint: `${s.users.students} students · ${s.users.alumni} alumni` },
        { label: 'Total events', value: s.events.total, hint: `${s.events.upcoming} upcoming` },
        { label: 'Confirmed registrations', value: s.registrations.confirmed, hint: `${s.registrations.waitlisted} waitlisted` },
        { label: 'Approved alumni', value: s.alumni.approved, hint: `${s.alumni.pending} awaiting approval` },
        { label: 'Active jobs', value: s.jobs.active, hint: `${s.jobs.total} posted in total` },
        { label: 'Suspended accounts', value: s.users.suspended, hint: `${s.users.admins} administrator(s)` },
      ];

      UI.replace(slot, tiles.map((tile) => UI.el('div', { class: 'stat' }, [
        UI.el('div', { class: 'stat__label', text: tile.label }),
        UI.el('div', { class: 'stat__value', text: String(tile.value) }),
        UI.el('div', { class: 'stat__hint', text: tile.hint }),
      ])));

      // Upcoming events table
      const upcoming = document.getElementById('upcoming-events');
      if (upcoming) {
        if (s.upcomingEvents.length === 0) {
          UI.replace(upcoming, UI.el('p', { class: 'field__hint', text: 'No upcoming events.' }));
        } else {
          UI.replace(upcoming, buildTable(
            ['Event', 'Date', 'Capacity', 'Confirmed', 'Waitlist', 'Seats left'],
            s.upcomingEvents.map((e) => [
              e.title,
              UI.formatDateTime(e.eventDate),
              String(e.capacity),
              String(e.confirmed),
              String(e.waitlisted),
              UI.el('span', {
                class: e.seatsRemaining === 0 ? 'seats seats--full' : 'seats seats--available',
                text: String(e.seatsRemaining),
              }),
            ])
          ));
        }
      }
    } catch (error) {
      UI.replace(slot, UI.errorState(error.message, loadStats));
    }
  }

  // =========================================================================
  // Event management
  // =========================================================================

  let editingEventId = null;

  async function loadEventOptions() {
    const select = document.getElementById('report-event-filter');
    if (!select || select.dataset.loaded) return;
    select.dataset.loaded = '1';
    try {
      // Ask for plenty of pages worth of events so the selector is useful.
      const body = await Api.get('/events?pageSize=50&includePast=true', { auth: false });
      for (const event of body.data.events) {
        select.appendChild(UI.el('option', { value: event.id, text: event.title }));
      }
    } catch (_) { /* selector stays empty */ }
  }

  async function loadEvents() {
    const slot = document.getElementById('events-table');
    UI.replace(slot, UI.loadingState('Loading events…'));
    try {
      const body = await Api.get('/events?pageSize=50&includePast=true', { auth: false });
      const events = body.data.events;

      if (events.length === 0) {
        UI.replace(slot, UI.emptyState('No events yet', 'Create the first event using the form above.', '📅'));
        return;
      }

      UI.replace(slot, buildTable(
        ['Title', 'Date', 'Category', 'Capacity', 'Confirmed', 'Seats', 'Actions'],
        events.map((event) => {
          const editBtn = UI.el('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Edit' });
          editBtn.addEventListener('click', () => startEditEvent(event));

          const notifyBtn = UI.el('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Notify' });
          notifyBtn.addEventListener('click', () => openNotifyDialog(event));

          const deleteBtn = UI.el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Delete' });
          deleteBtn.addEventListener('click', async () => {
            const ok = await UI.confirmDialog({
              title: 'Delete event?',
              body: `"${event.title}" will be removed from all public listings. Existing registration records are kept for reporting.`,
              confirmLabel: 'Delete event',
              danger: true,
              onConfirm: async () => {
                await Api.del(`/admin/events/${event.id}`);
                return true;
              },
            });
            if (ok) { UI.toast('Event removed.', 'success'); loadEvents(); loadStats(); }
          });

          return [
            UI.el('a', { href: `/event-detail.html?id=${event.id}`, text: event.title }),
            UI.formatDateTime(event.eventDate),
            event.category,
            String(event.capacity),
            String(event.confirmedCount || 0),
            UI.el('span', {
              class: (event.seatsRemaining || 0) === 0 ? 'seats seats--full' : 'seats seats--available',
              text: String(event.seatsRemaining ?? 0),
            }),
            UI.el('div', { class: 'row', style: { gap: '6px' } }, [editBtn, notifyBtn, deleteBtn]),
          ];
        })
      ));
    } catch (error) {
      UI.replace(slot, UI.errorState(error.message, loadEvents));
    }
  }

  function startEditEvent(event) {
    const form = document.getElementById('event-form');
    editingEventId = event.id;
    form.title.value = event.title;
    form.category.value = event.category;
    form.venue.value = event.venue || '';
    form.description.value = event.description || '';
    form.capacity.value = event.capacity;
    form.eventDate.value = toLocalInputValue(event.eventDate);
    form.endDate.value = event.endDate ? toLocalInputValue(event.endDate) : '';
    document.getElementById('event-form-heading').textContent = `Editing: ${event.title}`;
    document.getElementById('event-form-cancel').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.title.focus();
  }

  function resetEventForm() {
    const form = document.getElementById('event-form');
    form.reset();
    editingEventId = null;
    document.getElementById('event-form-heading').textContent = 'Create a new event';
    document.getElementById('event-form-cancel').hidden = true;
    UI.clearFieldErrors(form);
  }

  function wireEventForm() {
    const form = document.getElementById('event-form');
    if (!form) return;

    document.getElementById('event-form-cancel').addEventListener('click', resetEventForm);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);

      const payload = {
        title: form.title.value.trim(),
        category: form.category.value.trim() || 'general',
        venue: form.venue.value.trim(),
        description: form.description.value.trim(),
        capacity: Number(form.capacity.value),
        eventDate: toUtcPayload(form.eventDate.value),
        endDate: form.endDate.value ? toUtcPayload(form.endDate.value) : null,
      };

      const submit = form.querySelector('[type="submit"]');
      const restore = UI.withButtonBusy(submit, editingEventId ? 'Saving…' : 'Creating…');

      try {
        if (editingEventId) {
          await Api.put(`/admin/events/${editingEventId}`, payload);
          UI.toast('Event updated.', 'success');
        } else {
          await Api.post('/admin/events', payload);
          UI.toast('Event created.', 'success');
        }
        resetEventForm();
        loadEvents();
        loadStats();
      } catch (error) {
        UI.renderFieldErrors(form, error);
        if (!error.details) UI.toast(error.message, 'error');
      } finally { restore(); }
    });
  }

  function openNotifyDialog(event) {
    const textarea = UI.el('textarea', {
      class: 'textarea', rows: '5', maxlength: '2000',
      'aria-label': 'Message to attendees',
      placeholder: 'e.g. The venue has changed to Hall B. Please arrive 15 minutes early.',
    });
    const audience = UI.el('select', { class: 'select', 'aria-label': 'Audience' }, [
      UI.el('option', { value: 'confirmed', text: 'Confirmed attendees' }),
      UI.el('option', { value: 'waitlisted', text: 'Waitlisted students' }),
      UI.el('option', { value: 'all', text: 'Everyone registered' }),
    ]);

    UI.confirmDialog({
      title: `Notify attendees of "${event.title}"`,
      body: UI.el('div', { class: 'form' }, [
        UI.el('div', { class: 'field' }, [
          UI.el('label', { class: 'field__label', for: 'notify-audience', text: 'Send to' }),
          audience,
        ]),
        UI.el('div', { class: 'field' }, [
          UI.el('label', { class: 'field__label', for: 'notify-message', text: 'Message' }),
          textarea,
          UI.el('p', { class: 'field__hint', text: 'Sent by email to each recipient. In development mode the message is printed to the server console.' }),
        ]),
      ]),
      confirmLabel: 'Send notification',
      onConfirm: async () => {
        const message = textarea.value.trim();
        if (message.length < 3) {
          UI.toast('Please write a message of at least 3 characters.', 'warning');
          return false; // keep the dialog open
        }
        const body = await Api.post(`/admin/events/${event.id}/notify`, {
          message,
          audience: audience.value,
        });
        UI.toast(body.message, 'success');
        return true;
      },
    });
  }

  // =========================================================================
  // User management
  // =========================================================================

  const userState = { page: 1, q: '', role: '', status: '' };

  function wireUserFilters() {
    const form = document.getElementById('user-filters');
    if (!form) return;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      userState.q = form.q.value.trim();
      userState.role = form.role.value;
      userState.status = form.status.value;
      userState.page = 1;
      loadUsers();
    });
    document.getElementById('user-clear').addEventListener('click', () => {
      form.reset();
      Object.assign(userState, { page: 1, q: '', role: '', status: '' });
      loadUsers();
    });
  }

  async function loadUsers() {
    const slot = document.getElementById('users-table');
    UI.replace(slot, UI.loadingState('Loading users…'));

    try {
      const params = new URLSearchParams({ page: userState.page, pageSize: '15' });
      if (userState.q) params.set('q', userState.q);
      if (userState.role) params.set('role', userState.role);
      if (userState.status) params.set('status', userState.status);

      const body = await Api.get(`/admin/users?${params.toString()}`);
      const { users, pagination } = body.data;

      if (users.length === 0) {
        UI.replace(slot, UI.emptyState('No users found', 'Adjust the search filters above.', '👥'));
        return;
      }

      const table = buildTable(
        ['Name', 'Email', 'Role', 'Verified', 'Status', 'Actions'],
        users.map((user) => {
          const roleSelect = UI.el('select', { class: 'select', 'aria-label': `Role for ${user.name}`, style: { minWidth: '120px' } },
            ['student', 'alumni', 'admin'].map((role) => UI.el('option', { value: role, text: role, selected: role === user.role ? 'selected' : null }))
          );
          roleSelect.addEventListener('change', async () => {
            const newRole = roleSelect.value;
            const ok = await UI.confirmDialog({
              title: 'Change role?',
              body: `Change ${user.name} from ${user.role} to ${newRole}? They will be signed out immediately.`,
              confirmLabel: 'Change role',
            });
            if (!ok) { roleSelect.value = user.role; return; }
            try {
              UI.toast((await Api.patch(`/admin/users/${user.id}/role`, { role: newRole })).message, 'success');
              loadUsers();
              loadStats();
            } catch (error) {
              UI.toast(error.message, 'error');
              roleSelect.value = user.role;
            }
          });

          const statusBtn = UI.el('button', {
            class: `btn btn--sm ${user.isActive ? 'btn--danger' : 'btn--success'}`,
            type: 'button',
            text: user.isActive ? 'Suspend' : 'Activate',
          });
          statusBtn.addEventListener('click', async () => {
            const activating = !user.isActive;
            const ok = await UI.confirmDialog({
              title: activating ? 'Activate account?' : 'Suspend account?',
              body: activating
                ? `${user.name} will be able to sign in again.`
                : `${user.name} will be signed out immediately and blocked from the portal.`,
              confirmLabel: activating ? 'Activate' : 'Suspend',
              danger: !activating,
            });
            if (!ok) return;
            try {
              UI.toast((await Api.patch(`/admin/users/${user.id}/status`, { isActive: activating })).message, 'success');
              loadUsers();
              loadStats();
            } catch (error) {
              UI.toast(error.message, 'error');
            }
          });

          return [
            UI.el('div', { class: 'stack-sm' }, [
              UI.el('strong', { text: user.name }),
              UI.el('span', { class: 'field__hint', text: user.collegeId || '' }),
            ]),
            UI.el('div', { class: 'stack-sm' }, [
              UI.el('span', { text: user.email }),
              user.company ? UI.el('span', { class: 'field__hint', text: user.company }) : null,
            ]),
            roleSelect,
            UI.el('span', { class: user.emailVerified ? 'badge badge--confirmed' : 'badge badge--rejected', text: user.emailVerified ? 'Yes' : 'No' }),
            UI.el('span', { class: user.isActive ? 'badge badge--accepted' : 'badge badge--cancelled', text: user.isActive ? 'Active' : 'Suspended' }),
            UI.el('div', { class: 'row', style: { gap: '6px' } }, [statusBtn]),
          ];
        })
      );

      UI.replace(slot, table);
      slot.appendChild(pager(pagination, (page) => { userState.page = page; loadUsers(); }));
    } catch (error) {
      UI.replace(slot, UI.errorState(error.message, loadUsers));
    }
  }

  // =========================================================================
  // Alumni approvals
  // =========================================================================

  async function loadPendingAlumni() {
    const slot = document.getElementById('pending-alumni');
    UI.replace(slot, UI.loadingState('Loading applications…'));
    try {
      const body = await Api.get('/admin/alumni/pending');
      const items = body.data.pending;

      if (items.length === 0) {
        UI.replace(slot, UI.emptyState('No pending applications', 'All alumni profiles have been reviewed.', '✅'));
        return;
      }

      UI.replace(slot, items.map((person) => {
        const approveBtn = UI.el('button', { class: 'btn btn--success btn--sm', type: 'button', text: 'Approve' });
        approveBtn.addEventListener('click', async () => {
          const restore = UI.withButtonBusy(approveBtn, 'Approving…');
          try {
            UI.toast((await Api.post(`/admin/alumni/${person.userId}/approve`, {})).message, 'success');
            loadPendingAlumni();
            loadStats();
          } catch (error) {
            UI.toast(error.message, 'error');
            restore();
          }
        });

        const rejectBtn = UI.el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Reject' });
        rejectBtn.addEventListener('click', async () => {
          const reasonInput = UI.el('input', {
            class: 'input', type: 'text', maxlength: '255',
            placeholder: 'Reason (optional)', 'aria-label': 'Rejection reason',
          });
          const ok = await UI.confirmDialog({
            title: `Reject ${person.name}?`,
            body: UI.el('div', { class: 'stack-sm' }, [
              UI.el('p', { text: 'The applicant will be emailed about this decision.' }),
              reasonInput,
            ]),
            confirmLabel: 'Reject application',
            danger: true,
            onConfirm: async () => {
              await Api.post(`/admin/alumni/${person.userId}/reject`, { reason: reasonInput.value.trim() });
              return true;
            },
          });
          if (ok) { UI.toast('Application rejected.', 'success'); loadPendingAlumni(); loadStats(); }
        });

        return UI.el('div', { class: 'card' }, [
          UI.el('div', { class: 'row row--between' }, [
            UI.el('div', { class: 'grow' }, [
              UI.el('h3', { class: 'card__title', text: person.name }),
              UI.el('p', { class: 'event-card__meta', text: `✉️ ${person.email}` }),
              UI.el('p', { class: 'event-card__meta', text: `🎓 ${person.graduationYear || 'Year unknown'} · ${person.degree || 'Degree not specified'}` }),
              person.company ? UI.el('p', { class: 'event-card__meta', text: `🏢 ${person.company}${person.designation ? ` · ${person.designation}` : ''}` }) : null,
              person.bio ? UI.el('p', { class: 'alumni-card__bio', text: person.bio }) : null,
            ]),
            UI.el('div', { class: 'stack-sm' }, [
              person.emailVerified
                ? UI.el('span', { class: 'badge badge--confirmed', text: 'Email verified' })
                : UI.el('span', { class: 'badge badge--rejected', text: 'Email not verified' }),
              UI.el('div', { class: 'row' }, [approveBtn, rejectBtn]),
            ]),
          ]),
        ]);
      }));
    } catch (error) {
      UI.replace(slot, UI.errorState(error.message, loadPendingAlumni));
    }
  }

  // =========================================================================
  // Registration report + CSV
  // =========================================================================

  const reportState = { page: 1, eventId: '', status: '' };

  function wireRegistrationFilters() {
    const form = document.getElementById('report-filters');
    if (!form) return;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      reportState.eventId = form.eventId.value;
      reportState.status = form.status.value;
      reportState.page = 1;
      loadRegistrations();
    });
    document.getElementById('report-clear').addEventListener('click', () => {
      form.reset();
      Object.assign(reportState, { page: 1, eventId: '', status: '' });
      loadRegistrations();
    });
  }

  function wireExport() {
    const button = document.getElementById('export-csv');
    if (!button) return;
    button.addEventListener('click', async () => {
      const restore = UI.withButtonBusy(button, 'Preparing…');
      try {
        const params = new URLSearchParams();
        if (reportState.eventId) params.set('eventId', reportState.eventId);
        if (reportState.status) params.set('status', reportState.status);

        // raw:true so we receive the Response and can stream it to a download.
        const response = await Api.request(`/admin/registrations/export?${params.toString()}`, { raw: true });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body && body.error ? body.error.message : 'Export failed.');
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = UI.el('a', { href: url, download: 'registrations.csv' });
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        UI.toast('CSV export downloaded.', 'success');
      } catch (error) {
        UI.toast(error.message, 'error');
      } finally { restore(); }
    });
  }

  async function loadRegistrations() {
    const slot = document.getElementById('registrations-table');
    UI.replace(slot, UI.loadingState('Loading report…'));
    try {
      const params = new URLSearchParams({ page: reportState.page, pageSize: '20' });
      if (reportState.eventId) params.set('eventId', reportState.eventId);
      if (reportState.status) params.set('status', reportState.status);

      const body = await Api.get(`/admin/registrations?${params.toString()}`);
      const { registrations, pagination } = body.data;

      if (registrations.length === 0) {
        UI.replace(slot, UI.emptyState('No registrations match', 'Try clearing the filters.', '📋'));
        return;
      }

      const table = buildTable(
        ['Student', 'Email', 'Event', 'Status', 'Registered'],
        registrations.map((row) => {
          // Build each cell explicitly; DOM nodes are passed straight through
          // by buildTable() so the badge renders correctly.
          const statusCell = Events.statusBadge(row.status);
          if (row.waitlistPosition) {
            const position = UI.el('span', { class: 'field__hint', text: ` #${row.waitlistPosition}` });
            return [
              UI.el('div', { class: 'stack-sm' }, [
                UI.el('strong', { text: row.user.name }),
                UI.el('span', { class: 'field__hint', text: row.user.collegeId || '' }),
              ]),
              row.user.email,
              UI.el('div', { class: 'stack-sm' }, [
                UI.el('span', { text: row.event.title }),
                UI.el('span', { class: 'field__hint', text: UI.formatDate(row.event.eventDate) }),
              ]),
              UI.el('div', { class: 'stack-sm' }, [statusCell, position]),
              UI.formatDateTime(row.registeredAt),
            ];
          }
          return [
            UI.el('div', { class: 'stack-sm' }, [
              UI.el('strong', { text: row.user.name }),
              UI.el('span', { class: 'field__hint', text: row.user.collegeId || '' }),
            ]),
            row.user.email,
            UI.el('div', { class: 'stack-sm' }, [
              UI.el('span', { text: row.event.title }),
              UI.el('span', { class: 'field__hint', text: UI.formatDate(row.event.eventDate) }),
            ]),
            statusCell,
            UI.formatDateTime(row.registeredAt),
          ];
        })
      );

      UI.replace(slot, table);
      slot.appendChild(pager(pagination, (page) => { reportState.page = page; loadRegistrations(); }));
    } catch (error) {
      UI.replace(slot, UI.errorState(error.message, loadRegistrations));
    }
  }

  // =========================================================================
  // News publishing
  // =========================================================================

  function wireNewsForm() {
    const form = document.getElementById('news-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);
      const submit = form.querySelector('[type="submit"]');
      const restore = UI.withButtonBusy(submit, 'Publishing…');
      try {
        // POST /api/news is guarded by authorize('admin') on the server.
        await Api.post('/news', {
          title: form.title.value.trim(),
          content: form.content.value.trim(),
        });
        UI.toast('Announcement published.', 'success');
        form.reset();
      } catch (error) {
        UI.renderFieldErrors(form, error);
        if (!error.details) UI.toast(error.message, 'error');
      } finally { restore(); }
    });
  }

  // =========================================================================
  // Shared helpers
  // =========================================================================

  /** Build a responsive table. Cells may be strings, numbers or DOM nodes. */
  function buildTable(headers, rows) {
    const thead = UI.el('thead', {}, [
      UI.el('tr', {}, headers.map((h) => UI.el('th', { scope: 'col', text: h }))),
    ]);

    const tbody = UI.el('tbody', {}, rows.map((row) => UI.el('tr', {}, row.map((cell) => {
      if (cell instanceof Node) return UI.el('td', {}, [cell]);
      return UI.el('td', { text: cell === null || cell === undefined ? '—' : String(cell) });
    }))));

    return UI.el('div', { class: 'table-wrap' }, [
      UI.el('table', { class: 'table' }, [thead, tbody]),
    ]);
  }

  /** Standard pager used under each table. */
  function pager(pagination, onChange) {
    const slot = UI.el('div', { class: 'pagination' });
    Events.renderPagination(slot, pagination, onChange);
    return slot;
  }

  /** <input type="datetime-local"> value (local time) -> ISO string for the API. */
  function toUtcPayload(localValue) {
    if (!localValue) return null;
    const date = new Date(localValue);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  /** ISO string -> value for <input type="datetime-local">. */
  function toLocalInputValue(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  return { initAdminPage, showTab };
})();
