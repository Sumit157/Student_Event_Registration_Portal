
    Auth.boot('news', async () => {
      await Alumni.initNewsPage();
      document.getElementById('news-list').setAttribute('aria-busy', 'false');
    });
  