/*
 * Sponsor Roulette: DOM wiring and the load/spin flows.
 * Pure helpers (API, cache, picks) live in helpers.js.
 */

const $ = (id) => document.getElementById(id);

// All DOM nodes we touch, looked up once.
const els = {
  authSection: $('auth'),
  loadSection: $('load'),
  spinSection: $('spin'),
  resultsSection: $('results'),
  tokenInput: $('token-input'),
  saveToken: $('save-token'),
  forgetToken: $('forget-token'),
  tokenStatus: $('token-status'),
  loadStars: $('load-stars'),
  refreshStars: $('refresh-stars'),
  loadStatus: $('load-status'),
  loadSummary: $('load-summary'),
  pickCount: $('pick-count'),
  spinButton: $('spin-button'),
  results: $('results-container'),
};

// Module-level state. No framework, no reactivity.
let stars = [];
let sponsorable = [];

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

// Grey out everything that needs a token.
function setSectionsEnabled(enabled) {
  els.loadSection.classList.toggle('disabled', !enabled);
  els.spinSection.classList.toggle('disabled', !enabled);
  els.resultsSection.classList.toggle('disabled', !enabled);
}

// With a token: collapse auth, enable the rest. Without: expand and reset.
function refreshTokenStatus() {
  const t = getToken();
  if (t) {
    els.authSection.classList.add('compact');
    setSectionsEnabled(true);
    els.tokenInput.value = '';
    setStatus(els.tokenStatus, '', '');
  } else {
    els.authSection.classList.remove('compact');
    els.loadSection.classList.remove('compact');
    setSectionsEnabled(false);
    els.tokenInput.placeholder = 'ghp_...';
    setStatus(els.tokenStatus, '', '');
  }
}

els.saveToken.addEventListener('click', () => {
  const t = els.tokenInput.value.trim();
  if (!t) {
    setStatus(els.tokenStatus, 'Paste a token first.', 'warn');
    return;
  }
  localStorage.setItem(TOKEN_KEY, t);
  refreshTokenStatus();
});

// Forget wipes token + cache + in-memory state, so a fresh Load starts clean.
els.forgetToken.addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(CACHE_KEY);
  stars = [];
  sponsorable = [];
  els.spinButton.disabled = true;
  els.results.innerHTML = '';
  els.loadSummary.textContent = '';
  setStatus(els.loadStatus, '', '');
  refreshTokenStatus();
});

// Cache hit or fresh fetch, depending on forceRefresh.
async function loadStars(forceRefresh) {
  const token = getToken();
  if (!token) {
    setStatus(els.loadStatus, 'Save a token first.', 'warn');
    return;
  }

  if (!forceRefresh) {
    const cached = loadFromCache();
    if (cached) {
      stars = cached;
      sponsorable = stars.filter(isSponsorable);
      finishLoad('cache');
      return;
    }
  }

  els.loadStars.disabled = true;
  els.refreshStars.disabled = true;
  setStatus(els.loadStatus, 'Listing your stars...', '');

  const startedAt = performance.now();
  try {
    stars = await fetchAllStars(token, (p) => {
      if (p.phase === 'listing') {
        setStatus(els.loadStatus, `Listing stars... ${p.count}${p.total ? ` of ~${p.total}` : ''}`, '');
      } else {
        setStatus(els.loadStatus, `Fetching sponsor info... ${p.count} / ${p.total}`, '');
      }
    });
    const elapsedMs = performance.now() - startedAt;
    sponsorable = stars.filter(isSponsorable);
    saveToCache(stars);
    finishLoad('fresh', elapsedMs);
  } catch (e) {
    setStatus(els.loadStatus, `Error: ${e.message}`, 'bad');
  } finally {
    els.loadStars.disabled = false;
    els.refreshStars.disabled = false;
  }
}

