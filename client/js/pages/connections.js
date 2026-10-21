
    Auth.boot('alumni', async () => {
      await Alumni.initNetworkPage();
      document.getElementById('network-content').setAttribute('aria-busy', 'false');
    });
  