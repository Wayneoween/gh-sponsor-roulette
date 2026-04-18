/*
 * Pure helpers: GitHub API clients, star fetching, cache, small utils.
 * No DOM access here. UI lives in app.js.
 *
 * Useful docs:
 *   - GraphQL explorer: https://docs.github.com/en/graphql/overview/explorer
 *   - REST starred list: https://docs.github.com/en/rest/activity/starring#list-repositories-starred-by-the-authenticated-user
 *   - Link-header pagination: https://docs.github.com/en/rest/guides/using-pagination-in-the-rest-api
 *   - fundingLinks (parsed FUNDING.yml): https://docs.github.com/en/graphql/reference/objects#repository
 *   - Sponsorable.hasSponsorsListing: https://docs.github.com/en/graphql/reference/interfaces#sponsorable
 *   - GraphQL aliases (used to batch many repository() calls): https://docs.github.com/en/graphql/guides/forming-calls-with-graphql
 *   - Token scopes: classic PAT needs "public_repo" so fundingLinks comes back.
 */

// localStorage keys
const TOKEN_KEY = 'sponsor-roulette-token';
const CACHE_KEY = 'sponsor-roulette-cache';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h

/*
 * Two-phase load:
 *   A: REST /user/starred. Offset paginated, so once page 1 tells us the total
 *      we can fire the rest in parallel.
 *   B: GraphQL repository() calls batched via aliases (r0..rN) for sponsor info.
 *
 * Rate limits: https://docs.github.com/en/graphql/overview/resource-limitations
 */
const CONCURRENCY = 10;
const ENRICH_BATCH_SIZE = 100;

// Per-repo sponsor signals. owner is User|Organization, hence the inline fragments.
const ENRICH_FRAGMENT = `
  nameWithOwner
  url
  description
  stargazerCount
  fundingLinks { platform url }
  owner {
    login
    ... on User { hasSponsorsListing }
    ... on Organization { hasSponsorsListing }
  }
`;

// POST GraphQL. Tolerates per-repo "Could not resolve" (repo deleted between phases).
async function graphql(token, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors) {
    const fatal = json.errors.filter(e => !/Could not resolve/i.test(e.message));
    if (fatal.length > 0) {
      throw new Error(fatal.map(e => e.message).join('; '));
    }
  }
  return json.data;
}

async function restGet(token, path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return { body: await res.json(), link: res.headers.get('Link') };
}

// Pull the last-page number out of a Link header.
function lastPageFromLink(link) {
  if (!link) return 1;
  const match = link.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match ? parseInt(match[1], 10) : 1;
}

// Run fn over items with at most `limit` in flight. Workers pull from a shared cursor.
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// Phase A. Page 1 first to learn the total, then the rest in parallel.
async function listAllStarredRepos(token, onProgress) {
  const first = await restGet(token, '/user/starred?per_page=100&page=1');
  const lastPage = lastPageFromLink(first.link);
  const all = first.body.slice();
  if (onProgress) onProgress(all.length, lastPage * 100);

  if (lastPage > 1) {
    const pages = [];
    for (let p = 2; p <= lastPage; p++) pages.push(p);
    const batches = await runWithConcurrency(pages, CONCURRENCY, async (page) => {
      const r = await restGet(token, `/user/starred?per_page=100&page=${page}`);
      return r.body;
    });
    for (const arr of batches) {
      all.push(...arr);
      if (onProgress) onProgress(all.length, lastPage * 100);
    }
  }
  return all;
}

// Phase B. One query per batch, repos addressed as r0..rN via aliases.
async function enrichWithSponsorInfo(token, repoRefs, onProgress) {
  const batches = [];
  for (let i = 0; i < repoRefs.length; i += ENRICH_BATCH_SIZE) {
    batches.push(repoRefs.slice(i, i + ENRICH_BATCH_SIZE));
  }

  let done = 0;
  const enrichedBatches = await runWithConcurrency(batches, CONCURRENCY, async (batch) => {
    // owner/name only contain alphanumerics + -_. so inlining is safe.
    const aliases = batch
      .map((r, i) => `r${i}: repository(owner: "${r.owner}", name: "${r.name}") { ${ENRICH_FRAGMENT} }`)
      .join('\n');
    const query = `query { ${aliases} }`;
    const data = await graphql(token, query, null);
    // Drop nulls (deleted/unreachable since Phase A) but keep order.
    const ordered = batch.map((_, i) => data[`r${i}`]).filter(r => r !== null);
    done += batch.length;
    if (onProgress) onProgress(done, repoRefs.length);
    return ordered;
  });

  return enrichedBatches.flat();
}

async function fetchAllStars(token, progress) {
  const basicRepos = await listAllStarredRepos(token, (count, total) => {
    progress({ phase: 'listing', count, total });
  });
  const refs = basicRepos.map(r => ({ owner: r.owner.login, name: r.name }));
  return await enrichWithSponsorInfo(token, refs, (count, total) => {
    progress({ phase: 'enriching', count, total });
  });
}

// "4.3s" or "1m 23s"
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

// Sponsors listing on the owner, or any FUNDING.yml entry, counts.
function isSponsorable(repo) {
  return (repo.owner && repo.owner.hasSponsorsListing) ||
         (repo.fundingLinks && repo.fundingLinks.length > 0);
}

function loadFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { stars, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return stars;
  } catch {
    return null;
  }
}

function saveToCache(stars) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ stars, ts: Date.now() }));
  } catch (e) {
    // localStorage quota is ~5-10 MB. Big star lists may blow it; app still works.
    console.warn('Cache save failed (likely too large):', e);
  }
}

// Random sample without replacement. Splice-and-pick, fine for small N.
function pickN(arr, n) {
  const copy = arr.slice();
  const out = [];
  const take = Math.min(n, copy.length);
  for (let i = 0; i < take; i++) {
    const j = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(j, 1)[0]);
  }
  return out;
}
