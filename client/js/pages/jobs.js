
    Auth.boot('jobs', async () => {
      await Alumni.initJobsPage();
      document.getElementById('jobs-list').setAttribute('aria-busy', 'false');
    });
  