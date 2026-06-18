// Shared API client for both renderer windows.
// Stale-while-revalidate: every GET serves the persisted cache immediately
// (if present), then revalidates in the background and notifies the
// subscriber with fresh data.
//
// Loaded as a plain script; exposes window.API.
(function () {
  'use strict';

  // The API server always runs locally on this fixed address — it's spawned by
  // the Electron main process on launch. Defined here once; not configurable.
  const API_BASE_URL = 'http://127.0.0.1:8123';

  function baseUrl() {
    return API_BASE_URL;
  }

  function cacheKey(path) {
    return `GET ${path}`;
  }

  // Plain network GET (no cache involvement).
  async function fetchJson(path) {
    const res = await fetch(baseUrl() + path, { method: 'GET' });
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
    return res.json();
  }

  /**
   * Stale-while-revalidate GET.
   * onData(data, { fromCache }) — called up to twice:
   *   1. immediately with cached data, if any (fromCache: true)
   *   2. with fresh data after background revalidation (fromCache: false)
   * onError(err) — called only if the network fails; cached data (if any)
   *   has already been delivered, so the UI can show a stale state.
   * Set options.cacheOnly to skip the network entirely (mini first paint).
   * Returns a promise that resolves when revalidation settles.
   */
  async function getSWR(path, onData, onError, options) {
    const opts = options || {};
    const key = cacheKey(path);

    const cached = await window.bridge.getCache(key);
    let servedFromCache = false;
    if (cached && cached.data !== undefined) {
      servedFromCache = true;
      onData(cached.data, { fromCache: true, cachedAt: cached.cachedAt });
    }

    if (opts.cacheOnly) return { fromCache: servedFromCache };

    try {
      const fresh = await fetchJson(path);
      await window.bridge.setCache(key, { data: fresh, cachedAt: new Date().toISOString() });
      onData(fresh, { fromCache: false, cachedAt: new Date().toISOString() });
      return { fromCache: false };
    } catch (err) {
      if (onError) onError(err, { hadCache: servedFromCache });
      return { error: err, hadCache: servedFromCache };
    }
  }

  async function postJson(path, body) {
    const res = await fetch(baseUrl() + path, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(json.error || `POST ${path} failed (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  async function putJson(path, body) {
    const res = await fetch(baseUrl() + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(json.error || `PUT ${path} failed (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  async function del(path) {
    const res = await fetch(baseUrl() + path, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(json.error || `DELETE ${path} failed (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  window.API = {
    baseUrl,
    getSWR,
    fetchJson,
    postJson,
    putJson,
    del,
    health: () => fetchJson('/api/health'),
    refresh: (auto) => postJson(`/api/refresh${auto ? '?auto=true' : ''}`),
    linkToken: () => postJson('/api/plaid/link-token'),
    reauthToken: (itemId) => postJson(`/api/plaid/reauth-token/${itemId}`),
    hostedStatus: () => fetchJson('/api/plaid/hosted/status'),
    deleteItem: (itemId) => del(`/api/plaid/items/${itemId}`),
    setCollectrSource: (url) => putJson('/api/collectibles/source', { url }),
    exportCsvUrl: () => baseUrl() + '/api/export.csv',
  };
})();
