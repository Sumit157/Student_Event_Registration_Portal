
    (async function bootProfile() {
      const user = await Auth.init();
      if (!user) { window.location.replace('/login.html?returnTo=/profile.html'); return; }

      const form = document.getElementById('profile-form');
      const alumniBlock = document.getElementById('alumni-profile-fields');
      const avatarPreview = document.getElementById('avatar-preview');
      const avatarInitials = document.getElementById('avatar-initials');
      const removeAvatarBtn = document.getElementById('avatar-remove');

      // ---- load current profile ----
      async function loadProfile() {
        try {
          const body = await Api.get('/profile');
          const profile = body.data.profile;
          const alumni = profile.alumni || {};

          form.name.value = profile.name || '';
          form.email.value = profile.email || '';
          form.collegeId.value = profile.collegeId || '';

          document.getElementById('verify-status').textContent = profile.emailVerified
            ? 'Your email address is confirmed.'
            : 'Your email address has not been confirmed yet. Some features stay locked until you click the link we emailed you.';

          const resendBtn = document.getElementById('resend-verification');
          resendBtn.hidden = profile.emailVerified;
          resendBtn.onclick = async () => {
            const restore = UI.withButtonBusy(resendBtn, 'Sending…');
            try { UI.toast((await Api.post('/auth/resend-verification', {})).message, 'success'); }
            catch (e) { UI.toast(e.message, 'error'); }
            finally { restore(); }
          };

          if (profile.role === 'alumni') {
            alumniBlock.hidden = false;
            form.graduationYear.value = alumni.graduationYear || '';
            form.degree.value = alumni.degree || '';
            form.company.value = alumni.company || '';
            form.designation.value = alumni.designation || '';
            form.bio.value = alumni.bio || '';
          }

          // Avatar preview
          if (alumni.avatarUrl) {
            UI.replace(avatarPreview, UI.el('img', { src: alumni.avatarUrl, alt: 'Your profile picture' }));
            removeAvatarBtn.hidden = false;
          } else {
            UI.clear(avatarPreview);
            avatarInitials.textContent = UI.initials(profile.name);
            avatarInitials.style.fontSize = '2rem';
            avatarPreview.appendChild(avatarInitials);
            removeAvatarBtn.hidden = true;
          }
        } catch (error) {
          UI.toast(error.message, 'error');
        }
      }

      // ---- save details ----
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        UI.clearFieldErrors(form);

        const payload = {
          name: form.name.value.trim(),
          collegeId: form.collegeId.value.trim(),
        };
        if (!alumniBlock.hidden) {
          payload.graduationYear = form.graduationYear.value ? Number(form.graduationYear.value) : null;
          payload.degree = form.degree.value.trim();
          payload.company = form.company.value.trim();
          payload.designation = form.designation.value.trim();
          payload.bio = form.bio.value.trim();
        }

        const submit = form.querySelector('[type="submit"]');
        const restore = UI.withButtonBusy(submit, 'Saving…');
        try {
          const body = await Api.put('/profile', payload);
          UI.toast('Profile updated.', 'success');
          Auth.setCachedUser(body.data.profile);
          loadProfile();
        } catch (error) {
          UI.renderFieldErrors(form, error);
          if (!error.details) UI.toast(error.message, 'error');
        } finally { restore(); }
      });

      // ---- avatar upload ----
      document.getElementById('avatar-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('avatar');
        UI.clearFieldErrors(event.target);

        if (!input.files || !input.files.length) {
          UI.toast('Please choose an image first.', 'warning');
          return;
        }
        const file = input.files[0];
        if (file.size > 2 * 1024 * 1024) {
          UI.toast('That image is larger than 2 MB. Please pick a smaller one.', 'error');
          return;
        }

        const submit = event.target.querySelector('[type="submit"]');
        const restore = UI.withButtonBusy(submit, 'Uploading…');

        const data = new FormData();
        data.append('avatar', file);

        try {
          const body = await Api.post('/profile/avatar', data);
          UI.toast('Profile picture updated.', 'success');
          input.value = '';
          loadProfile();
        } catch (error) {
          UI.renderFieldErrors(event.target, error);
          if (!error.details) UI.toast(error.message, 'error');
        } finally { restore(); }
      });

      // ---- remove avatar ----
      removeAvatarBtn.addEventListener('click', async () => {
        const ok = await UI.confirmDialog({
          title: 'Remove profile picture?',
          body: 'Your picture will be deleted and your initials shown instead.',
          confirmLabel: 'Remove',
          danger: true,
        });
        if (!ok) return;
        try {
          await Api.del('/profile/avatar');
          UI.toast('Profile picture removed.', 'success');
          loadProfile();
        } catch (error) { UI.toast(error.message, 'error'); }
      });

      await Auth.boot('home');
      loadProfile();
    })();
  