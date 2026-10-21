'use strict';

/**
 * js/auth.js
 * Client-side session handling, route guards and the auth forms.
 *
 * Division of responsibility:
 *   - The SERVER decides what you may do (every API route re-checks the role).
 *   - This module only decides where to SEND you, and what to render. It is a
 *     convenience layer, never a security boundary.
 */

const Auth = (() => {
  /** Cached copy of the current user object (not a credential). */
  let currentUser = null;

  const DASHBOARDS = {
    student: '/student-dashboard.html',
    alumni: '/alumni-dashboard.html',
    admin: '/admin.html',
  };

  // -------------------------------------------------------------------------
  // Cached user
  // -------------------------------------------------------------------------

  function setCachedUser(user) { currentUser = user || null; }
  function getCachedUser() { return currentUser; }
  function clearCachedUser() { currentUser = null; }
  function isSignedIn() { return Boolean(currentUser) || Api.hasSession(); }

  // -------------------------------------------------------------------------
  // Session restoration
  // -------------------------------------------------------------------------

  /**
   * Called on every page load. Attempts a silent refresh using the HttpOnly
   * cookie. Never throws - a visitor without a session simply stays anonymous.
   */
  async function init() {
    if (Api.hasSession()) {
      // We already hold an access token in memory; confirm the profile matches.
      try {
        const body = await Api.get('/auth/me');
        currentUser = body.data.user;
      } catch (_) { /* keep whatever we had */ }
      return currentUser;
    }

    const result = await Api.refreshSession();
    if (result.ok && result.user) {
      currentUser = result.user;
      // The user may have been suspended since the cookie was issued.
      if (currentUser.isActive === false) {
        await signOut();
        return null;
      }
    }
    return currentUser;
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  /**
   * Ensure the visitor holds one of the given roles, otherwise redirect.
   * @param {string[]} roles
   * @returns {Promise<Object|null>} the user, or null when redirected
   */
  async function requireRole(roles, activeKey = 'dashboard') {
    const user = await init();
    if (!user) {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/login.html?returnTo=${returnTo}`);
      return null;
    }
    if (!roles.includes(user.role)) {
      // Send them to their OWN dashboard rather than a dead end.
      window.location.replace(DASHBOARDS[user.role] || '/index.html');
      return null;
    }
    // Access confirmed. Pages such as the dashboards guard by role DIRECTLY
    // instead of calling boot(), so without rendering the shared chrome here
    // those pages would never get a navbar (or a mobile hamburger). This is
    // idempotent, so a page that already booted is unaffected.
    renderChromeFor(buildNavbarChrome(activeKey), user);
    return user;
  }

  /** Sign in is not allowed once authenticated - bounce to the right place. */
  async function requireAnonymous() {
    const user = await init();
    if (user) {
      window.location.replace(DASHBOARDS[user.role] || '/index.html');
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Navbar session controls
  // -------------------------------------------------------------------------

  /** Render the sign-in / account area on the right of the navbar. */
  function renderSessionControls(container) {
    UI.clear(container);
    const user = currentUser;

    if (!user) {
      container.appendChild(UI.el('a', { class: 'btn btn--ghost', href: '/login.html', text: 'Sign in' }));
      container.appendChild(UI.el('a', { class: 'btn btn--primary', href: '/register.html', text: 'Create account' }));
      return;
    }

    container.appendChild(UI.el('span', {
      class: 'badge badge--role',
      text: user.role.charAt(0).toUpperCase() + user.role.slice(1),
      title: `Signed in as ${user.email}`,
    }));

    const dashboard = DASHBOARDS[user.role] || '/index.html';
    container.appendChild(UI.el('a', { class: 'navbar__link', href: dashboard, text: 'Dashboard' }));
    container.appendChild(UI.el('a', { class: 'navbar__link', href: '/profile.html', text: 'Profile' }));

    const signOutBtn = UI.el('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Sign out' });
    signOutBtn.addEventListener('click', async () => {
      await signOut();
      window.location.href = '/index.html';
    });
    container.appendChild(signOutBtn);
  }

  /** Revoke the server session and clear all client state. */
  async function signOut() {
    try { await Api.post('/auth/logout', {}); } catch (_) { /* best effort */ }
    Api.setAccessToken(null);
    clearCachedUser();
  }

  // -------------------------------------------------------------------------
  // Shared page chrome
  // -------------------------------------------------------------------------

  /**
   * Build the shared navbar chrome (brand, hamburger, links, actions slot).
   *
   * IDEMPOTENT: a page can reach this twice - e.g. admin.html calls boot(),
   * and its module then calls requireRole(). The `dataset.rendered` guard means
   * only the first call appends anything, so the navbar is never duplicated.
   *
   * @param {string} activeKey which nav item to highlight
   * @returns {HTMLElement|null} the actions slot to fill with session controls,
   *   or null when there is no #shell-nav (or it is already built).
   */
  function buildNavbarChrome(activeKey) {
    const shell = document.getElementById('shell-nav');
    if (!shell || shell.dataset.rendered === 'true') return null;

    const brand = UI.el('a', { class: 'navbar__brand', href: '/index.html' }, [
      // The glyph is painted by CSS (.navbar__logo::before) so it is
      // identical on every page.
      UI.el('span', { class: 'navbar__logo', 'aria-hidden': 'true' }),
      UI.el('span', { text: 'Campus Portal' }),
    ]);

    const toggle = UI.el('button', {
      class: 'navbar__toggle', type: 'button',
      'aria-label': 'Toggle navigation menu', 'aria-expanded': 'false', 'aria-controls': 'primary-nav',
    });

    const nav = UI.buildNavbar(activeKey);
    const actions = UI.el('div', { class: 'navbar__actions' });

    // The account controls live INSIDE the collapsible <nav>, so on
    // tablet/mobile they fold into the hamburger dropdown (matching the CSS,
    // which styles .navbar__actions as the dropdown's footer section) instead
    // of overflowing the header. On desktop the base rule parks them right.
    nav.appendChild(actions);

    shell.appendChild(UI.el('div', { class: 'container navbar__inner' }, [brand, toggle, nav]));

    // The two bars become a cross purely in CSS, keyed off aria-expanded.
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    // Close the menu after choosing a link (important on mobile).
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });

    shell.dataset.rendered = 'true';
    return actions;
  }

  /**
   * Fill the navbar's actions slot (sign-in / avatar menu) and show the
   * email-verification banner when the user still needs to confirm.
   *
   * @param {HTMLElement|null} actions slot returned by buildNavbarChrome()
   * @param {Object|null} user
   */
  function renderChromeFor(actions, user) {
    if (!actions) return;
    renderSessionControls(actions);
    // Show a "confirm your email" banner wherever it is relevant.
    if (user && !user.emailVerified) {
      renderVerificationBanner(user);
    }
  }

  /**
   * Build the navbar, restore the session and expose the current user to the
   * page's own render function.
   *
   * @param {string} activeKey which nav item to highlight
   * @param {Function} [onReady] called with the user (or null)
   */
  async function boot(activeKey, onReady) {
    const actions = buildNavbarChrome(activeKey);
    const user = await init();
    renderChromeFor(actions, user);
    if (typeof onReady === 'function') onReady(user);
    return user;
  }

  /** Persistent warning shown to users who have not confirmed their address. */
  function renderVerificationBanner(user) {
    const slot = document.getElementById('verification-banner');
    if (!slot) return;
    UI.replace(slot, UI.el('div', { class: 'alert alert--warning', role: 'alert' }, [
      UI.el('div', { class: 'grow' }, [
        UI.el('strong', { text: 'Confirm your email address' }),
        UI.el('span', { text: 'Some features are locked until you click the verification link we emailed you.' }),
      ]),
    ]));

    const resend = UI.el('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Resend link' });
    resend.addEventListener('click', async () => {
      const restore = UI.withButtonBusy(resend, 'Sending…');
      try {
        const body = await Api.post('/auth/resend-verification', {});
        UI.toast(body.message, 'success');
      } catch (error) {
        UI.toast(error.message, 'error');
      } finally { restore(); }
    });
    slot.firstChild.appendChild(resend);
  }

  // -------------------------------------------------------------------------
  // Password policy widget (mirrors utils/passwordPolicy.js on the server)
  // -------------------------------------------------------------------------

  const PASSWORD_RULES = [
    { key: 'length', label: 'At least 8 characters', test: (v) => v.length >= 8 },
    { key: 'uppercase', label: 'One uppercase letter', test: (v) => /[A-Z]/.test(v) },
    { key: 'lowercase', label: 'A lowercase letter or symbol', test: (v) => /[a-z]/.test(v) || /[^A-Za-z0-9]/.test(v) },
    { key: 'digit', label: 'At least one number', test: (v) => /[0-9]/.test(v) },
  ];

  /** Attach live rule feedback + a strength meter to a password input. */
  function attachPasswordChecks(input, listEl) {
    if (!input || !listEl) return () => false;

    UI.clear(listEl);
    const items = PASSWORD_RULES.map((rule) => {
      const li = UI.el('li', { text: rule.label, 'data-rule': rule.key });
      listEl.appendChild(li);
      return { rule, li };
    });

    const meter = UI.el('div', { class: 'strength', 'aria-hidden': 'true' });
    const bars = [0, 1, 2].map(() => {
      const bar = UI.el('div', { class: 'strength__bar' });
      meter.appendChild(bar);
      return bar;
    });
    const strengthLabel = UI.el('span', { class: 'strength__label', text: '' });
    const wrap = UI.el('div', { class: 'stack-sm' }, [meter, strengthLabel]);
    listEl.parentNode.insertBefore(wrap, listEl);

    function evaluate() {
      const value = input.value;
      let passed = 0;
      for (const { rule, li } of items) {
        const met = rule.test(value);
        li.classList.toggle('is-met', met);
        if (met) passed += 1;
      }
      const level = value.length === 0 ? 0 : Math.min(3, Math.max(1, passed - 1));
      bars.forEach((bar, index) => {
        bar.className = 'strength__bar' + (index < level ? ` is-on-${level}` : '');
      });
      strengthLabel.textContent = ['', 'Weak', 'Fair', 'Strong'][level] || '';
      return passed === items.length;
    }

    input.addEventListener('input', evaluate);
    return evaluate;
  }

  // -------------------------------------------------------------------------
  // Login page
  // -------------------------------------------------------------------------

  function initLoginPage() {
    const form = document.getElementById('login-form');
    if (!form) return;

    requireAnonymous().then((ok) => { if (!ok) return; });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);

      const submit = form.querySelector('[type="submit"]');
      const restore = UI.withButtonBusy(submit, 'Signing in…');

      try {
        const body = await Api.post('/auth/login', {
          email: form.email.value.trim(),
          password: form.password.value,
        });

        Api.setAccessToken(body.data.accessToken);
        setCachedUser(body.data.user);

        const params = new URLSearchParams(window.location.search);
        const returnTo = params.get('returnTo');
        const target = returnTo && returnTo.startsWith('/')
          ? returnTo
          : (DASHBOARDS[body.data.user.role] || '/index.html');

        UI.toast(`Welcome back, ${body.data.user.name.split(' ')[0]}!`, 'success');
        window.location.href = target;
      } catch (error) {
        UI.renderFieldErrors(form, error);
        if (!error.details) {
          UI.toast(error.message, 'error');
          const slot = document.getElementById('login-error');
          if (slot) UI.replace(slot, UI.el('div', { class: 'alert alert--danger', role: 'alert', text: error.message }));
        }
        restore();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Registration page
  // -------------------------------------------------------------------------

  function initRegisterPage() {
    const form = document.getElementById('register-form');
    if (!form) return;

    requireAnonymous().then((ok) => { if (!ok) return; });

    // Live password feedback.
    const evaluate = attachPasswordChecks(form.password, document.getElementById('password-rules'));

    // Show / hide the alumni-only section based on the chosen role.
    const alumniFields = document.getElementById('alumni-fields');
    function syncRole() {
      const isAlumni = form.role.value === 'alumni';
      alumniFields.classList.toggle('is-visible', isAlumni);
      alumniFields.querySelectorAll('input').forEach((input) => {
        input.disabled = !isAlumni;
        if (isAlumni) input.setAttribute('required', 'required');
        else input.removeAttribute('required');
      });
    }
    form.querySelectorAll('input[name="role"]').forEach((radio) => radio.addEventListener('change', syncRole));
    syncRole();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);

      // Client side validation mirrors the server rules for instant feedback.
      if (!evaluate()) {
        UI.toast('Please fix the password requirements highlighted below.', 'warning');
        form.password.focus();
        return;
      }
      if (form.password.value !== form.confirmPassword.value) {
        UI.toast('The two passwords do not match.', 'warning');
        form.confirmPassword.focus();
        return;
      }

      const submit = form.querySelector('[type="submit"]');
      const restore = UI.withButtonBusy(submit, 'Creating your account…');

      const payload = {
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        password: form.password.value,
        confirmPassword: form.confirmPassword.value,
        role: form.role.value,
        collegeId: form.collegeId.value.trim(),
      };
      if (payload.role === 'alumni') {
        payload.graduationYear = Number(form.graduationYear.value);
        payload.degree = form.degree.value.trim();
        payload.company = form.company.value.trim();
        payload.designation = form.designation.value.trim();
      }

      try {
        await Api.post('/auth/register', payload);
        const notice = document.getElementById('register-success');
        if (notice) {
          UI.replace(notice, UI.el('div', { class: 'alert alert--success', role: 'status' }, [
            UI.el('div', {}, [
              UI.el('strong', { text: 'Account created' }),
              UI.el('span', {
                text: 'Check your inbox for the verification link, then sign in. '
                  + 'If SMTP is not configured in development, the link is printed in the server console.',
              }),
            ]),
          ]));
          notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        form.reset();
        UI.toast('Account created. Please verify your email.', 'success');
      } catch (error) {
        UI.renderFieldErrors(form, error);
        if (!error.details) UI.toast(error.message, 'error');
      } finally {
        restore();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Forgot / reset password
  // -------------------------------------------------------------------------

  function initForgotPasswordPage() {
    const form = document.getElementById('forgot-form');
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      const restore = UI.withButtonBusy(submit, 'Sending…');
      try {
        const body = await Api.post('/auth/forgot-password', { email: form.email.value.trim() });
        UI.replace(document.getElementById('forgot-result'),
          UI.el('div', { class: 'alert alert--success', role: 'status' }, [
            UI.el('div', {}, [
              UI.el('strong', { text: 'Check your inbox' }),
              UI.el('span', { text: body.message }),
            ]),
            body.data && body.data.note ? UI.el('span', { class: 'field__hint', text: body.data.note }) : null,
          ]));
      } catch (error) {
        UI.toast(error.message, 'error');
      } finally { restore(); }
    });
  }

  function initResetPasswordPage() {
    const form = document.getElementById('reset-form');
    if (!form) return;

    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      UI.replace(document.getElementById('reset-result'),
        UI.el('div', { class: 'alert alert--danger', role: 'alert', text: 'This reset link is missing its token. Please request a new one.' }));
      form.remove();
      return;
    }

    const evaluate = attachPasswordChecks(form.password, document.getElementById('reset-rules'));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);
      if (!evaluate()) { UI.toast('Please meet the password requirements.', 'warning'); return; }
      if (form.password.value !== form.confirmPassword.value) {
        UI.toast('The two passwords do not match.', 'warning'); return;
      }

      const submit = form.querySelector('[type="submit"]');
      const restore = UI.withButtonBusy(submit, 'Updating…');
      try {
        await Api.post('/auth/reset-password', {
          token,
          password: form.password.value,
          confirmPassword: form.confirmPassword.value,
        });
        UI.replace(document.getElementById('reset-result'),
          UI.el('div', { class: 'alert alert--success', role: 'status', text: 'Password changed. You can now sign in with your new password.' }));
        form.remove();
        UI.toast('Password changed successfully.', 'success');
        setTimeout(() => { window.location.href = '/login.html'; }, 1600);
      } catch (error) {
        UI.renderFieldErrors(form, error);
        if (!error.details) {
          UI.replace(document.getElementById('reset-result'),
            UI.el('div', { class: 'alert alert--danger', role: 'alert', text: error.message }));
        }
      } finally { restore(); }
    });
  }

  // -------------------------------------------------------------------------
  // Email verification page
  // -------------------------------------------------------------------------

  function initVerifyEmailPage() {
    const slot = document.getElementById('verify-result');
    if (!slot) return;

    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      UI.replace(slot, UI.el('div', { class: 'alert alert--danger', role: 'alert' }, [
        UI.el('strong', { text: 'Link incomplete' }),
        UI.el('span', { text: 'This verification link is missing its token. Request a new one from your profile page.' }),
      ]));
      return;
    }

    UI.replace(slot, UI.loadingState('Verifying your email address…'));

    // Verification is a plain GET, so it needs no access token.
    Api.request(`/auth/verify-email?token=${encodeURIComponent(token)}`, { auth: false })
      .then((body) => {
        UI.replace(slot, UI.el('div', { class: 'alert alert--success', role: 'status' }, [
          UI.el('div', {}, [
            UI.el('strong', { text: 'Email verified' }),
            UI.el('span', { text: body.message }),
          ]),
        ]));
        slot.appendChild(UI.el('a', { class: 'btn btn--primary', href: '/login.html', text: 'Continue to sign in' }));
      })
      .catch((error) => {
        UI.replace(slot, UI.el('div', { class: 'alert alert--danger', role: 'alert' }, [
          UI.el('div', {}, [
            UI.el('strong', { text: 'Verification failed' }),
            UI.el('span', { text: error.message }),
          ]),
        ]));
        slot.appendChild(UI.el('a', { class: 'btn btn--secondary', href: '/login.html', text: 'Go to sign in' }));
      });
  }

  return {
    init, boot, requireRole, requireAnonymous,
    setCachedUser, getCachedUser, clearCachedUser, isSignedIn,
    renderSessionControls, signOut, attachPasswordChecks,
    initLoginPage, initRegisterPage, initForgotPasswordPage,
    initResetPasswordPage, initVerifyEmailPage,
    DASHBOARDS,
  };
})();
