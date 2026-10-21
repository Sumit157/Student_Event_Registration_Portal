
    Auth.boot('events', async () => {
      await Events.initMyRegistrationsPage();
      document.getElementById('registrations-list').setAttribute('aria-busy', 'false');
    });
  