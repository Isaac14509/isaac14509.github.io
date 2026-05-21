// ══════════════════════════════════════════════════════════════
//  not²flix — Cloudflare Worker TMDB Proxy
//  Routes: GET /?action=...
//    action=metadata  &id=&type=              → normalised title/poster/overview/etc
//    action=search    &query=&type=&page=     → normalised search results + genres baked in
//    action=recs      &id=&type=&title=       → primary recs + cross-type search, normalised
//    action=genres    &type=                  → genre list (tv or movie)
//    action=episode   &id=&season=&episode=   → episode runtime (tv only)
//    action=season    &id=&season=            → episode count for a season (tv only)
//    action=trending  &time_window=day|week   → trending movies + TV shows, normalised
// ══════════════════════════════════════════════════════════════

const TMDB = 'https://api.themoviedb.org/3';
const CACHE_TTL = 3600; // 1 hour for most responses
const GENRE_TTL = 43200; // 12 hours for genre lists (shorter for fresher genre data)
const FETCH_TIMEOUT_MS = 8000; // 8 second timeout for TMDB requests

export default {
  async fetch(request, env, ctx) {
    // ── CORS preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    if (request.method !== 'GET') {
      return corsJson({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'metadata';
    const key = env.TMDB_API_KEY;

    if (!key) return corsJson({ error: 'Worker misconfigured — TMDB_API_KEY secret missing' }, 500);

    // Validate action parameter
    const validActions = ['metadata', 'search', 'recs', 'genres', 'episode', 'season', 'seasoncount', 'videos', 'trending'];
    if (!validActions.includes(action)) {
      return corsJson({ error: `Invalid action: ${action}` }, 400);
    }

    const cache = caches.default;
    const cacheKey = new Request(request.url, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      let result;
      switch (action) {
        case 'metadata': result = await handleMetadata(url, key); break;
        case 'search': result = await handleSearch(url, key); break;
        case 'trending': result = await handleTrending(url, key); break;
        case 'recs': result = await handleRecs(url, key); break;
        case 'genres': result = await handleGenres(url, key); break;
        case 'episode': result = await handleEpisode(url, key); break;
        case 'season': result = await handleSeason(url, key); break;
        case 'seasoncount': result = await handleSeasonCount(url, key); break;
        case 'videos': result = await handleVideos(url, key); break;
        default: return corsJson({ error: `Unknown action: ${action}` }, 400);
      }

      const ttl = action === 'genres' ? GENRE_TTL : CACHE_TTL;
      const response = corsJson(result, 200, ttl);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;

    } catch (e) {
      const status = e.tmdbStatus || 500;
      const headers = corsHeaders();

      // Add Retry-After header for rate limits
      if (status === 429 && e.retryAfter) {
        headers['Retry-After'] = e.retryAfter;
      }

      return corsJson({ error: e.message || 'Internal error' }, status, 0, headers);
    }
  }
};

// ══════════════════════════════════════
//  HANDLERS
// ══════════════════════════════════════

// GET /?action=metadata&id=&type=
async function handleMetadata(url, key) {
  const id = requireParam(url, 'id');
  const type = requireParam(url, 'type');

  // Validate type
  if (!['tv', 'movie'].includes(type)) {
    const err = new Error(`Invalid type: ${type}`);
    err.tmdbStatus = 400;
    throw err;
  }

  const endpoint = type === 'movie' ? `movie/${id}` : `tv/${id}`;
  const data = await tmdbWithTimeout(key, endpoint);
  return normaliseItem(data, type);
}

// GET /?action=search&query=&type=multi|tv|movie&page=1
async function handleSearch(url, key) {
  const query = requireParam(url, 'query');
  const type = url.searchParams.get('type') || 'multi';
  const page = url.searchParams.get('page') || '1';

  // Validate type
  if (!['tv', 'movie', 'multi'].includes(type)) {
    const err = new Error(`Invalid search type: ${type}`);
    err.tmdbStatus = 400;
    throw err;
  }

  // Pre-fetch genres for both types so we can bake them into results
  const [tvGenres, movieGenres] = await Promise.all([
    fetchGenres(key, 'tv'),
    fetchGenres(key, 'movie')
  ]);
  const genreMap = buildGenreMap(tvGenres, movieGenres);

  let results = [];

  if (type === 'multi') {
    const data = await tmdbWithTimeout(key, `search/multi?query=${enc(query)}&include_adult=false&page=${page}`);
    results = (data.results || [])
      .filter(item => item.media_type === 'tv' || item.media_type === 'movie')
      .slice(0, 24)
      .map(item => normaliseSearchResult(item, item.media_type, genreMap));
  } else {
    const endpoint = type === 'movie' ? 'search/movie' : 'search/tv';
    const data = await tmdbWithTimeout(key, `${endpoint}?query=${enc(query)}&include_adult=false&page=${page}`);
    results = (data.results || [])
      .slice(0, 24)
      .map(item => normaliseSearchResult(item, type, genreMap));
  }

  return { results };
}

// GET /?action=trending&time_window=day|week
async function handleTrending(url, key) {
  const timeWindow = url.searchParams.get('time_window') || 'week';

  if (!['day', 'week'].includes(timeWindow)) {
    const err = new Error(`Invalid time_window: ${timeWindow}`);
    err.tmdbStatus = 400;
    throw err;
  }

  const [tvGenres, movieGenres] = await Promise.all([
    fetchGenres(key, 'tv'),
    fetchGenres(key, 'movie')
  ]);
  const genreMap = buildGenreMap(tvGenres, movieGenres);

  const data = await tmdbWithTimeout(key, `trending/all/${timeWindow}?language=en-US`);
  const results = (data.results || [])
    .filter(item => item.media_type === 'tv' || item.media_type === 'movie')
    .slice(0, 24)
    .map(item => normaliseSearchResult(item, item.media_type, genreMap));

  return { results };
}

// GET /?action=recs&id=&type=&title=
async function handleRecs(url, key) {
  const id = requireParam(url, 'id');
  const type = requireParam(url, 'type');
  const title = url.searchParams.get('title') || '';

  // Validate type
  if (!['tv', 'movie'].includes(type)) {
    const err = new Error(`Invalid type: ${type}`);
    err.tmdbStatus = 400;
    throw err;
  }

  const [tvGenres, movieGenres] = await Promise.all([
    fetchGenres(key, 'tv'),
    fetchGenres(key, 'movie')
  ]);
  const genreMap = buildGenreMap(tvGenres, movieGenres);

  const endpoint = type === 'movie' ? `movie/${id}/recommendations` : `tv/${id}/recommendations`;
  const oppositeType = type === 'tv' ? 'movie' : 'tv';
  const crossEndpoint = oppositeType === 'movie' ? 'search/movie' : 'search/tv';

  const [primaryData, crossData] = await Promise.all([
    tmdbWithTimeout(key, endpoint).catch(err => {
      console.error(`Primary recs fetch failed for ${type}/${id}:`, err.message);
      return { results: [] };
    }),
    title
      ? tmdbWithTimeout(key, `${crossEndpoint}?query=${enc(title)}`).catch(err => {
        console.error(`Cross-type recs fetch failed for "${title}":`, err.message);
        return { results: [] };
      })
      : Promise.resolve({ results: [] })
  ]);

  const primaryResults = (primaryData.results || [])
    .slice(0, 10)
    .map(item => normaliseSearchResult(item, type, genreMap));

  const titleLower = title.toLowerCase();
  const crossResults = (crossData.results || [])
    .filter(item => (item.name || item.title || '').toLowerCase() !== titleLower)
    .slice(0, 8)
    .map(item => normaliseSearchResult(item, oppositeType, genreMap));

  return {
    [type]: primaryResults,
    [oppositeType]: crossResults
  };
}

// GET /?action=genres&type=tv|movie
async function handleGenres(url, key) {
  const type = requireParam(url, 'type');

  // Validate type
  if (!['tv', 'movie'].includes(type)) {
    const err = new Error(`Invalid type: ${type}`);
    err.tmdbStatus = 400;
    throw err;
  }

  const genres = await fetchGenres(key, type);
  return { genres };
}

// GET /?action=episode&id=&season=&episode=
async function handleEpisode(url, key) {
  const id = requireParam(url, 'id');
  const season = requireParam(url, 'season');
  const episode = requireParam(url, 'episode');
  const data = await tmdbWithTimeout(key, `tv/${id}/season/${season}/episode/${episode}`);
  return { runtime: data.runtime || 0 };
}

// GET /?action=season&id=&season=
async function handleSeason(url, key) {
  const id = requireParam(url, 'id');
  const season = requireParam(url, 'season');
  const data = await tmdbWithTimeout(key, `tv/${id}/season/${season}`);
  const episodes = data.episodes || [];
  return {
    episodeCount: episodes.length,
    episodes: episodes.map(ep => ({
      number: ep.episode_number,
      name: ep.name,
      runtime: ep.runtime || 0
    }))
  };
}

// GET /?action=seasoncount&id=
async function handleSeasonCount(url, key) {
  const id = requireParam(url, 'id');
  const data = await tmdbWithTimeout(key, `tv/${id}`);
  // TMDB includes specials as season 0 — filter those out
  const seasons = (data.seasons || []).filter(s => s.season_number > 0);
  return {
    seasonCount: seasons.length,
    seasons: seasons.map(s => ({
      number: s.season_number,
      name: s.name,
      episodeCount: s.episode_count
    }))
  };
}



// GET /?action=videos&id=&type=
async function handleVideos(url, key) {
  const id = requireParam(url, 'id');
  const type = requireParam(url, 'type');
  const endpoint = type === 'movie' ? `movie/${id}/videos` : `tv/${id}/videos`;
  const data = await tmdbWithTimeout(key, endpoint);
  const videos = (data.results || [])
    .filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
    .sort((a, b) => {
      const score = v => (v.type === 'Trailer' ? 2 : 0) + (v.iso_639_1 === 'en' ? 1 : 0);
      return score(b) - score(a);
    })
    .slice(0, 5)
    .map(v => ({ key: v.key, name: v.name, type: v.type }));
  return { videos };
}

async function tmdbWithTimeout(key, path, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${TMDB}/${path}${sep}api_key=${key}`, {
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      // Handle rate limiting
      if (res.status === 429) {
        const err = new Error('TMDB rate limited — backing off');
        err.tmdbStatus = 429;
        err.retryAfter = res.headers.get('Retry-After') || '10';
        throw err;
      }

      const err = new Error(`TMDB error ${res.status} on ${path}`);
      err.tmdbStatus = res.status === 404 ? 404 : 502;
      throw err;
    }

    return res.json();
  } catch (e) {
    clearTimeout(timeout);

    // Handle timeout specifically
    if (e.name === 'AbortError') {
      const err = new Error(`TMDB request timeout (${timeoutMs}ms) on ${path}`);
      err.tmdbStatus = 504;
      throw err;
    }

    throw e;
  }
}

async function fetchGenres(key, type) {
  const endpoint = type === 'tv' ? 'genre/tv/list' : 'genre/movie/list';
  const data = await tmdbWithTimeout(key, endpoint).catch(err => {
    console.error(`Genre fetch failed for ${type}:`, err.message);
    return { genres: [] };
  });
  return data.genres || [];
}

// ══════════════════════════════════════
//  NORMALISATION
// ══════════════════════════════════════

function normaliseItem(data, type) {
  return {
    id: String(data.id),
    type,
    title: data.name || data.title || null,
    posterPath: data.poster_path || null,
    backdropPath: data.backdrop_path || null,
    overview: data.overview || '',
    rating: data.vote_average ? Number(data.vote_average.toFixed(1)) : 0,
    year: (data.release_date || data.first_air_date || '').slice(0, 4),
    genres: (data.genres || []).map(g => g.name).slice(0, 3)
  };
}

function normaliseSearchResult(item, type, genreMap) {
  const genreIds = item.genre_ids || [];
  const genreNames = genreIds
    .map(id => genreMap[`${type}_${id}`] || genreMap[`movie_${id}`] || genreMap[`tv_${id}`])
    .filter(Boolean)
    .slice(0, 3);

  return {
    id: String(item.id),
    type,
    title: item.name || item.title || '—',
    posterPath: item.poster_path || null,
    backdropPath: item.backdrop_path || null,
    overview: item.overview || '',
    rating: item.vote_average ? Number(item.vote_average.toFixed(1)) : 0,
    year: (item.first_air_date || item.release_date || '').slice(0, 4),
    genres: genreNames
  };
}

function buildGenreMap(tvGenres, movieGenres) {
  const map = {};
  tvGenres.forEach(g => { map[`tv_${g.id}`] = g.name; });
  movieGenres.forEach(g => { map[`movie_${g.id}`] = g.name; });
  return map;
}

// ══════════════════════════════════════
//  UTILS
// ══════════════════════════════════════

function requireParam(url, name) {
  const val = url.searchParams.get(name);
  if (!val) {
    const err = new Error(`Missing required parameter: ${name}`);
    err.tmdbStatus = 400;
    throw err;
  }
  return val;
}

function enc(s) {
  return encodeURIComponent(s);
}

function corsHeaders(ttl = 0) {
  const h = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (ttl) h['Cache-Control'] = `public, max-age=${ttl}`;
  return h;
}

function corsJson(data, status = 200, ttl = 0, customHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(ttl),
      ...customHeaders
    }
  });
}