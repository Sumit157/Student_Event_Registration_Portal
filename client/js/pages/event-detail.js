
    Auth.boot('events', async () => {
      await Events.initEventDetailPage();
      document.getElementById('event-detail').setAttribute('aria-busy', 'false');
    });
  