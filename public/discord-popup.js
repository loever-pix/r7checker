// Randomly-appearing dismissible "Join our Discord" toast.
// Drop <script src="/discord-popup.js" defer></script> on any page.
(function () {
  var INVITE = 'https://discord.gg/gnPB2JBPS6';
  var SNOOZE_KEY = 'r6c_discord_snooze';
  var SNOOZE_MS = 30 * 60 * 1000;   // after closing, don't show again for 30 min
  var AUTO_HIDE_MS = 12000;          // auto-dismiss after 12s
  var MIN_DELAY = 12000, MAX_DELAY = 45000; // first appearance: random 12–45s
  var REPEAT_MIN = 90000, REPEAT_MAX = 240000; // re-appear every 1.5–4 min

  if (window.__r6cDiscordPopup) return; window.__r6cDiscordPopup = true;

  function snoozed() {
    try { return Date.now() < Number(localStorage.getItem(SNOOZE_KEY) || 0); } catch (e) { return false; }
  }
  function snooze() {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch (e) {}
  }

  // Inject styles once.
  var css = document.createElement('style');
  css.textContent = [
    '.r6c-dpop{position:fixed;right:18px;bottom:18px;z-index:9999;max-width:330px;',
      'background:#0c1424;border:1px solid #1a2540;border-left:4px solid #5865f2;',
      'border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.55);',
      'font-family:system-ui,-apple-system,sans-serif;color:#e8eef7;',
      'padding:.9rem 1rem .95rem;transform:translateY(140%);opacity:0;',
      'transition:transform .45s cubic-bezier(.2,.9,.3,1.2),opacity .35s;}',
    '.r6c-dpop.show{transform:translateY(0);opacity:1;}',
    '.r6c-dpop .x{position:absolute;top:.5rem;right:.6rem;cursor:pointer;color:#7d8aa3;',
      'font-size:1.05rem;line-height:1;background:none;border:none;padding:.1rem .2rem;}',
    '.r6c-dpop .x:hover{color:#e8eef7;}',
    '.r6c-dpop .row{display:flex;align-items:center;gap:.7rem;}',
    '.r6c-dpop .ico{width:40px;height:40px;border-radius:10px;background:#5865f2;',
      'display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.r6c-dpop .ico svg{width:24px;height:24px;fill:#fff;}',
    '.r6c-dpop .t{font-weight:700;font-size:.92rem;margin-bottom:.1rem;}',
    '.r6c-dpop .s{font-size:.78rem;color:#7d8aa3;line-height:1.35;}',
    '.r6c-dpop .btn{display:block;margin-top:.7rem;text-align:center;background:#5865f2;',
      'color:#fff;text-decoration:none;font-weight:600;font-size:.85rem;',
      'padding:.5rem;border-radius:8px;transition:background .15s;}',
    '.r6c-dpop .btn:hover{background:#4752c4;}',
    '@media(max-width:480px){.r6c-dpop{right:10px;left:10px;bottom:10px;max-width:none;}}'
  ].join('');
  document.head.appendChild(css);

  var el = document.createElement('div');
  el.className = 'r6c-dpop';
  el.setAttribute('role', 'complementary');
  el.innerHTML =
    '<button class="x" aria-label="Close">✕</button>' +
    '<div class="row">' +
      '<div class="ico"><svg viewBox="0 0 24 24"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.65 12.65 0 0 0-.617-1.249.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg></div>' +
      '<div><div class="t">Join our Discord</div><div class="s">Support, updates & giveaways. Tap in — it’s free.</div></div>' +
    '</div>' +
    '<a class="btn" href="' + INVITE + '" target="_blank" rel="noopener noreferrer">Join Server</a>';
  document.body.appendChild(el);

  var hideTimer = null;
  function show() {
    if (snoozed()) { schedule(REPEAT_MIN, REPEAT_MAX); return; }
    el.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, AUTO_HIDE_MS);
  }
  function hide(userClosed) {
    el.classList.remove('show');
    clearTimeout(hideTimer);
    if (userClosed) snooze();
    schedule(REPEAT_MIN, REPEAT_MAX);
  }
  function schedule(min, max) {
    var d = min + Math.floor(Math.random() * (max - min));
    setTimeout(show, d);
  }

  el.querySelector('.x').addEventListener('click', function () { hide(true); });
  // Clicking "Join" also snoozes so it doesn't keep nagging.
  el.querySelector('.btn').addEventListener('click', function () { snooze(); setTimeout(function(){ hide(false); }, 200); });

  // First appearance at a random delay.
  schedule(MIN_DELAY, MAX_DELAY);
})();
