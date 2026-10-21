
    (async function bootStudentDashboard() {
      const user = await Auth.requireRole(['student']);
      if (!user) return;

      document.getElementById('welcome-heading').textContent =
        `Welcome back, ${user.name.split(' ')[0]}`;

      // ---- registrations summary ----
      const regSlot = document.getElementById('next-registrations');
      UI.replace(regSlot, UI.loadingState('Loading your registrations…'));

      try {
        const body = await Api.get('/events/me/registrations');
        const all = body.data.registrations || [];
        const active = all.filter((r) => r.status !== 'cancelled');
        const upcoming = active.filter((r) => new Date(r.event.eventDate) >= new Date());
        const waitlisted = active.filter((r) => r.status === 'waitlisted');

        document.getElementById('stat-active').textContent = String(active.length);
        document.getElementById('stat-upcoming').textContent = String(upcoming.length);
        document.getElementById('stat-waitlisted').textContent = String(waitlisted.length);

        const next = upcoming
          .sort((a, b) => new Date(a.event.eventDate) - new Date(b.event.eventDate))
          .slice(0, 4);

        if (next.length === 0) {
          UI.replace(regSlot, UI.emptyState(
            'No upcoming events',
            'You are not registered for anything yet. Find something you like and grab a seat.',
            '🎟️'
          ));
          regSlot.appendChild(UI.el('a', { class: 'btn btn--primary', href: '/events.html', text: 'Browse events' }));
        } else {
          UI.replace(regSlot, UI.el('div', { class: 'stack-sm' }, next.map((row) => UI.el('div', {
            class: 'card', style: { padding: '14px' },
          }, [
            UI.el('div', { class: 'row row--between' }, [
              UI.el('div', { class: 'grow' }, [
                UI.el('a', {
                  href: `/event-detail.html?id=${row.event.id}`,
                  text: row.event.title,
                  style: { fontWeight: '600' },
                }),
                UI.el('p', { class: 'event-card__meta', style: { margin: '4px 0 0' }, text: UI.formatDateTime(row.event.eventDate) }),
              ]),
              Events.statusBadge(row.status),
            ]),
          ]))));
        }
      } catch (error) {
        UI.replace(regSlot, UI.errorState(error.message, () => window.location.reload()));
      }

      // ---- announcements ----
      const newsSlot = document.getElementById('student-news');
      UI.replace(newsSlot, UI.loadingState('Loading announcements…'));
      try {
        const body = await Api.get('/news?page=1&pageSize=4', { auth: false });
        const items = body.data.news;
        if (items.length === 0) {
          UI.replace(newsSlot, UI.emptyState('No announcements yet', 'Check back soon.', '📰'));
        } else {
          UI.replace(newsSlot, UI.el('div', { class: 'stack-sm' }, items.map((item) => UI.el('div', { class: 'stack-sm', style: { paddingBottom: '10px', borderBottom: '1px solid var(--border)' } }, [
            UI.el('a', { href: `/news.html#news-${item.id}`, text: item.title, style: { fontWeight: '600' } }),
            UI.el('p', { class: 'event-card__meta', style: { margin: 0 }, text: `${UI.formatDateTime(item.createdAt)} · ${item.authorName}` }),
          ]))));
        }
      } catch (error) {
        UI.replace(newsSlot, UI.el('p', { class: 'field__hint', text: error.message }));
      }
    })();
  