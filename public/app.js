// ── Shared helpers ────────────────────────────────

function qs(sel, root = document) { return root.querySelector(sel); }
function num(n) { return Number(n).toLocaleString(); }

function toggleSection(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('collapsed');
}

// (Login UI lives in login.html / add.html via server-login.js.)

// ── LOCKER PAGE ───────────────────────────────────

const lockerPage = qs('.locker-page');
if (lockerPage) {
  // Profile pages inject data directly; logins use sessionStorage
  const player = window.__PROFILE_DATA__ ?? JSON.parse(sessionStorage.getItem('r6player') ?? 'null');
  if (!player) {
    window.location.href = '/';
  } else {
    renderLocker(player);
  }
}

function renderLocker(p) {
  // Top bar
  const avatar = qs('#avatar');
  avatar.src = p.avatar;
  avatar.onerror = () => { avatar.src = 'https://ubisoft-avatars.akamaized.net/default/default_146_146.png'; };
  qs('#username').textContent = p.username;
  // Level endpoint is 404 — hide the level row rather than show "Level 0"
  const levelRow = qs('.user-level');
  if (p.level) {
    qs('#level').textContent = p.level;
  } else if (levelRow) {
    levelRow.style.display = 'none';
  }
  // Renown / Credits endpoints are dead — hide the whole row when both are 0
  const renownVal  = p.renown  ?? 0;
  const creditsVal = p.credits ?? 0;
  if (renownVal)  qs('#renown').textContent  = num(renownVal);
  if (creditsVal) qs('#credits').textContent = num(creditsVal);
  if (!renownVal && !creditsVal) {
    const statsRow = qs('.stats-row');
    if (statsRow) statsRow.style.display = 'none';
  }

  // Linked platforms — render as clickable deep-links to the right
  // external site for that account type. Falls back to a plain badge
  // when we don't have a username to build the URL.
  const platformsEl = qs('#platforms');
  const platformLabels = {
    uplay: 'Ubisoft', psn: 'PlayStation', xbox: 'Xbox', xbl: 'Xbox',
    steam: 'Steam',  twitch: 'Twitch',  youtube: 'YouTube',  discord: 'Discord',
  };
  // tracker.network's URL slug per gaming platform.
  const trackerSlug = { uplay: 'ubi', xbox: 'xbl', xbl: 'xbl', psn: 'psn', steam: 'steam' };
  // Streaming/social links go to the platform's own site, not tracker.network.
  const externalLink = {
    twitch:  handle => `https://twitch.tv/${encodeURIComponent(handle)}`,
    youtube: handle => `https://youtube.com/@${encodeURIComponent(handle)}`,
  };
  const accountsByPlatform = {};
  for (const a of (p.linkedAccounts ?? [])) accountsByPlatform[a.platform] = a;

  // BANNED badge — first, before platform buttons, in red.
  if (p.banned) {
    const banned = document.createElement('span');
    banned.className = 'platform-badge banned-badge';
    banned.textContent = 'BANNED' + (p.banReason ? ` (${p.banReason})` : '');
    banned.title = p.banReason || 'Account has an active Ubisoft sanction';
    platformsEl.appendChild(banned);
  }

  (p.linkedPlatforms ?? []).forEach(plat => {
    const label    = platformLabels[plat] ?? (plat.charAt(0).toUpperCase() + plat.slice(1));
    const slug     = trackerSlug[plat];
    const account  = accountsByPlatform[plat];
    const handle   = account?.username || account?.idOnPlatform || '';
    let href = null, hoverTitle = null;
    if (slug && handle) {
      // Gaming platform → tracker.network deep-link
      href = `https://r6.tracker.network/r6siege/profile/${slug}/${encodeURIComponent(handle)}`;
      hoverTitle = `Open ${label} profile on r6.tracker.network`;
    } else if (externalLink[plat] && handle) {
      // Streaming / social platform → its own native site
      href = externalLink[plat](handle);
      hoverTitle = `Open ${label} channel`;
    }
    if (href) {
      const a = document.createElement('a');
      a.className = 'platform-badge platform-link';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label + ' ↗';
      a.title = hoverTitle;
      platformsEl.appendChild(a);
    } else {
      const badge = document.createElement('span');
      badge.className = 'platform-badge';
      badge.textContent = label;
      platformsEl.appendChild(badge);
    }
  });

  // Ghost consoles — Xbox/PSN accounts Ubisoft USED to link but no longer does.
  // We still surface them (deep-linked to tracker) with a Ghost marker.
  const consoleLabel = { xbl: 'Xbox', psn: 'PSN' };
  (p.linkedConsoles ?? []).forEach(c => {
    if (!c.ghost) return; // currently-linked consoles already shown above
    const label  = consoleLabel[c.platform] || c.platform.toUpperCase();
    const a = document.createElement('a');
    a.className = 'platform-badge platform-link';
    a.href = `https://r6.tracker.network/r6siege/profile/${c.platform}/${encodeURIComponent(c.handle)}`;
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = `👻 ${label} ↗`;
    a.title = `${label} (${c.handle}) was linked previously but is no longer linked on Ubisoft`;
    a.style.opacity = '.75';
    platformsEl.appendChild(a);
  });

  // Combat stats + operator hero art (tracker.gg) — no-op if data absent
  renderCombatStats(p.trackerStats);
  applyHeroArt(p.trackerStats);

  // Season ranks
  const rankCards = qs('#rank-cards');

  if (!p.seasonRanks?.length) {
    rankCards.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;">No ranked seasons found</div>';
  } else {
    p.seasonRanks.forEach(r => {
      const card = document.createElement('div');
      card.className = `rank-card tier-${r.rankTier}`;

      // Rank badge image wrapper (allows champion number overlay)
      const badgeWrap = document.createElement('div');
      badgeWrap.className = 'rank-badge-wrap';

      const sz = r.rankTier === 'champion' ? 56 : 44;
      const badgeEl = document.createElement('img');
      badgeEl.className = 'rank-badge-img';
      badgeEl.src = r.iconUrl ?? '';
      badgeEl.alt = r.rankName;
      badgeEl.width = sz;
      badgeEl.height = sz;
      badgeEl.onerror = () => {
        badgeEl.style.display = 'none';
        const fb = document.createElement('div');
        fb.className = 'rank-icon';
        fb.textContent = r.rankTier === 'champion' ? '♛' :
          r.rankName.split(' ').map(w => w[0] ?? '').join('').slice(0, 2);
        badgeWrap.prepend(fb);
      };
      badgeWrap.appendChild(badgeEl);

      // (Champion rank position number overlay removed — numbered champ badges
      // no longer show the #position on the rank/charm display.)

      const infoEl = document.createElement('div');
      infoEl.className = 'rank-info';

      // Season name (coloured by tier via CSS)
      const seasonNameEl = document.createElement('div');
      seasonNameEl.className = 'rank-season-name';
      seasonNameEl.textContent = r.seasonName;

      // "4,643 RP  ·  Champions"
      const detailEl = document.createElement('div');
      detailEl.className = 'rank-name-label';
      const rpStr = r.mmr ? `${Number(r.mmr).toLocaleString()} RP` : '';
      detailEl.textContent = [rpStr, r.rankName].filter(Boolean).join('  ·  ');

      infoEl.appendChild(seasonNameEl);
      infoEl.appendChild(detailEl);

      // Platform chip — shows which platform this season's HIGHEST rank was
      // played on (Xbox / PSN). PC seasons get no chip to keep things clean.
      // A "Ghost" tag marks a console that's no longer linked on Ubisoft.
      const platLabel = { xbl: 'Xbox', xbox: 'Xbox', psn: 'PSN' }[r.platform];
      if (platLabel || r.ghost) {
        const chip = document.createElement('span');
        chip.className = 'rank-plat-chip';
        chip.style.cssText = 'display:inline-block;margin-top:3px;padding:1px 6px;border-radius:4px;font-size:.62rem;font-weight:700;letter-spacing:.03em;background:rgba(58,141,255,.16);color:#7db0ff;border:1px solid rgba(58,141,255,.35);';
        chip.textContent = platLabel || 'CONSOLE';
        infoEl.appendChild(chip);
        if (r.ghost) {
          const g = document.createElement('span');
          g.style.cssText = 'display:inline-block;margin:3px 0 0 4px;padding:1px 6px;border-radius:4px;font-size:.62rem;font-weight:700;background:rgba(150,150,170,.15);color:#9aa3b8;border:1px solid rgba(150,150,170,.35);';
          g.textContent = '👻 Ghost';
          g.title = 'This console was linked before but is no longer linked on Ubisoft';
          infoEl.appendChild(g);
        }
      }
      card.appendChild(badgeWrap);
      card.appendChild(infoEl);
      rankCards.appendChild(card);
    });
  }

  // Inventory sections — rendered dynamically from sections array
  const container = qs('#inventory-sections');
  (p.sections ?? []).forEach(section => {
    renderSection(container, section.title, section.key, section.items);
  });
}

