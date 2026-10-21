
    (async function bootLanding() {
      await Auth.boot('home');

      // Populate the headline numbers. Each is independent and never blocks
      // the others - a failed call just leaves that tile showing "—".
      const jobs = [
        { el: 'stat-events', path: '/events?pageSize=1', pick: (b) => b.data.pagination.total },
        { el: 'stat-alumni', path: '/alumni/directory?pageSize=1', pick: (b) => b.data.pagination.total },
        { el: 'stat-jobs', path: '/jobs?pageSize=1', pick: (b) => b.data.pagination.total },
        { el: 'stat-news', path: '/news?pageSize=1', pick: (b) => b.data.pagination.total },
      ];
      for (const job of jobs) {
        const node = document.getElementById(job.el);
        if (!node) continue;
        try {
          const body = await Api.get(job.path, { auth: false });
          node.textContent = String(job.pick(body));
        } catch (_) { node.textContent = '—'; }
      }
    })();
  