// Collapse the load section, show counts (+ duration on fresh fetches).
function finishLoad(source, elapsedMs) {
  let suffix = '';
  if (source === 'cache') {
    suffix = ' (cached)';
  } else if (typeof elapsedMs === 'number') {
    suffix = ` in ${formatDuration(elapsedMs / 1000)}`;
  }
  els.loadSummary.textContent = ` · ${stars.length} stars · ${sponsorable.length} sponsorable${suffix}`;
  els.loadSection.classList.add('compact');
  setStatus(els.loadStatus, '', '');
  els.pickCount.max = Math.max(1, sponsorable.length);
  if (parseInt(els.pickCount.value, 10) > sponsorable.length) {
    els.pickCount.value = Math.min(1, sponsorable.length) || 1;
  }
  els.spinButton.disabled = sponsorable.length === 0;
}

els.loadStars.addEventListener('click', () => loadStars(false));
els.refreshStars.addEventListener('click', () => loadStars(true));

// Sponsors button (if owner has a listing) plus one button per FUNDING.yml entry.
function sponsorButtons(repo) {
  const buttons = [];
  if (repo.owner && repo.owner.hasSponsorsListing) {
    const a = document.createElement('a');
    a.className = 'sponsor-link';
    a.href = `https://github.com/sponsors/${repo.owner.login}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `💖 Sponsor @${repo.owner.login}`;
    buttons.push(a);
  }
  for (const link of (repo.fundingLinks || [])) {
    const a = document.createElement('a');
    a.className = 'sponsor-link platform';
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener';
    // Platform comes back UPPER_SNAKE_CASE; prettify.
    a.textContent = link.platform.charAt(0) + link.platform.slice(1).toLowerCase().replace(/_/g, ' ');
    buttons.push(a);
  }
  return buttons;
}

function buildCard(repo) {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'card-header';

  const name = document.createElement('h3');
  name.className = 'card-name';
  const nameLink = document.createElement('a');
  nameLink.href = repo.url;
  nameLink.target = '_blank';
  nameLink.rel = 'noopener';
  nameLink.textContent = repo.nameWithOwner;
  name.appendChild(nameLink);

  const stars = document.createElement('span');
  stars.className = 'card-stars';
  stars.textContent = `★ ${repo.stargazerCount.toLocaleString()}`;

  header.appendChild(name);
  header.appendChild(stars);
  card.appendChild(header);

  if (repo.description) {
    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = repo.description;
    card.appendChild(desc);
  }

  const sponsors = document.createElement('div');
  sponsors.className = 'card-sponsors';
  sponsorButtons(repo).forEach(b => sponsors.appendChild(b));
  card.appendChild(sponsors);

  return card;
}

// Spinner placeholder, swapped out once a pick is "drawn".
function buildLoadingCard() {
  const card = document.createElement('div');
  card.className = 'card loading';
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  card.appendChild(spinner);
  return card;
}

// Picks are decided up front; we just reveal them one at a time for drama.
els.spinButton.addEventListener('click', async () => {
  const n = Math.max(1, Math.min(parseInt(els.pickCount.value, 10) || 1, sponsorable.length));
  els.spinButton.disabled = true;
  els.results.innerHTML = '';
  els.results.classList.toggle('multi', n > 1);

  const placeholders = [];
  for (let i = 0; i < n; i++) {
    const ph = buildLoadingCard();
    els.results.appendChild(ph);
    placeholders.push(ph);
  }

  const picks = pickN(sponsorable, n);
  for (let i = 0; i < picks.length; i++) {
    await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
    const card = buildCard(picks[i]);
    placeholders[i].replaceWith(card);
  }

  els.spinButton.disabled = false;
});

// Boot: paint initial state and rehydrate from cache if we have a token + fresh cache.
refreshTokenStatus();
const cached = loadFromCache();
if (cached && getToken()) {
  stars = cached;
  sponsorable = stars.filter(isSponsorable);
  finishLoad('cache');
}