// ── Combat stats (tracker.gg) ─────────────────────
// trackerStats shape: { overview:{stat:{value,display}}, gamemodes:[...], heroUrl }
function renderCombatStats(ts) {
  const host = qs('#combat-stats');
  if (!host || !ts || !ts.overview) return;
  const ov = ts.overview;

  const defs = [
    ['K/D', ov.kdRatio],
    ['Win %', ov.winPct],
    ['Headshot %', ov.headshotPct],
    ['Kills', ov.kills],
    ['Matches', ov.matchesPlayed],
    ['Kills / Match', ov.killsPerMatch],
    ['Deaths', ov.deaths],
    ['Time Played', ov.timePlayed],
  ].filter(([, s]) => s && s.display != null);
  if (!defs.length) return;

  host.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'cs-title';
  title.appendChild(document.createTextNode('Combat Stats'));
  const src = document.createElement('span');
  src.className = 'cs-src';
  src.textContent = 'via tracker.gg';
  title.appendChild(src);
  host.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'cs-grid';
  defs.forEach(([label, s]) => {
    const tile = document.createElement('div');
    tile.className = 'stat-tile';
    const v = document.createElement('span');
    v.className = 'st-val';
    v.textContent = s.display;
    const l = document.createElement('span');
    l.className = 'st-label';
    l.textContent = label;
    tile.appendChild(v);
    tile.appendChild(l);
    grid.appendChild(tile);
  });
  host.appendChild(grid);

  // Per-gamemode pills (Ranked, Casual, Event, …)
  const modes = (ts.gamemodes ?? []).filter(m => m.matches && m.matches.value);
  if (modes.length) {
    const row = document.createElement('div');
    row.className = 'cs-modes';
    modes.forEach(m => {
      const pill = document.createElement('div');
      pill.className = 'cs-mode';

      const name = document.createElement('span');
      name.className = 'm-name';
      name.textContent = m.name;
      pill.appendChild(name);

      const stat = document.createElement('span');
      stat.className = 'm-stat';
      if (m.kd && m.kd.display != null) {
        const b = document.createElement('b');
        b.textContent = m.kd.display;
        stat.appendChild(b);
        stat.appendChild(document.createTextNode(' K/D'));
      }
      if (m.matches && m.matches.display) {
        if (stat.childNodes.length) stat.appendChild(document.createTextNode(' · '));
        stat.appendChild(document.createTextNode(`${m.matches.display} matches`));
      }
      pill.appendChild(stat);
      row.appendChild(pill);
    });
    host.appendChild(row);
  }

  host.style.display = 'block';
}

