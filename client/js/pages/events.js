
    Auth.boot('events', async (user) => {
      await Events.initEventsPage();
      document.getElementById('events-grid').setAttribute('aria-busy', 'false');
    });
  