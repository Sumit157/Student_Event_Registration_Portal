
    Auth.boot('alumni', async () => {
      await Alumni.initDirectoryPage();
      document.getElementById('directory-grid').setAttribute('aria-busy', 'false');
    });
  