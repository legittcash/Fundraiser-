// Local tests for the Cloudflare Worker. They run the Worker's fetch()
// directly in Node and replace global fetch with a recorder/mocker for
// Supabase, Paystack and Resend. Run with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../src/index.js';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co/',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  PAYSTACK_SECRET_KEY: 'sk_test_secret',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'correct horse',
  ADMIN_SESSION_SECRET: 'session-secret',
  RESEND_API_KEY: 're_test',
  RESEND_FROM_EMAIL: 'KODEP <noreply@example.com>',
  SITE_URL: 'https://kodep.example',
  ASSETS: { fetch: async (req) => new Response('STATIC:' + new URL(req.url).pathname) },
};

const realFetch = globalThis.fetch;
let calls = [];
let mock = () => new Response('[]', { status: 200 });
test.beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return mock(String(url), init);
  };
});
test.after(() => { globalThis.fetch = realFetch; });

const call = (path, init = {}, env = ENV) => worker.fetch(new Request('https://kodep.example' + path, init), env);
const json = (obj) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

async function login() {
  const res = await call('/api/admin/auth?action=login', json({ username: 'admin', password: 'correct horse' }));
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie');
}

test('static requests are passed to the assets binding; unknown /api is 404 JSON', async () => {
  const r = await call('/about-us.html');
  assert.equal(await r.text(), 'STATIC:/about-us.html');
  const n = await call('/api/nope');
  assert.equal(n.status, 404);
});

test('every public route resolves (method guard proves the right handler ran)', async () => {
  for (const p of ['campaign', 'campaigns', 'donations', 'progress', 'track-campaign']) {
    const r = await call('/api/' + p, { method: 'DELETE' });
    assert.equal(r.status, 405, p);
  }
  for (const p of ['initialize-donation', 'submit-campaign', 'paystack-webhook']) {
    const r = await call('/api/' + p, { method: 'GET' });
    assert.equal(r.status, 405, p);
    assert.equal(r.headers.get('allow'), 'POST');
  }
});

test('GET handlers: validation + query parsing', async () => {
  assert.equal((await call('/api/campaign')).status, 400);
  assert.equal((await call('/api/donations')).status, 400);
  assert.equal((await call('/api/progress')).status, 400);
  const t = await call('/api/track-campaign');
  assert.equal(t.status, 400);
  assert.equal(t.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  const o = await call('/api/track-campaign', { method: 'OPTIONS' });
  assert.equal(o.status, 204);
  assert.equal(o.headers.get('allow'), 'GET, OPTIONS');
});

test('/api/campaigns paged: has_more + verified badge, trailing slash on URL stripped', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: 'id' + i, slug: 's' + i }));
  mock = (url) => {
    if (url.includes('/fundraiser?')) return Response.json(rows);
    if (url.includes('/beneficiaries?')) return Response.json([{ fundraiser_id: 'id0' }]);
    return Response.json([]);
  };
  const r = await call('/api/campaigns?page=1&search=ab');
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.campaigns.length, 24);
  assert.equal(body.has_more, true);
  assert.equal(body.campaigns[0].beneficiary_verified, true);
  assert.equal(body.campaigns[1].beneficiary_verified, false);
  assert.ok(calls[0].url.startsWith('https://example.supabase.co/rest/v1/fundraiser'));
  assert.ok(calls[0].url.includes('limit=25&offset=0'));
  assert.equal(calls[0].init.headers.apikey, 'service-role-key');
});

