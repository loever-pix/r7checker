// Shared server-side login helpers for the /login and /add pages.
//
// Credentials are POSTed to OUR server (/api/login), which authenticates with
// Ubisoft using the help/cases-page method through the rotating residential
// proxy. The password is used transiently to fetch your data and is never
// stored — only the resulting session ticket is kept (encrypted on disk).
//
// Exposes window.R6ServerLogin = { attachEmailPassSplit, serverLogin,
//                                   serverVerify2FA, goToProfile }.
(function () {
  'use strict';

  const TAG = '[r6-server-login]';

  // If the email field contains "email:password" (combolist format), move the
  // part AFTER the first colon into the password field. Emails never contain a
  // colon, so a colon is an unambiguous separator. Fires on input/paste/blur.
  function attachEmailPassSplit(emailEl, passwordEl) {
    if (!emailEl || !passwordEl) return;
    const split = () => {
      const v = emailEl.value;
      const i = v.indexOf(':');
      if (i === -1) return;
      emailEl.value = v.slice(0, i).trim();
      passwordEl.value = v.slice(i + 1);   // everything after the FIRST colon
      console.log(TAG, 'split email:pass paste into separate fields');
    };
    emailEl.addEventListener('input', split);
    emailEl.addEventListener('blur', split);
    // paste fires before the value updates — defer one tick so we read the result
    emailEl.addEventListener('paste', () => setTimeout(split, 0));
  }

  // POST email + password to the server-side login (proxy / cases-page method).
  // Returns one of:
  //   { ok:true, playerData }
  //   { requires2FA:true, twoFATicket }
  //   { ok:false, error }
  // Read the Cloudflare Turnstile token from a widget (within `root`, or page).
  function getTurnstileToken(root) {
    const el = (root || document).querySelector('[name="cf-turnstile-response"]');
    return el ? el.value : '';
  }

  async function serverLogin(email, password, turnstileToken) {
    let res;
    try {
      res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, turnstileToken }),
      });
    } catch (e) {
      return { ok: false, error: 'Network error: ' + (e.message || e) };
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.requires2FA) return { requires2FA: true, twoFATicket: data.twoFATicket };
    if (!res.ok) return { ok: false, error: data.error || ('HTTP ' + res.status) };
    return { ok: true, playerData: data.playerData };
  }

  async function serverVerify2FA(code, twoFATicket) {
    let res;
    try {
      res = await fetch('/api/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, twoFATicket }),
      });
    } catch (e) {
      return { ok: false, error: 'Network error: ' + (e.message || e) };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || ('HTTP ' + res.status) };
    return { ok: true, playerData: data.playerData };
  }

  // Persist the player data and redirect to the shareable profile URL.
  function goToProfile(playerData) {
    try { sessionStorage.setItem('r6player', JSON.stringify(playerData)); } catch {}
    // Honor ?return_to= so the marketplace sell flow can bounce us back after
    // the user finishes checking the account they want to list.
    try {
      const params = new URLSearchParams(location.search);
      const rt = params.get('return_to');
      if (rt && /^\/[a-zA-Z0-9/_\-?=&%.+]*$/.test(rt)) {
        window.location.href = rt;
        return;
      }
    } catch {}
    const url = playerData && playerData.userId
      ? '/profile/' + encodeURIComponent(playerData.userId)
      : '/locker';
    window.location.href = url;
  }

  window.R6ServerLogin = { attachEmailPassSplit, serverLogin, serverVerify2FA, goToProfile, getTurnstileToken };
})();
