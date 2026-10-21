'use strict';

/**
 * js/alumni.js
 * Frontend for the alumni portal: directory browsing, job board, connection
 * management and college news with comments. (Front half of Task 5.)
 */

const Alumni = (() => {
  // =========================================================================
  // Alumni directory
  // =========================================================================

  async function initDirectoryPage() {
    const grid = document.getElementById('directory-grid');
    const paginationSlot = document.getElementById('directory-pagination');
    if (!grid) return;

    const state = { page: 1, q: '', graduationYear: '', degree: '', company: '' };

    // Populate filter dropdowns from the API.
    try {
      const body = await Api.get('/alumni/directory/filters', { auth: false });
      const { degrees, companies, years } = body.data;

      const degreeSelect = document.getElementById('filter-degree');
      degrees.forEach((d) => degreeSelect.appendChild(UI.el('option', { value: d.value, text: `${d.value} (${d.count})` })));

      const companySelect = document.getElementById('filter-company');
      companies.forEach((c) => companySelect.appendChild(UI.el('option', { value: c.value, text: `${c.value} (${c.count})` })));

      const yearSelect = document.getElementById('filter-year');
      years.forEach((y) => yearSelect.appendChild(UI.el('option', { value: y.value, text: `${y.value} (${y.count})` })));
    } catch (_) { /* filters simply remain empty */ }

    async function load() {
      UI.replace(grid, UI.loadingState('Loading alumni directory…'));
      UI.clear(paginationSlot);

      const params = new URLSearchParams({ page: String(state.page), pageSize: '12' });
      if (state.q) params.set('q', state.q);
      if (state.graduationYear) params.set('graduationYear', state.graduationYear);
      if (state.degree) params.set('degree', state.degree);
      if (state.company) params.set('company', state.company);

      try {
        const body = await Api.get(`/alumni/directory?${params.toString()}`);
        const { alumni, pagination } = body.data;

        if (!alumni || alumni.length === 0) {
          UI.replace(grid, UI.emptyState(
            'No alumni match your search',
            'Try widening the filters - the directory only shows profiles that have been verified and approved.',
            'cap'
          ));
          return;
        }

        UI.replace(grid, alumni.map((person) => renderAlumniCard(person)));
        Events.renderPagination(paginationSlot, pagination, (page) => {
          state.page = page;
          load();
          grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      } catch (error) {
        UI.replace(grid, UI.errorState(error.message, load));
      }
    }

    const filterForm = document.getElementById('directory-filters');
    if (filterForm) {
      filterForm.addEventListener('submit', (event) => {
        event.preventDefault();
        state.q = filterForm.q.value.trim();
        state.graduationYear = filterForm.graduationYear.value;
        state.degree = filterForm.degree.value;
        state.company = filterForm.company.value;
        state.page = 1;
        load();
      });
      const clear = document.getElementById('directory-clear');
      if (clear) clear.addEventListener('click', () => {
        filterForm.reset();
        Object.assign(state, { page: 1, q: '', graduationYear: '', degree: '', company: '' });
        load();
      });
    }

    load();
  }

  function renderAlumniCard(person) {
    const head = UI.el('div', { class: 'alumni-card__head' }, [
      UI.el('div', { class: 'avatar' }, [
        person.avatarUrl
          ? UI.el('img', { src: person.avatarUrl, alt: `Profile photo of ${person.name}`, loading: 'lazy' })
          : document.createTextNode(UI.initials(person.name)),
      ]),
      UI.el('div', { class: 'grow' }, [
        UI.el('h3', { class: 'alumni-card__name', text: person.name }),
        UI.el('p', { class: 'alumni-card__role', text: [person.designation, person.company].filter(Boolean).join(' at ') || 'Alumnus' }),
      ]),
    ]);

    const meta = UI.el('div', { class: 'alumni-card__meta' }, [
      person.graduationYear ? UI.el('span', { text: `Class of ${person.graduationYear}` }) : null,
      person.degree ? UI.el('span', { text: `${person.degree}` }) : null,
      person.company ? UI.el('span', { text: `${person.company}` }) : null,
      person.email ? UI.el('span', { text: `${person.email}` }) : null,
    ]);

    const bio = person.bio
      ? UI.el('p', { class: 'alumni-card__bio', text: person.bio })
      : UI.el('p', { class: 'alumni-card__bio', text: 'No biography provided.' });

    const actions = renderConnectionActions(person);

    return UI.el('article', { class: 'alumni-card' }, [head, meta, bio, actions]);
  }

  /**
   * Render the correct connection button for a directory card.
   * The three states (request / pending / connected) come straight from the API.
   */
  function renderConnectionActions(person) {
    const wrap = UI.el('div', { class: 'row', style: { marginTop: 'auto' } });
    const state = person.connection;

    if (!state) {
      const btn = UI.el('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Connect' });
      btn.addEventListener('click', () => sendRequest(person.userId, btn, wrap));
      wrap.appendChild(btn);
      return wrap;
    }

    if (state.status === 'accepted') {
      wrap.appendChild(UI.el('span', { class: 'badge badge--accepted', text: '✓ Connected' }));
      return wrap;
    }

    if (state.status === 'pending' && state.direction === 'outgoing') {
      const btn = UI.el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Request pending…' });
      btn.disabled = true;
      const cancel = UI.el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Withdraw' });
      cancel.addEventListener('click', async () => {
        try {
          await Api.del(`/connections/${person.connectionId ?? ''}`);
          UI.toast('Request withdrawn.', 'success');
          window.location.reload();
        } catch (error) {
          UI.toast(error.message, 'error');
        }
      });
      // The id needed for withdraw is re-fetched by the network page; on the
      // directory we simply reload to pick up the fresh state.
      wrap.appendChild(btn);
      return wrap;
    }

    if (state.status === 'pending' && state.direction === 'incoming') {
      wrap.appendChild(UI.el('span', { class: 'badge badge--pending', text: 'Sent you a request' }));
      const viewBtn = UI.el('a', { class: 'btn btn--secondary btn--sm', href: '/connections.html', text: 'Review' });
      wrap.appendChild(viewBtn);
      return wrap;
    }

    wrap.appendChild(UI.el('span', { class: 'badge badge--rejected', text: 'Not connected' }));
    const retry = UI.el('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Re-send request' });
    retry.addEventListener('click', () => sendRequest(person.userId, retry, wrap));
    wrap.appendChild(retry);
    return wrap;
  }

  async function sendRequest(userId, button, container) {
    const restore = UI.withButtonBusy(button, 'Sending…');
    try {
      const body = await Api.post(`/connections/request/${userId}`, {});
      UI.toast(body.message, 'success');
      UI.replace(container, UI.el('span', { class: 'badge badge--pending', text: 'Request pending' }));
    } catch (error) {
      UI.toast(error.message, 'error');
      restore();
    }
  }

  // =========================================================================
  // Job board
  // =========================================================================

  async function initJobsPage() {
    const list = document.getElementById('jobs-list');
    const paginationSlot = document.getElementById('jobs-pagination');
    if (!list) return;

    const state = { page: 1, q: '', jobType: '' };

    async function load() {
      UI.replace(list, UI.loadingState('Loading opportunities…'));
      UI.clear(paginationSlot);

      const params = new URLSearchParams({ page: String(state.page), pageSize: '10' });
      if (state.q) params.set('q', state.q);
      if (state.jobType) params.set('jobType', state.jobType);

      try {
        const body = await Api.get(`/jobs?${params.toString()}`, { auth: false });
        const { jobs, pagination } = body.data;

        if (!jobs || jobs.length === 0) {
          UI.replace(list, UI.emptyState(
            'No job postings yet',
            'Approved alumni can share opportunities from the "Post a job" tab on their dashboard.',
            'briefcase'
          ));
          return;
        }

        UI.replace(list, jobs.map(renderJobRow));
        Events.renderPagination(paginationSlot, pagination, (page) => {
          state.page = page;
          load();
        });
      } catch (error) {
        UI.replace(list, UI.errorState(error.message, load));
      }
    }

    const form = document.getElementById('jobs-filters');
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        state.q = form.q.value.trim();
        state.jobType = form.jobType.value;
        state.page = 1;
        load();
      });
    }

    load();
  }

  function renderJobRow(job) {
    const expired = job.deadline && new Date(job.deadline) < new Date();

    return UI.el('article', { class: 'card' }, [
      UI.el('div', { class: 'row row--between' }, [
        UI.el('div', { class: 'grow' }, [
          UI.el('h3', { class: 'card__title', text: job.title }),
          UI.el('p', { class: 'event-card__meta', text: `${job.company}${job.location ? ` · ${job.location}` : ''}` }),
        ]),
        UI.el('div', { class: 'stack-sm', style: { alignItems: 'flex-end' } }, [
          UI.el('span', { class: 'badge badge--role', text: String(job.jobType || '').replace('_', ' ') }),
          job.deadline
            ? UI.el('span', { class: expired ? 'badge badge--rejected' : 'badge badge--neutral', text: `Deadline: ${UI.formatDate(job.deadline)}` })
            : null,
        ]),
      ]),
      UI.el('div', { class: 'row row--between', style: { marginTop: '12px' } }, [
        UI.el('span', { class: 'field__hint', text: job.posterName ? `Posted by ${job.posterName}` : '' }),
        UI.el('div', { class: 'row' }, [
          UI.el('a', { class: 'btn btn--ghost btn--sm', href: `/jobs.html#job-${job.id}`, text: 'Details' }),
          // rel="noopener noreferrer" prevents the opened page from reaching
          // back into this tab via window.opener.
          UI.el('a', {
            class: 'btn btn--primary btn--sm', href: job.applyUrl, target: '_blank',
            rel: 'noopener noreferrer', text: 'Apply',
          }),
        ]),
      ]),
    ]);
  }

  /** Modal-ish inline form for creating a job posting. */
  async function initJobPostPage() {
    const form = document.getElementById('job-post-form');
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);

      const submit = form.querySelector('[type="submit"]');
      const restore = UI.withButtonBusy(submit, 'Publishing…');

      try {
        await Api.post('/jobs', {
          title: form.title.value.trim(),
          company: form.company.value.trim(),
          location: form.location.value.trim(),
          description: form.description.value.trim(),
          jobType: form.jobType.value,
          applyUrl: form.applyUrl.value.trim(),
          deadline: form.deadline.value || null,
        });
        UI.toast('Job posted successfully.', 'success');
        form.reset();
        if (typeof window.loadMyJobs === 'function') window.loadMyJobs();
      } catch (error) {
        UI.renderFieldErrors(form, error);
        if (!error.details) UI.toast(error.message, 'error');
      } finally { restore(); }
    });
  }

  // =========================================================================
  // Connections / network page
  // =========================================================================

  async function initNetworkPage() {
    const slot = document.getElementById('network-content');
    if (!slot) return;

    const user = await Auth.requireRole(['alumni']);
    if (!user) return;

    async function load() {
      UI.replace(slot, UI.loadingState('Loading your network…'));
      try {
        const body = await Api.get('/connections');
        const { connections, incoming, outgoing } = body.data;

        UI.clear(slot);

        // ---- pending requests ----
        const requestsCard = UI.el('div', { class: 'card' }, [
          UI.el('div', { class: 'card__header' }, [
            UI.el('h2', { class: 'card__title', text: 'Connection requests' }),
            UI.el('span', { class: 'badge badge--pending', text: `${incoming.length} incoming · ${outgoing.length} sent` }),
          ]),
        ]);

        if (incoming.length === 0 && outgoing.length === 0) {
          requestsCard.appendChild(UI.el('p', { class: 'field__hint', text: 'No pending requests. Find people in the alumni directory.' }));
        }

        for (const request of incoming) {
          requestsCard.appendChild(UI.el('div', { class: 'card', style: { padding: '14px' } }, [
            UI.el('div', { class: 'row row--between' }, [
              personSummary(request.person),
              UI.el('div', { class: 'row' }, [
                actionButton('Accept', 'btn--success', async () => {
                  try { UI.toast((await Api.post(`/connections/${request.connectionId}/accept`, {})).message, 'success'); load(); }
                  catch (e) { UI.toast(e.message, 'error'); }
                }),
                actionButton('Decline', 'btn--ghost', async () => {
                  try { UI.toast((await Api.post(`/connections/${request.connectionId}/reject`, {})).message, 'success'); load(); }
                  catch (e) { UI.toast(e.message, 'error'); }
                }),
              ]),
            ]),
          ]));
        }

        for (const request of outgoing) {
          requestsCard.appendChild(UI.el('div', { class: 'card', style: { padding: '14px' } }, [
            UI.el('div', { class: 'row row--between' }, [
              personSummary(request.person),
              UI.el('div', { class: 'row' }, [
                UI.el('span', { class: 'badge badge--pending', text: 'Awaiting response' }),
                actionButton('Withdraw', 'btn--danger', async () => {
                  try { UI.toast((await Api.del(`/connections/${request.connectionId}`)).message, 'success'); load(); }
                  catch (e) { UI.toast(e.message, 'error'); }
                }),
              ]),
            ]),
          ]));
        }

        slot.appendChild(requestsCard);

        // ---- accepted network ----
        const networkCard = UI.el('div', { class: 'card' }, [
          UI.el('div', { class: 'card__header' }, [
            UI.el('h2', { class: 'card__title', text: 'My network' }),
            UI.el('span', { class: 'badge badge--accepted', text: `${connections.length} connected` }),
          ]),
        ]);

        if (connections.length === 0) {
          networkCard.appendChild(UI.emptyState(
            'Your network is empty',
            'Accept a request or send one from the alumni directory to start building your network.',
            'link'
          ));
        } else {
          networkCard.appendChild(UI.el('div', { class: 'grid grid--cards' },
            connections.map((connection) => UI.el('div', { class: 'alumni-card' }, [
              personSummary(connection.person),
              UI.el('span', { class: 'badge badge--accepted', text: `✓ Connected since ${UI.formatDate(connection.since)}` }),
              actionButton('Remove connection', 'btn--danger', async () => {
                const ok = await UI.confirmDialog({
                  title: 'Remove connection?',
                  body: `Remove ${connection.person ? connection.person.name : 'this person'} from your network?`,
                  confirmLabel: 'Remove',
                  danger: true,
                });
                if (!ok) return;
                try { UI.toast((await Api.del(`/connections/${connection.connectionId}`)).message, 'success'); load(); }
                catch (e) { UI.toast(e.message, 'error'); }
              }),
            ]))
          ));
        }

        slot.appendChild(networkCard);
      } catch (error) {
        UI.replace(slot, UI.errorState(error.message, load));
      }
    }

    function personSummary(person) {
      if (!person) return UI.el('div', { class: 'grow', text: 'Unknown profile' });
      return UI.el('div', { class: 'alumni-card__head grow' }, [
        UI.el('div', { class: 'avatar avatar--sm' }, [
          person.avatarUrl
            ? UI.el('img', { src: person.avatarUrl, alt: '', loading: 'lazy' })
            : document.createTextNode(UI.initials(person.name)),
        ]),
        UI.el('div', { class: 'grow' }, [
          UI.el('p', { class: 'alumni-card__name', style: { margin: 0 }, text: person.name }),
          UI.el('p', { class: 'alumni-card__role', text: [person.designation, person.company].filter(Boolean).join(' · ') || 'Alumnus' }),
        ]),
      ]);
    }

    function actionButton(label, variant, handler) {
      const button = UI.el('button', { class: `btn ${variant} btn--sm`, type: 'button', text: label });
      button.addEventListener('click', async () => {
        const restore = UI.withButtonBusy(button, '…');
        try { await handler(); } finally { restore(); }
      });
      return button;
    }

    load();
  }

  // =========================================================================
  // News + comments
  // =========================================================================

  async function initNewsPage() {
    const list = document.getElementById('news-list');
    const paginationSlot = document.getElementById('news-pagination');
    if (!list) return;

    let page = 1;

    async function load() {
      UI.replace(list, UI.loadingState('Loading announcements…'));
      UI.clear(paginationSlot);
      try {
        const body = await Api.get(`/news?page=${page}&pageSize=5`, { auth: false });
        const { news, pagination } = body.data;

        if (!news || news.length === 0) {
          UI.replace(list, UI.emptyState('No announcements yet', 'College news will appear here.', 'news'));
          return;
        }

        UI.replace(list, news.map(renderNewsCard));
        Events.renderPagination(paginationSlot, pagination, (next) => { page = next; load(); });
      } catch (error) {
        UI.replace(list, UI.errorState(error.message, load));
      }
    }

    function renderNewsCard(item) {
      const commentsSlot = UI.el('div', { class: 'stack-sm', style: { marginTop: '12px' } });
      const toggle = UI.el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        text: `${item.commentCount} comment${item.commentCount === 1 ? '' : 's'}`,
      });
      let loaded = false;

      toggle.addEventListener('click', async () => {
        if (loaded) { UI.clear(commentsSlot); loaded = false; return; }
        UI.replace(commentsSlot, UI.loadingState('Loading comments…'));
        loaded = true;
        try {
          const body = await Api.get(`/news/${item.id}/comments?page=1&pageSize=20`, { auth: false });
          UI.clear(commentsSlot);
          const comments = body.data.comments;
          if (comments.length === 0) {
            commentsSlot.appendChild(UI.el('p', { class: 'field__hint', text: 'No comments yet - be the first to respond.' }));
          } else {
            for (const comment of comments) {
              commentsSlot.appendChild(UI.el('div', { class: 'alert alert--info' }, [
                UI.el('div', { class: 'grow' }, [
                  UI.el('strong', { text: comment.author.name }),
                  UI.el('span', { text: ` · ${UI.formatDateTime(comment.createdAt)}` }),
                  UI.el('p', { style: { margin: '4px 0 0' }, text: comment.content }),
                ]),
              ]));
            }
          }
          commentsSlot.appendChild(buildCommentForm(item.id, () => { loaded = false; toggle.click(); }));
        } catch (error) {
          UI.replace(commentsSlot, UI.el('div', { class: 'alert alert--danger', text: error.message }));
          loaded = false;
        }
      });

      return UI.el('article', { class: 'card', id: `news-${item.id}` }, [
        UI.el('div', { class: 'card__header' }, [
          UI.el('h2', { class: 'card__title', text: item.title }),
          UI.el('span', { class: 'field__hint', text: `${UI.formatDateTime(item.createdAt)} · ${item.authorName}` }),
        ]),
        UI.el('p', { text: item.excerpt + (item.excerpt.length >= 220 ? '…' : '') }),
        UI.el('div', { class: 'row' }, [toggle]),
        commentsSlot,
      ]);
    }

    function buildCommentForm(newsId, refresh) {
      const form = UI.el('form', { class: 'form', style: { marginTop: '8px' } });
      const textarea = UI.el('textarea', {
        class: 'textarea', name: 'content', rows: '2',
        placeholder: 'Write a comment…', maxlength: '1000',
        'aria-label': 'Comment text',
      });
      const submit = UI.el('button', { class: 'btn btn--primary btn--sm', type: 'submit', text: 'Post comment' });
      form.appendChild(UI.el('div', { class: 'field' }, [textarea, UI.el('p', { class: 'field__error' })]));
      form.appendChild(UI.el('div', { class: 'row row--end' }, [submit]));

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const content = textarea.value.trim();
        if (!content) { UI.toast('Please write something first.', 'warning'); return; }
        const restore = UI.withButtonBusy(submit, 'Posting…');
        try {
          await Api.post(`/news/${newsId}/comments`, { content });
          UI.toast('Comment posted.', 'success');
          textarea.value = '';
          if (typeof refresh === 'function') refresh();
        } catch (error) {
          UI.toast(error.message, 'error');
        } finally { restore(); }
      });
      return form;
    }

    load();
  }

  return {
    initDirectoryPage, initJobsPage, initJobPostPage,
    initNetworkPage, initNewsPage,
    renderAlumniCard, renderJobRow,
  };
})();