test('admin login / me / logout + cookie properties', async () => {
  const bad = await call('/api/admin/auth?action=login', json({ username: 'admin', password: 'wrong' }));
  assert.equal(bad.status, 401);
  assert.equal((await call('/api/admin/auth?action=login', json({}))).status, 400);

  const cookie = await login();
  assert.match(cookie, /^admin_session=\d+\.[0-9a-f]{64}; HttpOnly; Path=\/; SameSite=Strict; Secure; Max-Age=28800$/);
  const token = cookie.split(';')[0];

  // token format identical to the old Node implementation
  const [exp, sig] = token.split('=')[1].split('.');
  assert.equal(sig, crypto.createHmac('sha256', ENV.ADMIN_SESSION_SECRET).update(exp).digest('hex'));

  const me = await call('/api/admin/auth?action=me', { headers: { cookie: token } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { authenticated: true });
  assert.equal((await call('/api/admin/auth?action=me')).status, 401);
  // tampered / expired / garbage cookies
  assert.equal((await call('/api/admin/auth?action=me', { headers: { cookie: token.slice(0, -1) + (token.endsWith('0') ? '1' : '0') } })).status, 401);
  const expired = `admin_session=${Date.now() - 1000}.${crypto.createHmac('sha256', ENV.ADMIN_SESSION_SECRET).update(String(Date.now() - 1000)).digest('hex')}`;
  assert.equal((await call('/api/admin/auth?action=me', { headers: { cookie: expired } })).status, 401);
  assert.equal((await call('/api/admin/auth?action=me', { headers: { cookie: 'admin_session=%E0%A4%A' } })).status, 401);
  // a token signed with a different secret is rejected
  const forged = `admin_session=${exp}.${crypto.createHmac('sha256', 'other').update(exp).digest('hex')}`;
  assert.equal((await call('/api/admin/auth?action=me', { headers: { cookie: forged } })).status, 401);

  const out = await call('/api/admin/auth?action=logout', { method: 'POST' });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('/api/admin/auth')).status, 400);
});

test('admin APIs require auth', async () => {
  for (const p of ['/api/admin/campaigns', '/api/admin/beneficiaries', '/api/admin/beneficiaries?route=platform-fee', '/api/admin/campaigns?route=upload-image']) {
    const r = await call(p);
    assert.equal(r.status, 401, p);
    assert.deepEqual(await r.json(), { error: 'Not authenticated. Please log in again.' });
  }
});

test('bank list stays public (as in the original), everything else on that route is admin-only', async () => {
  mock = () => Response.json({ status: true, data: [] });
  assert.equal((await call('/api/admin/beneficiaries?route=banks')).status, 200);
  assert.equal((await call('/api/admin/beneficiaries?route=verify', { method: 'POST' })).status, 401);
});

test('admin platform fee switch: default OFF read, and save uses ADMIN_USERNAME', async () => {
  const cookie = (await login()).split(';')[0];
  mock = (url, init) => {
    if (url.includes('/platform_settings')) return init.method === 'GET' || !init.method ? Response.json([]) : Response.json([{ platform_fee_enabled: true }]);
    return Response.json([]);
  };
  const g = await call('/api/admin/beneficiaries?route=platform-fee', { headers: { cookie } });
  assert.equal(g.status, 200);
  const gb = await g.json();
  assert.equal(gb.enabled, false); // default OFF when no row exists
  assert.equal(gb.rate_percent, 1);
  assert.equal(gb.cap_naira, 1000);
  calls = [];
  const p = await call('/api/admin/beneficiaries?route=platform-fee', { ...json({ enabled: true }), headers: { cookie, 'content-type': 'application/json' } });
  assert.equal(p.status, 200);
  assert.ok(calls.some((c) => (c.init.body || '').includes('"updated_by":"admin"')));
});

