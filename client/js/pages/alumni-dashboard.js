
    (async function bootAlumniDashboard() {
      const user = await Auth.requireRole(['alumni']);
      if (!user) return;

      document.getElementById('welcome-heading').textContent = `Welcome back, ${user.name.split(' ')[0]}`;

      // ---- profile + approval state ----
      const summary = document.getElementById('profile-summary');
      const notice = document.getElementById('approval-notice');

      async function loadProfile() {
        UI.replace(summary, UI.loadingState('Loading your profile…'));
        try {
          const body = await Api.get('/profile');
          const profile = body.data.profile;
          const alumni = profile.alumni || {};

          if (alumni.approved) {
            UI.replace(notice, UI.el('div', { class: 'alert alert--success', role: 'status' }, [
              UI.el('div', {}, [
                UI.el('strong', { text: 'Your profile is live' }),
                UI.el('span', { text: 'You appear in the public directory and can post jobs and send connection requests.' }),
              ]),
            ]));
            document.getElementById('post-job-hint').textContent = 'Share a role from your workplace with current students and fellow alumni.';
            document.getElementById('job-post-form').querySelectorAll('input, select, textarea, button').forEach((n) => { n.disabled = false; });
          } else {
            UI.replace(notice, UI.el('div', { class: 'alert alert--warning', role: 'status' }, [
              UI.el('div', {}, [
                UI.el('strong', { text: 'Awaiting administrator approval' }),
                UI.el('span', {
                  text: alumni.rejectionReason
                    ? `Your previous application was declined: ${alumni.rejectionReason}. You can edit your details and contact the alumni cell.`
                    : 'Your profile will appear in the public directory once an administrator approves it. Until then you cannot post jobs or send connection requests.',
                }),
              ]),
            ]));
            document.getElementById('post-job-hint').textContent = 'Job posting becomes available after your alumni profile is approved.';
            document.getElementById('job-post-form').querySelectorAll('input, select, textarea, button').forEach((n) => { n.disabled = true; });
          }

          const rows = [
            ['Name', profile.name],
            ['Email', profile.email],
            ['College ID', profile.collegeId || '—'],
            ['Graduation year', alumni.graduationYear || '—'],
            ['Degree', alumni.degree || '—'],
            ['Company', alumni.company || '—'],
            ['Designation', alumni.designation || '—'],
            ['Directory status', alumni.approved ? 'Approved' : 'Pending approval'],
          ];

          UI.replace(summary, UI.el('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' } },
            rows.map(([label, value]) => UI.el('div', { class: 'stack-sm' }, [
              UI.el('span', { class: 'stat__label', text: label }),
              UI.el('span', { text: String(value), style: { fontWeight: '600' } }),
            ]))
          ));
        } catch (error) {
          UI.replace(summary, UI.errorState(error.message, loadProfile));
        }
      }

      // ---- my job postings ----
      const jobsSlot = document.getElementById('my-jobs');

      window.loadMyJobs = async function loadMyJobs() {
        UI.replace(jobsSlot, UI.loadingState('Loading your postings…'));
        try {
          const body = await Api.get('/jobs/mine/posted');
          const jobs = body.data.jobs;
          if (jobs.length === 0) {
            UI.replace(jobsSlot, UI.emptyState('Nothing posted yet', 'Use the form to share your first opportunity.', '💼'));
            return;
          }
          UI.replace(jobsSlot, UI.el('div', { class: 'stack-sm' }, jobs.map((job) => {
            const deleteBtn = UI.el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Remove' });
            deleteBtn.addEventListener('click', async () => {
              const ok = await UI.confirmDialog({
                title: 'Remove posting?',
                body: `"${job.title}" will no longer be visible on the job board.`,
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!ok) return;
              try {
                UI.toast((await Api.del(`/jobs/${job.id}`)).message, 'success');
                loadMyJobs();
              } catch (error) { UI.toast(error.message, 'error'); }
            });

            return UI.el('div', { class: 'card', style: { padding: '14px' } }, [
              UI.el('div', { class: 'row row--between' }, [
                UI.el('div', { class: 'grow' }, [
                  UI.el('strong', { text: job.title }),
                  UI.el('p', { class: 'event-card__meta', style: { margin: '4px 0 0' }, text: `${job.company}${job.deadline ? ` · deadline ${UI.formatDate(job.deadline)}` : ''}` }),
                ]),
                UI.el('div', { class: 'row', style: { gap: '6px' } }, [
                  UI.el('span', { class: job.isActive ? 'badge badge--confirmed' : 'badge badge--cancelled', text: job.isActive ? 'Live' : 'Removed' }),
                  deleteBtn,
                ]),
              ]),
            ]);
          })));
        } catch (error) {
          UI.replace(jobsSlot, UI.errorState(error.message, loadMyJobs));
        }
      };

      Alumni.initJobPostPage();
      loadProfile();
      window.loadMyJobs();
    })();
  