// Operator hero art as a faint banner behind the user hero. Only applied once
// the image actually loads, so a 403/404 never leaves a half-painted banner.
function applyHeroArt(ts) {
  if (!ts || !ts.heroUrl) return;
  const hero = qs('.user-hero');
  if (!hero) return;
  const probe = new Image();
  probe.onload = () => {
    hero.style.backgroundImage =
      `linear-gradient(90deg, var(--bg-card) 38%, rgba(12,20,36,.55) 72%, rgba(12,20,36,.25)), url("${ts.heroUrl}")`;
    hero.style.backgroundSize = 'cover';
    hero.style.backgroundPosition = 'right center';
  };
  probe.src = ts.heroUrl;
}

function renderSection(parent, title, key, items) {
  if (!items || !items.length) return;

  const sec = document.createElement('div');
  sec.className = 'section';
  sec.id = `${key}-section`;

  const header = document.createElement('div');
  header.className = 'section-header';
  header.addEventListener('click', () => sec.classList.toggle('collapsed'));

  const titleEl = document.createElement('span');
  titleEl.className = 'section-title';
  titleEl.textContent = `${title} (${items.length})`;
  header.appendChild(titleEl);

  const toggle = document.createElement('span');
  toggle.className = 'section-toggle';
  toggle.textContent = '▼';
  header.appendChild(toggle);

  sec.appendChild(header);

  const pills = document.createElement('div');
  pills.className = 'pills';

  items.forEach(item => {
    const pill = document.createElement('button');
    pill.className = 'pill';
    pill.dataset.rarity = (item.rarity ?? 'standard').toLowerCase();
    if (item.rankTier) pill.dataset.tier = item.rankTier;

    if (item.rankTier && item.image) {
      const icon = document.createElement('img');
      icon.src = item.image;
      icon.className = 'pill-rank-icon';
      icon.alt = '';
      icon.width = 14;
      icon.height = 14;
      icon.onerror = () => { icon.style.display = 'none'; };
      pill.appendChild(icon);
      pill.appendChild(document.createTextNode(item.name));
    } else {
      pill.textContent = item.name;
    }

    pill.addEventListener('click', () => openModal(item));
    pills.appendChild(pill);
  });

  sec.appendChild(pills);
  parent.appendChild(sec);
}

// ── MODAL ─────────────────────────────────────────

const backdrop = qs('#modal-backdrop');
if (backdrop) {
  qs('#modal-close').addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
}

const PLACEHOLDER_SVG = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">' +
  '<rect width="180" height="180" fill="#1c1c1c" rx="8"/>' +
  '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#444" font-size="60">?</text>' +
  '</svg>'
);

function openModal(item) {
  const img = qs('#modal-image');
  img.style.background = 'var(--surface2)';

  if (item.image) {
    img.src = item.image;
    img.onerror = () => { img.src = PLACEHOLDER_SVG; img.onerror = null; };
  } else {
    img.src = PLACEHOLDER_SVG;
    img.onerror = null;
  }

  qs('#modal-name').textContent = item.name;

  const rarityEl  = qs('#modal-rarity');
  const rarityKey = (item.rarity ?? 'standard').toLowerCase();
  rarityEl.textContent = item.rarity ?? 'Standard';
  rarityEl.className   = `badge badge-rarity-${rarityKey}`;

  const typeEl = qs('#modal-type');
  typeEl.textContent = item.type ?? 'Item';
  // Show rank tier badge for ranked charms
  if (item.rankTier) {
    typeEl.textContent = `Ranked Charm`;
  }

  backdrop.classList.add('open');
}

function closeModal() {
  backdrop.classList.remove('open');
}