test('bad JSON body -> 400', async () => {
  const r = await call('/api/initialize-donation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400);
});

function initMock({ feeEnabled, subaccount }) {
  return (url, init) => {
    if (url.includes('/fundraiser?')) return Response.json([{ id: 'c1', patient_name: 'Ada', slug: 'ada-1' }]);
    if (url.includes('/beneficiaries?')) return Response.json(subaccount ? [{ verification_status: 'verified', settlement_enabled: true, paystack_subaccount_code: 'ACCT_x' }] : []);
    if (url.includes('/platform_settings')) return Response.json([{ platform_fee_enabled: feeEnabled }]);
    if (url.startsWith('https://api.paystack.co/transaction/initialize')) return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', reference: 'ref1' } });
    return Response.json([]);
  };
}
const paystackCall = () => calls.find((c) => c.url.includes('paystack.co/transaction/initialize'));

test('initialize-donation: platform fee 1% capped at ₦1,000, only with subaccount + switch ON', async () => {
  mock = initMock({ feeEnabled: true, subaccount: true });
  let r = await call('/api/initialize-donation', { ...json({ fundraiser_id: 'c1', donor_name: 'Bob', amount: 150 }), headers: { 'content-type': 'application/json', host: 'kodep.example' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { authorization_url: 'https://checkout.paystack.com/abc', reference: 'ref1' });
  let sent = JSON.parse(paystackCall().init.body);
  assert.equal(sent.metadata.platform_fee_kobo, 150); // 1.5 naira, no premature rounding
  assert.equal(sent.transaction_charge, 150);
  assert.equal(sent.subaccount, 'ACCT_x');
  assert.equal(sent.callback_url, 'https://kodep.example/campaign.html?slug=ada-1');
  assert.equal(paystackCall().init.headers.Authorization, 'Bearer sk_test_secret');

  calls = [];
  await call('/api/initialize-donation', json({ fundraiser_id: 'c1', donor_name: 'Bob', amount: 500000 }));
  sent = JSON.parse(paystackCall().init.body);
  assert.equal(sent.metadata.platform_fee_kobo, 100000); // capped at ₦1,000

  calls = []; mock = initMock({ feeEnabled: false, subaccount: true });
  await call('/api/initialize-donation', json({ fundraiser_id: 'c1', donor_name: 'Bob', amount: 5000 }));
  assert.equal(JSON.parse(paystackCall().init.body).metadata.platform_fee_kobo, 0); // switch OFF

  calls = []; mock = initMock({ feeEnabled: true, subaccount: false });
  await call('/api/initialize-donation', json({ fundraiser_id: 'c1', donor_name: 'Bob', amount: 5000 }));
  assert.equal(JSON.parse(paystackCall().init.body).metadata.platform_fee_kobo, 0); // no subaccount

  assert.equal((await call('/api/initialize-donation', json({ fundraiser_id: 'c1', donor_name: 'Bob', amount: 50 }))).status, 400);
});

// ---------- Paystack webhook ----------
const chargeEvent = (over = {}) => JSON.stringify({
  event: 'charge.success',
  data: {
    amount: 1000000, fees: 25000, reference: 'ref-123',
    metadata: { fundraiser_id: 'c1', donor_name: 'Bob', donor_email: 'b@x.com', anonymous: 'true', subaccount_code: 'ACCT_x', platform_fee_kobo: '10000' },
    fees_split: { subaccount: '965000' }, ...over,
  },
});
const sig = (body, key = ENV.PAYSTACK_SECRET_KEY) => crypto.createHmac('sha512', key).update(body).digest('hex');
const hook = (body, headers) => call('/api/paystack-webhook', { method: 'POST', body, headers });

test('webhook rejects missing / wrong / malformed signatures and touches nothing', async () => {
  const body = chargeEvent();
  for (const h of [{}, { 'x-paystack-signature': 'deadbeef' }, { 'x-paystack-signature': sig(body, 'other-key') }, { 'x-paystack-signature': 'zz' }, { 'x-paystack-signature': sig(body).slice(0, -2) }]) {
    const r = await hook(body, h);
    assert.equal(r.status, 401);
  }
  // a signature for a *re-serialised* body is invalid: raw bytes are what is signed
  assert.equal((await hook(JSON.stringify(JSON.parse(body), null, 2), { 'x-paystack-signature': sig(body) })).status, 401);
  assert.equal(calls.length, 0);
});

test('webhook processes valid charge.success exactly as before', async () => {
  mock = (url) => {
    if (url.includes('/fundraiser?')) return Response.json([{ id: 'c1' }]);
    if (url.includes('/rpc/record_donation_and_update_totals')) return Response.json([{ is_duplicate: false }]);
    return Response.json([]);
  };
  const body = chargeEvent();
  const r = await hook(body, { 'x-paystack-signature': sig(body) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { received: true, updated: true });
  const rpc = calls.find((c) => c.url.includes('/rpc/record_donation_and_update_totals'));
  assert.deepEqual(JSON.parse(rpc.init.body), {
    p_fundraiser_id: 'c1', p_paystack_reference: 'ref-123', p_amount: 10000, p_paystack_fee: 250,
    p_platform_fee: 100, p_net_amount: 9650, p_donor_name: 'Bob', p_donor_email: 'b@x.com',
    p_anonymous: true, p_settled_to_subaccount: 'ACCT_x', p_settled_amount: 9650,
  });
});

test('webhook: duplicate, non-charge event, missing fundraiser, platform-fee cap', async () => {
  mock = (url) => url.includes('/rpc/') ? Response.json([{ is_duplicate: true }]) : Response.json([{ id: 'c1' }]);
  let body = chargeEvent();
  assert.deepEqual(await (await hook(body, { 'x-paystack-signature': sig(body) })).json(), { received: true, duplicate: true });

  body = JSON.stringify({ event: 'transfer.success', data: {} });
  assert.deepEqual(await (await hook(body, { 'x-paystack-signature': sig(body) })).json(), { received: true, ignored: true });

  body = chargeEvent({ metadata: { donor_name: 'x' } });
  assert.equal((await hook(body, { 'x-paystack-signature': sig(body) })).status, 400);

  calls = [];
  body = chargeEvent({ metadata: { fundraiser_id: 'c1', platform_fee_kobo: 9999999 } });
  await hook(body, { 'x-paystack-signature': sig(body) });
  assert.equal(JSON.parse(calls.find((c) => c.url.includes('/rpc/')).init.body).p_platform_fee, 1000);
});

test('webhook handles non-ASCII bodies (UTF-8 round trip)', async () => {
  mock = (url) => url.includes('/rpc/') ? Response.json([{ is_duplicate: false }]) : Response.json([{ id: 'c1' }]);
  const body = chargeEvent({ metadata: { fundraiser_id: 'c1', donor_name: 'Ọjịnwayọ ₦ 🙏' } });
  const r = await hook(new TextEncoder().encode(body), { 'x-paystack-signature': sig(body) });
  assert.equal(r.status, 200);
});

// ---------- submit-campaign / images / email ----------
const PNG = 'data:image/png;base64,' + Buffer.from('fakepngbytes').toString('base64');
const submission = (over = {}) => ({
  patient_name: 'Ada Obi', goal_amount: 100000, phone_number: '0800', submitter_name: 'Sam', submitter_phone: '0801',
  submitter_email: 'sam@example.com', beneficiary_name: 'Ada', bank_code: '058', account_number: '0123456789',
  fileBase64: PNG, contentType: 'image/png', ...over,
});

test('submit-campaign: uploads image, inserts campaign + beneficiary, sends Resend email via HTTPS API', async () => {
  mock = (url, init) => {
    if (url.includes('/storage/v1/object/campaign-images/')) return new Response('{}', { status: 200 });
    if (url.endsWith('/rest/v1/fundraiser')) return Response.json([{ id: 'c9', patient_name: 'Ada Obi' }]);
    if (url.endsWith('/rest/v1/beneficiaries')) return Response.json([{ id: 'b1' }]);
    if (url === 'https://api.resend.com/emails') return Response.json({ id: 'email-1' });
    return Response.json([]);
  };
  const r = await call('/api/submit-campaign', json(submission()));
  assert.equal(r.status, 201);
  const out = await r.json();
  assert.equal(out.success, true);
  assert.match(out.trackingUrl, /^\/track\.html\?token=[A-Za-z0-9_-]{43}$/);

  const up = calls.find((c) => c.url.includes('/storage/'));
  assert.equal(up.init.headers['Content-Type'], 'image/png');
  assert.equal(Buffer.from(up.init.body).toString(), 'fakepngbytes');

  const ins = JSON.parse(calls.find((c) => c.url.endsWith('/rest/v1/fundraiser')).init.body);
  assert.equal(ins.status, 'pending');
  assert.match(ins.slug, /^ada-obi-[0-9a-f]{10}$/);

  const mail = calls.find((c) => c.url === 'https://api.resend.com/emails');
  assert.equal(mail.init.headers.Authorization, 'Bearer re_test');
  assert.ok(mail.init.headers['User-Agent']);
  const mb = JSON.parse(mail.init.body);
  assert.equal(mb.to, 'sam@example.com');
  assert.equal(mb.from, 'KODEP <noreply@example.com>');
  assert.match(mb.html, /https:\/\/kodep\.example\/track\.html\?token=/);
});

test('submit-campaign: image validation and rollback on beneficiary failure', async () => {
  assert.equal((await call('/api/submit-campaign', json(submission({ contentType: 'image/gif' })))).status, 400);
  assert.equal((await call('/api/submit-campaign', json(submission({ fileBase64: '!!!notbase64!!!' })))).status, 400);
  assert.equal((await call('/api/submit-campaign', json(submission({ fileBase64: 'A'.repeat(5 * 1024 * 1024) })))).status, 400);

  calls = [];
  mock = (url, init) => {
    if (url.includes('/storage/v1/object/campaign-images') && init.method === 'POST') return new Response('{}');
    if (url.includes('/storage/v1/object/campaign-images') && init.method === 'DELETE') return new Response('{}');
    if (url.endsWith('/rest/v1/fundraiser')) return Response.json([{ id: 'c9', patient_name: 'Ada' }]);
    if (url.endsWith('/rest/v1/beneficiaries')) return new Response('boom', { status: 500 });
    return new Response('', { status: 200 });
  };
  const r = await call('/api/submit-campaign', json(submission()));
  assert.equal(r.status, 500);
  assert.ok((await r.json()).reference);
  assert.ok(calls.some((c) => c.init.method === 'DELETE' && c.url.includes('/fundraiser?id=eq.c9')));
  const del = calls.find((c) => c.init.method === 'DELETE' && c.url.endsWith('/storage/v1/object/campaign-images'));
  assert.ok(del && JSON.parse(del.init.body).prefixes[0].startsWith('patient-'));
});

test('email failure never breaks submission', async () => {
  mock = (url) => {
    if (url.includes('/storage/')) return new Response('{}');
    if (url.endsWith('/rest/v1/fundraiser')) return Response.json([{ id: 'c9', patient_name: 'Ada' }]);
    if (url.endsWith('/rest/v1/beneficiaries')) return Response.json([{ id: 'b1' }]);
    if (url.includes('resend.com')) return Response.json({ name: 'validation_error', message: 'bad' }, { status: 422 });
    return Response.json([]);
  };
  assert.equal((await call('/api/submit-campaign', json(submission()))).status, 201);
  // no API key -> skipped, still fine
  assert.equal((await call('/api/submit-campaign', json(submission()), { ...ENV, RESEND_API_KEY: undefined })).status, 201);
});

test('admin campaigns: upload-image validation', async () => {
  const cookie = (await login()).split(';')[0];
  const h = { cookie, 'content-type': 'application/json' };
  mock = () => new Response('{}', { status: 200 });
  const up = await call('/api/admin/campaigns?route=upload-image', { method: 'POST', headers: h, body: JSON.stringify({ fileBase64: PNG, contentType: 'image/png' }) });
  assert.equal(up.status, 200);
  assert.match((await up.json()).url, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/campaign-images\/patient-/);
  const bad = await call('/api/admin/campaigns?route=upload-image', { method: 'POST', headers: h, body: JSON.stringify({ fileBase64: PNG, contentType: 'text/html' }) });
  assert.equal(bad.status, 400);
});

test('admin: banks route uses Paystack with secret key; PATCH approval triggers approved email', async () => {
  const cookie = (await login()).split(';')[0];
  const h = { cookie, 'content-type': 'application/json' };
  mock = (url, init) => {
    if (url.startsWith('https://api.paystack.co/bank')) return Response.json({ status: true, data: [{ name: 'GTB', code: '058', extra: 1 }] });
    if (url.includes('/fundraiser?id=eq.c1') && (init.method || 'GET') === 'GET') return Response.json([{ id: 'c1', status: 'pending', image_url: null }]);
    if (url.includes('/fundraiser?id=eq.c1') && init.method === 'PATCH') return Response.json([{ id: 'c1', status: 'active', slug: 'ada', patient_name: 'Ada', submitter_email: 's@x.com', submitter_name: 'S' }]);
    if (url.includes('resend.com')) return Response.json({ id: 'e1' });
    return Response.json([]);
  };
  const b = await call('/api/admin/beneficiaries?route=banks', { headers: { cookie } });
  assert.deepEqual(await b.json(), { banks: [{ name: 'GTB', code: '058' }] });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_secret');

  calls = [];
  const p = await call('/api/admin/campaigns?id=c1', { method: 'PATCH', headers: h, body: JSON.stringify({ status: 'active' }) });
  assert.equal(p.status, 200, await p.clone().text());
  const mail = calls.find((c) => c.url.includes('resend.com'));
  assert.ok(mail, 'approved email sent');
  assert.match(JSON.parse(mail.init.body).html, /kodep\.example\/campaign\.html\?slug=ada/);
});
