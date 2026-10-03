// lib/supabase-paging.js
//
// Supabase's REST API (PostgREST) returns at most 1000 rows per request
// by default, silently. A plain "select everything" request therefore
// stops being complete once a table passes 1000 rows, which would make
// admin totals and lists quietly wrong. This helper reads a table in
// pages of 1000 until a short page signals the end, and returns every
// row, so the SAME calculations the callers already do (sums, counts,
// maps) simply see all the data.
//
//   const r = await fetchAllRows(url, headers, 'id.asc');
//   if (!r.ok) { ...log r.errorText and use the caller's existing error handling... }
//   else r.rows  // every row
//
// url        the existing query WITHOUT limit/offset (it may already
//            contain select/filters; it must not contain "order=" if
//            you pass the order argument, and must not contain limit)
// orderBy    a stable, unique ordering such as 'id.asc'. Paging needs a
//            deterministic order, otherwise rows could be skipped or
//            repeated between pages. If the caller already has an
//            order=... in the url, pass null here and make sure that
//            order ends with a unique column (see api/admin/campaigns.js).
//
// Result rows, ordering, and columns are identical to what the
// unpaged request returned (for tables under 1000 rows it is exactly
// one request, the same as before). Never throws; a failed page returns
// { ok: false, errorText }.

const PAGE_SIZE = 1000;
const MAX_PAGES = 1000; // safety stop: one million rows

export async function fetchAllRows(url, headers, orderBy = null) {
  try {
    const base = orderBy ? `${url}${url.includes('?') ? '&' : '?'}order=${orderBy}` : url;
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`${base}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, { headers });
      if (!res.ok) {
        return { ok: false, errorText: await res.text() };
      }
      const batch = await res.json();
      for (const row of batch) rows.push(row);
      if (batch.length < PAGE_SIZE) return { ok: true, rows };
    }
    return { ok: false, errorText: 'Stopped after the maximum number of pages; refusing to return a partial result.' };
  } catch (err) {
    return { ok: false, errorText: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------
// callRpc: calls a Postgres function through Supabase's REST API, e.g.
//   const r = await callRpc(SUPABASE_URL, headers, 'admin_overview_totals', {});
//   if (r.ok) r.data  // whatever the function returned
// Used for the database side totals added by supabase-scale-upgrade.sql.
// Never throws. If the function does not exist yet (the SQL has not been
// run), it returns { ok: false, errorText } and every caller falls back
// to its previous method, so the site keeps working either way.
export async function callRpc(supabaseUrl, headers, fn, args = {}) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      return { ok: false, errorText: await res.text() };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, errorText: err.message || String(err) };
  }
}
