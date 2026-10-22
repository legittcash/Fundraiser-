// Local tests for the Cloudflare Worker. They run the Worker's fetch()
// directly in Node and replace global fetch with a recorder/mocker for
// Supabase, Paystack and Resend. Run with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

test('wrangler.jsonc: worker name, entry, ./public assets with ASSETS binding', () => {
  const raw = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(cfg.name, 'fundraiser');
  assert.equal(cfg.main, 'src/index.js');
  assert.equal(cfg.assets.directory, './public');
  assert.equal(cfg.assets.binding, 'ASSETS');
  assert.deepEqual(cfg.assets.run_worker_first, ['/api/*']);
  assert.ok(fs.existsSync(new URL('../public/index.html', import.meta.url)));
});

// =====================================================================
// Payout status / Paystack subaccount verification
// =====================================================================
import { canMovePayoutStatus, payoutStatusFromSettlement } from '../lib/payout-evidence.js';
import { getAmountSettled, getPayoutBreakdown } from '../lib/amount-settled.js';

const adminHeaders = async () => ({ cookie: (await login()).split(';')[0], 'content-type': 'application/json' });
const patchesTo = (table) => calls.filter((c) => c.init.method === 'PATCH' && c.url.includes('/rest/v1/' + table));
const BEN = { fundraiser_id: 7, beneficiary_name: 'Ada', bank_code: '058', account_number: '0123456789', settlement_percentage: 0, verification_status: 'pending', paystack_subaccount_code: null };

test('scenario 1: a new subaccount is created UNVERIFIED and recorded as such (KODEP never claims Paystack verified it)', async () => {
  const h = await adminHeaders();
  calls = [];
  mock = (url, init) => {
    const m = init.method || 'GET';
    if (url.startsWith('https://api.paystack.co/bank/resolve')) return Response.json({ status: true, data: { account_name: 'ADA O', account_number: '0123456789' } });
    if (url === 'https://api.paystack.co/subaccount' && m === 'POST') return Response.json({ status: true, data: { subaccount_code: 'ACCT_new', id: 77, is_verified: false, active: true } });
    if (url.includes('/beneficiaries?fundraiser_id=eq.7') && m === 'GET') return Response.json([BEN]);
    if (url.includes('/beneficiaries?fundraiser_id=eq.7') && m === 'PATCH') return Response.json([{ ...BEN, verification_status: 'verified', paystack_subaccount_code: 'ACCT_new', account_name: 'ADA O' }]);
    return Response.json([]);
  };
  const r = await call('/api/admin/beneficiaries?route=verify', { method: 'POST', headers: h, body: JSON.stringify({ fundraiser_id: 7 }) });
  assert.equal(r.status, 200, await r.clone().text());
  const b = (await r.json()).beneficiary;
  assert.equal(b.verification_status, 'verified');         // KODEP's own check
  assert.equal(b.paystack_is_verified, false);              // Paystack's flag, as reported
  assert.equal(b.paystack_subaccount_id, 77);
  const saved = patchesTo('beneficiaries').map((c) => JSON.parse(c.init.body)).find((x) => 'paystack_is_verified' in x);
  assert.equal(saved.paystack_is_verified, false);
  // Only documented Paystack calls were made: resolve + create. No made-up "verify" call.
  const ps = calls.filter((c) => c.url.startsWith('https://api.paystack.co')).map((c) => (c.init.method || 'GET') + ' ' + new URL(c.url).pathname);
  assert.deepEqual(ps, ['GET /bank/resolve', 'POST /subaccount']);
});

test('scenario 2: locally verified but Paystack still unverified stays unverified; unchecked is never shown as verified', async () => {
  const h = await adminHeaders();
  const local = { ...BEN, verification_status: 'verified', paystack_subaccount_code: 'ACCT_new', paystack_subaccount_id: 77 };
  calls = [];
  mock = (url, init) => {
    const m = init.method || 'GET';
    if (url === 'https://api.paystack.co/subaccount/ACCT_new') return Response.json({ status: true, data: { id: 77, is_verified: false, active: true } });
    if (url.includes('/beneficiaries?fundraiser_id=eq.7') && m === 'GET') return Response.json([local]);
    return Response.json([]);
  };
  const r = await call('/api/admin/beneficiaries?route=paystack-status', { method: 'POST', headers: h, body: JSON.stringify({ fundraiser_id: 7 }) });
  const b = (await r.json()).beneficiary;
  assert.equal(b.verification_status, 'verified');
  assert.equal(b.paystack_is_verified, false);

  // Paystack later reports true -> recorded as true.
  mock = (url, init) => url === 'https://api.paystack.co/subaccount/ACCT_new'
    ? Response.json({ status: true, data: { id: 77, is_verified: true, active: true } })
    : (url.includes('/beneficiaries?fundraiser_id=eq.7') && (init.method || 'GET') === 'GET' ? Response.json([local]) : Response.json([]));
  assert.equal((await (await call('/api/admin/beneficiaries?route=paystack-status', { method: 'POST', headers: h, body: JSON.stringify({ fundraiser_id: 7 }) })).json()).beneficiary.paystack_is_verified, true);

  // Summary list: a locally verified beneficiary that was never checked is null, not true.
  mock = (url) => url.includes('/beneficiaries?select=') ? Response.json([{ fundraiser_id: 7, verification_status: 'verified', settlement_enabled: true, paystack_subaccount_code: 'ACCT_new', account_number: '0123456789' }]) : Response.json([]);
  const sum = await (await call('/api/admin/beneficiaries?all=1', { headers: h })).json();
  assert.equal(sum.beneficiaries[0].paystack_is_verified, null);
  assert.equal(sum.beneficiaries[0].has_subaccount, true);
  assert.equal(sum.beneficiaries[0].account_number_masked, '••••6789');
  assert.equal(JSON.stringify(sum).includes('0123456789'), false);
});

test('scenario 3: a successful donation never sets a payout status or counts as settled', async () => {
  mock = (url) => url.includes('/rpc/record_donation_and_update_totals') ? Response.json([{ is_duplicate: false }]) : Response.json([{ id: 'c1' }]);
  const body = chargeEvent();
  assert.equal((await hook(body, { 'x-paystack-signature': sig(body) })).status, 200);
  const rpc = JSON.parse(calls.find((c) => c.url.includes('/rpc/record_donation_and_update_totals')).init.body);
  assert.equal(Object.keys(rpc).some((k) => /payout|settled_status|paid/i.test(k)), false);
  assert.equal(patchesTo('donations').length, 0);
  // The database starts every new split donation as pending_payout (trigger), not settled.
  const sql = fs.readFileSync(new URL('../supabase-payout-status.sql', import.meta.url), 'utf8');
  assert.match(sql, /new\.payout_status := 'pending_payout'/);
  assert.doesNotMatch(sql, /new\.payout_status := 'settled'/);

  // Public "Amount Settled" only ever sums CONFIRMED rows (fallback query shown; RPC missing).
  calls = [];
  mock = (url) => url.includes('/rpc/') ? new Response('{}', { status: 404 }) : Response.json([]);
  assert.equal(await getAmountSettled('https://x.supabase.co', {}, 5), 0);
  const q = calls.find((c) => c.url.includes('/rest/v1/donations')).url;
  assert.match(q, /payout_status=eq\.settled/);
});

test('scenario 4: the same webhook delivered twice is processed once and changes nothing the second time', async () => {
  let n = 0;
  mock = (url) => url.includes('/rpc/record_donation_and_update_totals') ? Response.json([{ is_duplicate: n++ > 0 }]) : Response.json([{ id: 'c1' }]);
  const body = chargeEvent();
  const first = await (await hook(body, { 'x-paystack-signature': sig(body) })).json();
  const second = await (await hook(body, { 'x-paystack-signature': sig(body) })).json();
  assert.deepEqual(first, { received: true, updated: true });
  assert.deepEqual(second, { received: true, duplicate: true });
  assert.equal(patchesTo('donations').length + patchesTo('fundraiser').length, 0); // nothing updated outside the atomic RPC
  // A forged / unsigned replay is rejected before any database call.
  calls = [];
  assert.equal((await hook(body, { 'x-paystack-signature': 'bad' })).status, 401);
  assert.equal(calls.length, 0);
});

function reconcileMock({ settlements, txBySettlement, candidates, ben = {}, patchReturns = (ids) => ids.map((id) => ({ id })) }) {
  const beneficiary = { ...BEN, verification_status: 'verified', paystack_subaccount_code: 'ACCT_new', paystack_subaccount_id: 77, ...ben };
  return (url, init) => {
    const m = init.method || 'GET';
    if (url.includes('/beneficiaries?fundraiser_id=eq.7')) return Response.json([beneficiary]);
    if (url.includes('/rest/v1/donations?select=id,paystack_reference')) return Response.json(candidates);
    if (url.startsWith('https://api.paystack.co/settlement?')) return Response.json({ status: true, data: settlements, meta: { pageCount: 1 } });
    const t = url.match(/settlement\/(\d+)\/transactions/);
    if (t) return Response.json({ status: true, data: (txBySettlement[t[1]] || []).map((reference) => ({ reference })), meta: { pageCount: 1 } });
    if (m === 'PATCH' && url.includes('/rest/v1/donations')) {
      const ids = url.match(/id=in\.\(([\d,]+)\)/)[1].split(',').map(Number);
      return Response.json(patchReturns(ids));
    }
    return Response.json([]);
  };
}
const cands = [
  { id: 1, paystack_reference: 'ref-a', payout_status: 'pending_payout', created_at: '2026-10-01T10:00:00Z' },
  { id: 2, paystack_reference: 'ref-b', payout_status: 'pending_payout', created_at: '2026-10-02T10:00:00Z' },
];
const reconcile = async (apply) => {
  const h = await adminHeaders();
  return call('/api/admin/beneficiaries?route=reconcile-payouts', { method: 'POST', headers: h, body: JSON.stringify({ fundraiser_id: 7, apply }) });
};

test('scenario 5: payout confirmed by a successful Paystack settlement -> preview changes nothing, apply marks settled with evidence', async () => {
  calls = [];
  mock = reconcileMock({ settlements: [{ id: 900, status: 'success', settlement_date: '2026-10-12T00:00:00Z' }], txBySettlement: { 900: ['ref-a'] }, candidates: cands });
  const pre = await (await reconcile(false)).json();
  assert.equal(pre.mode, 'preview');
  assert.deepEqual(pre.will_change, { settled: 1, processing: 0, failed: 0 });
  assert.equal(pre.unmatched, 1); // ref-b stays pending
  assert.equal(patchesTo('donations').length, 0);
  assert.ok(calls.some((c) => c.url.includes('/settlement?subaccount=77')), 'filtered by the beneficiary subaccount id');

  calls = [];
  const done = await (await reconcile(true)).json();
  assert.equal(done.applied, 1);
  const [p] = patchesTo('donations');
  assert.match(p.url, /id=in\.\(1\)&payout_status=in\.\(pending_payout,processing,failed\)/); // conditional: never touches already-settled rows
  assert.deepEqual(JSON.parse(p.init.body), {
    payout_status: 'settled', payout_status_updated_at: JSON.parse(p.init.body).payout_status_updated_at,
    payout_settlement_id: '900', payout_settlement_date: '2026-10-12T00:00:00Z', payout_confirmed_via: 'paystack_settlement_api',
  });
});

test('scenario 6: failed / pending settlements are reported as failed / processing, never settled; unknown statuses and unmatched donations stay pending', async () => {
  calls = [];
  mock = reconcileMock({
    settlements: [{ id: 901, status: 'failed' }, { id: 902, status: 'pending' }, { id: 903, status: 'mystery' }],
    txBySettlement: { 901: ['ref-a'], 902: ['ref-b'], 903: ['ref-a', 'ref-b'] },
    candidates: cands,
  });
  const pre = await (await reconcile(false)).json();
  assert.deepEqual(pre.will_change, { settled: 0, processing: 1, failed: 1 });
  assert.equal(pre.unmatched, 0);

  // Nothing found at Paystack at all -> everything remains Pending payout.
  calls = [];
  mock = reconcileMock({ settlements: [], txBySettlement: {}, candidates: cands });
  const none = await (await reconcile(true)).json();
  assert.deepEqual(none.will_change, { settled: 0, processing: 0, failed: 0 });
  assert.equal(none.unmatched, 2);
  assert.equal(patchesTo('donations').length, 0);

  // Paystack error -> 502, nothing saved.
  calls = [];
  mock = (url, init) => url.startsWith('https://api.paystack.co/settlement?') ? Response.json({ status: false, message: 'boom' }, { status: 500 }) : reconcileMock({ settlements: [], txBySettlement: {}, candidates: cands })(url, init);
  assert.equal((await reconcile(true)).status, 502);
  assert.equal(patchesTo('donations').length, 0);
});

test('scenario 7: historical "settled" records are handled safely (never auto-confirmed, never downgraded, nothing deleted)', async () => {
  const sql = fs.readFileSync(new URL('../supabase-payout-status.sql', import.meta.url), 'utf8');
  assert.match(sql, /payout_legacy_unconfirmed = true\s+where payout_status = 'pending_payout' and settled_amount > 0/);
  assert.doesNotMatch(sql, /payout_status = 'settled'\s*where/i); // no historical row is promoted to settled
  assert.doesNotMatch(sql, /\b(delete\s+from|drop\s+table|truncate|drop\s+column)\b/i);
  assert.doesNotMatch(sql, /update donations set settled_amount/i); // original figure preserved

  // State machine: settled is final; pending cannot jump backwards.
  assert.equal(canMovePayoutStatus('settled', 'failed'), false);
  assert.equal(canMovePayoutStatus('settled', 'processing'), false);
  assert.equal(canMovePayoutStatus('not_applicable', 'settled'), false);
  assert.equal(canMovePayoutStatus('pending_payout', 'settled'), true);
  assert.equal(canMovePayoutStatus('failed', 'settled'), true);
  assert.equal(payoutStatusFromSettlement('success'), 'settled');
  assert.equal(payoutStatusFromSettlement('SUCCESS'), 'settled');
  assert.equal(payoutStatusFromSettlement('unknown'), null);

  // Only not-yet-settled donations are even considered, and a lost race updates nothing.
  calls = [];
  mock = reconcileMock({ settlements: [{ id: 900, status: 'success' }], txBySettlement: { 900: ['ref-a'] }, candidates: cands, patchReturns: () => [] });
  const r = await (await reconcile(true)).json();
  assert.equal(r.applied, 0);
  assert.match(calls.find((c) => c.url.includes('/rest/v1/donations?select=id,paystack_reference')).url, /payout_status=in\.\(pending_payout,processing,failed\)/);

  // Breakdown for the admin keeps old unconfirmed money visibly separate from confirmed payouts.
  mock = (url) => url.includes('/rpc/admin_payout_breakdown')
    ? Response.json([{ fundraiser_id: 7, settled: '0', pending: '9650', processing: '0', failed: '0', legacy_unconfirmed: '9650' }])
    : Response.json([]);
  const bd = await getPayoutBreakdown('https://x.supabase.co', {}, [7]);
  assert.deepEqual(bd.byCampaign[7], { settled: 0, pending: 9650, processing: 0, failed: 0, legacy_unconfirmed: 9650 });
  assert.equal(bd.total.settled, 0);
  // Migration not run -> unknown (null), never a made-up figure.
  mock = () => new Response('missing', { status: 404 });
  assert.equal(await getPayoutBreakdown('https://x.supabase.co', {}, null), null);
});

test('payout routes require an admin session and a POST', async () => {
  for (const route of ['reconcile-payouts', 'paystack-status']) {
    assert.equal((await call('/api/admin/beneficiaries?route=' + route, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
    const h = await adminHeaders();
    assert.equal((await call('/api/admin/beneficiaries?route=' + route, { headers: h })).status, 405);
  }
});

// =====================================================================
// "Check payouts" diagnostics (fake references only; no live Paystack)
// =====================================================================
import { findPayoutEvidence } from '../lib/payout-evidence.js';

const settlementItem = (id, status) => ({
  id, domain: 'live', status, currency: 'NGN', integration: 1, total_amount: 97500, effective_amount: 97500,
  total_fees: 0, total_processed: 97500, deductions: null, settlement_date: '2026-10-14T00:00:00.000Z',
  settled_by: null, createdAt: '2026-10-14T01:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z',
});
const txItem = (reference) => ({ id: 1, domain: 'live', status: 'success', reference, amount: 100000, currency: 'NGN', fees: 1500, subaccount: {}, split: {} });
const pageOf = (data, pageCount = 1) => Response.json({ status: true, message: 'ok', data, meta: { total: data.length, skipped: 0, perPage: 100, page: 1, pageCount } });
const DIAG_DONATION = { id: 11, paystack_reference: 'ref-diag-1', payout_status: 'pending_payout', created_at: '2026-10-12T23:27:56.200Z' };

// listFor(hasFrom, page) -> settlements; txFor(settlementId) -> references
function diagMock({ listFor, mainListFor = () => [], txFor = () => [], txResponse = null, candidates = [DIAG_DONATION], listError = null }) {
  const beneficiary = { ...BEN, verification_status: 'verified', paystack_subaccount_code: 'ACCT_diag', paystack_subaccount_id: 77 };
  return (url, init) => {
    const m = init.method || 'GET';
    if (url.includes('/beneficiaries?fundraiser_id=eq.7')) return Response.json([beneficiary]);
    if (url.includes('/rest/v1/donations?select=id,paystack_reference')) return Response.json(candidates);
    if (url.startsWith('https://api.paystack.co/settlement?')) {
      if (listError) return Response.json({ status: false, message: listError }, { status: 401 });
      const q = new URL(url).searchParams;
      if (q.get('subaccount') === 'none') return pageOf(mainListFor(q.has('from'), Number(q.get('page'))));
      return pageOf(listFor(q.has('from'), Number(q.get('page'))));
    }
    const t = url.match(/settlement\/(\d+)\/transactions/);
    if (t) return txResponse ? txResponse(t[1]) : pageOf(txFor(t[1]).map(txItem));
    if (m === 'PATCH' && url.includes('/rest/v1/donations')) return Response.json([{ id: 11 }]);
    return Response.json([]);
  };
}
const paystackListCalls = () => calls.filter((c) => c.url.startsWith('https://api.paystack.co/settlement?'));

test('check payouts: beneficiary already settled by Paystack -> preview shows the evidence and saves nothing; apply saves it', async () => {
  calls = [];
  mock = diagMock({ listFor: () => [settlementItem(900, 'success')], txFor: () => ['other-ref', 'ref-diag-1'] });
  const pre = await (await reconcile(false)).json();
  assert.equal(pre.mode, 'preview');
  assert.deepEqual(pre.will_change, { settled: 1, processing: 0, failed: 0 });
  assert.equal(pre.settlements_listed, 1);
  assert.equal(patchesTo('donations').length, 0);
  assert.deepEqual(pre.diagnostics.settlements, [{
    id: '900', status: 'success', settlement_date: '2026-10-14T00:00:00.000Z', recognised: true,
    transactions_opened: 2, transactions_reported: 2, total_amount: 97500, effective_amount: 97500, currency: 'NGN',
    donations_found: 1, complete: true,
  }]);
  assert.equal(pre.diagnostics.start_date, '2026-10-11');
  assert.equal(pre.diagnostics.start_date_fallback.ran, false, 'everything found in pass 1: no second pass');
  assert.equal(paystackListCalls().length, 1);

  calls = [];
  const done = await (await reconcile(true)).json();
  assert.equal(done.applied, 1);
  const [p] = patchesTo('donations');
  assert.match(p.url, /id=in\.\(11\)&payout_status=in\.\(pending_payout,processing,failed\)/);
  assert.equal(JSON.parse(p.init.body).payout_confirmed_via, 'paystack_settlement_api');
});

test('check payouts: Paystack lists no settlements -> explained, nothing changes, second pass has no start date', async () => {
  calls = [];
  mock = diagMock({ listFor: () => [] });
  const r = await (await reconcile(false)).json();
  assert.equal(r.settlements_listed, 0);
  assert.deepEqual(r.will_change, { settled: 0, processing: 0, failed: 0 });
  assert.equal(r.diagnostics.start_date_fallback.ran, true);
  assert.equal(r.diagnostics.settlements_total, 0);
  const lists = paystackListCalls();
  assert.equal(lists.length, 3, 'start-date list, list without start date, then the read-only main-account look');
  assert.match(lists[0].url, /from=2026-10-11/);
  assert.doesNotMatch(lists[1].url, /from=/);
  assert.match(lists[2].url, /subaccount=none/);
  assert.equal(patchesTo('donations').length, 0);
});

test('check payouts: settlement listed but it does not contain the donation -> reported, still pending', async () => {
  calls = [];
  mock = diagMock({ listFor: () => [settlementItem(901, 'success')], txFor: () => ['some-other-ref', 'another-ref'] });
  const r = await (await reconcile(false)).json();
  assert.deepEqual(r.will_change, { settled: 0, processing: 0, failed: 0 });
  assert.equal(r.unmatched, 1);
  assert.equal(r.diagnostics.settlements[0].transactions_opened, 2);
  assert.equal(r.diagnostics.settlements[0].donations_found, 0);
  assert.equal(patchesTo('donations').length, 0);
});

test('check payouts: the second pass finds a settlement the start-date list did not return (same evidence rule)', async () => {
  calls = [];
  mock = diagMock({ listFor: (hasFrom) => (hasFrom ? [] : [settlementItem(902, 'success')]), txFor: () => ['ref-diag-1'] });
  const pre = await (await reconcile(false)).json();
  assert.deepEqual(pre.will_change, { settled: 1, processing: 0, failed: 0 });
  assert.equal(pre.diagnostics.start_date_fallback.ran, true);
  assert.equal(pre.diagnostics.start_date_fallback.additional_settlements, 1);
  assert.equal(pre.diagnostics.settlements_listed_with_start_date, 0);
  assert.equal(patchesTo('donations').length, 0, 'preview still changes nothing');
  calls = [];
  const done = await (await reconcile(true)).json();
  assert.equal(done.applied, 1);
  assert.equal(patchesTo('donations').length, 1);
});

test('check payouts: unrecognised settlement status is listed but never used as evidence', async () => {
  calls = [];
  mock = diagMock({ listFor: () => [settlementItem(903, 'reversed')], txFor: () => ['ref-diag-1'] });
  const r = await (await reconcile(false)).json();
  assert.deepEqual(r.will_change, { settled: 0, processing: 0, failed: 0 });
  assert.deepEqual(r.diagnostics.unrecognised_statuses, ['reversed']);
  assert.equal(r.diagnostics.settlements[0].recognised, false);
  assert.equal(r.diagnostics.settlements[0].transactions_opened, 0);
  assert.equal(calls.filter((c) => /settlement\/\d+\/transactions/.test(c.url)).length, 0);
});

test('check payouts: a pending settlement is processing, never settled', async () => {
  calls = [];
  mock = diagMock({ listFor: () => [settlementItem(904, 'pending')], txFor: () => ['ref-diag-1'] });
  const r = await (await reconcile(false)).json();
  assert.deepEqual(r.will_change, { settled: 0, processing: 1, failed: 0 });
});

test('check payouts: a Paystack error is returned as a readable 502 message and saves nothing', async () => {
  calls = [];
  mock = diagMock({ listFor: () => [], listError: 'Invalid key' });
  const res = await reconcile(false);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Paystack settlement lookup failed: Invalid key/);
  assert.equal(patchesTo('donations').length, 0);
});

test('check payouts: the lookup never exceeds its Paystack call budget and says so', async () => {
  calls = [];
  const many = Array.from({ length: 30 }, (_, i) => settlementItem(1000 + i, 'success'));
  mock = diagMock({ listFor: () => many, txFor: () => ['unrelated'] });
  const r = await (await reconcile(false)).json();
  assert.equal(r.truncated, true);
  assert.ok(calls.filter((c) => c.url.startsWith('https://api.paystack.co/')).length <= 24);
});

test('check payouts: a donation already settled is never moved, even if a settlement lists it', async () => {
  const env = { PAYSTACK_SECRET_KEY: 'sk_test_secret' };
  calls = [];
  mock = diagMock({ listFor: () => [settlementItem(905, 'success')], txFor: () => ['ref-diag-1'] });
  const donation = { ...DIAG_DONATION, payout_status: 'settled' };
  const r = await findPayoutEvidence(env, { subaccountId: 77, donations: [donation], budget: { left: 24 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.proposals, []);
});

test('check payouts: the response never contains credentials or bank details', async () => {
  calls = [];
  mock = diagMock({ listFor: () => [settlementItem(906, 'success')], txFor: () => ['ref-diag-1'] });
  const text = await (await reconcile(false)).text();
  for (const secret of ['sk_test_secret', 'service-role-key', '0123456789', 'session-secret', 'correct horse']) {
    assert.ok(!text.includes(secret), 'response must not include ' + secret);
  }
});

function loadPayoutPanelRenderer() {
  const html = fs.readFileSync(new URL('../public/admin/dashboard.html', import.meta.url), 'utf8');
  const m = html.match(/\/\/ <payout-check-render>([\s\S]*?)\/\/ <\/payout-check-render>/);
  assert.ok(m, 'render block markers are present in dashboard.html');
  const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const PAYOUT_LABELS = { not_applicable: 'No beneficiary payout', pending_payout: 'Pending payout', processing: 'Payout processing', settled: 'Settled (confirmed)', failed: 'Payout failed' };
  return new Function('escapeHtml', 'PAYOUT_LABELS', m[1] + '\nreturn { payoutLookupDetailsHtml, renderPayoutCheck };')(escapeHtml, PAYOUT_LABELS);
}
const diagRow = (o = {}) => ({ id: '900', status: 'success', settlement_date: '2026-10-14T00:00:00.000Z', recognised: true, transactions_opened: 2, donations_found: 0, complete: true, ...o });
const baseResult = (o = {}) => ({
  mode: 'preview', donations_checked: 1, settlements_checked: 0, settlements_listed: 0, truncated: false,
  will_change: { settled: 0, processing: 0, failed: 0 }, unmatched: 1, changes: [],
  diagnostics: { start_date: '2026-10-11', settlements_listed_with_start_date: 0, start_date_fallback: { ran: true, settlements_listed: 0, additional_settlements: 0 }, settlements_total: 0, settlements: [], unrecognised_statuses: [] },
  ...o,
});

test('check payouts panel: says plainly when Paystack listed no settlement, and when none contains the donation', () => {
  const { renderPayoutCheck } = loadPayoutPanelRenderer();
  const none = renderPayoutCheck(baseResult());
  assert.match(none.html, /No payout confirmations found at Paystack yet \(1 donation\(s\) checked\)/);
  assert.match(none.html, /What Paystack returned/);
  assert.match(none.html, /Paystack did not list any settlement for this subaccount/);
  assert.equal(none.total, 0);

  const notContained = renderPayoutCheck(baseResult({
    settlements_listed: 1,
    diagnostics: { ...baseResult().diagnostics, settlements_total: 1, settlements_listed_with_start_date: 1, settlements: [diagRow()] },
  }));
  assert.match(notContained.html, /#900 · success · 2026-10-14 · 2 transaction\(s\) opened · 0 of the donation\(s\) checked found/);
  assert.match(notContained.html, /none of the settlements that were read contains the donation/);
});

test('check payouts panel: save button only when there is evidence; 0 eligible donations is explained; text is escaped', () => {
  const { renderPayoutCheck } = loadPayoutPanelRenderer();
  const withChange = renderPayoutCheck(baseResult({
    settlements_listed: 1, will_change: { settled: 1, processing: 0, failed: 0 }, unmatched: 0,
    changes: [{ reference: 'ref-diag-1', from: 'pending_payout', to: 'settled', settlement_id: '900', settlement_status: 'success' }],
    diagnostics: { ...baseResult().diagnostics, settlements_total: 1, settlements: [diagRow({ donations_found: 1 })] },
  }));
  assert.equal(withChange.total, 1);
  assert.match(withChange.html, /Save these 1 change\(s\)/);
  assert.match(withChange.html, /id="applyPayoutsBtn"/);

  const zero = renderPayoutCheck(baseResult({ donations_checked: 0, unmatched: 0 }));
  assert.match(zero.html, /No donation on this campaign is waiting for a payout check/);
  assert.doesNotMatch(zero.html, /applyPayoutsBtn/);

  const hostile = renderPayoutCheck(baseResult({
    settlements_listed: 1,
    diagnostics: { ...baseResult().diagnostics, settlements_total: 1, settlements: [diagRow({ id: '<img src=x onerror=alert(1)>', status: '<script>x</script>' })] },
  }));
  assert.doesNotMatch(hostile.html, /<img src=x|<script>x/);
  assert.match(hostile.html, /&lt;img src=x/);
});

test('check payouts: settlement with an amount but an empty transaction list -> reported, never marked settled', async () => {
  calls = [];
  // The live symptom: Paystack lists a successful settlement (amount 97,500 kobo) but its transactions endpoint returns data: [].
  mock = diagMock({ listFor: () => [settlementItem(12085311, 'success')], txResponse: () => pageOf([]) });
  const r = await (await reconcile(false)).json();
  assert.deepEqual(r.will_change, { settled: 0, processing: 0, failed: 0 });
  assert.equal(r.changes.length, 0);
  assert.equal(patchesTo('donations').length, 0);
  const row = r.diagnostics.settlements[0];
  assert.equal(row.transactions_opened, 0);
  assert.equal(row.transactions_reported, 0);
  assert.equal(row.total_amount, 97500);
  assert.equal(row.effective_amount, 97500);
  assert.equal(row.complete, true);

  const { renderPayoutCheck } = loadPayoutPanelRenderer();
  const html = renderPayoutCheck(r).html;
  assert.match(html, /settlement amount NGN 975\.00/);
  assert.match(html, /Paystack says it holds 0 transaction\(s\)/);
  assert.match(html, /with an amount but returned no transactions/);
  assert.match(html, /Nothing is marked Settled from an amount alone/);
  assert.doesNotMatch(html, /applyPayoutsBtn/);
});

test('check payouts: Paystack count above zero but an empty page is visible in the diagnostics', async () => {
  calls = [];
  mock = diagMock({
    listFor: () => [settlementItem(12085312, 'success')],
    txResponse: () => Response.json({ status: true, message: 'ok', data: [], meta: { total: 3, skipped: 0, perPage: 100, page: 1, pageCount: 1 } }),
  });
  const r = await (await reconcile(false)).json();
  const row = r.diagnostics.settlements[0];
  assert.equal(row.transactions_opened, 0);
  assert.equal(row.transactions_reported, 3);
  assert.equal(r.changes.length, 0);
  assert.match(loadPayoutPanelRenderer().renderPayoutCheck(r).html, /Paystack says it holds 3 transaction\(s\)/);
});

test('check payouts: amounts Paystack does not send are null, not invented', async () => {
  calls = [];
  const bare = { id: 12085313, status: 'success', settlement_date: '2026-10-14T00:00:00.000Z' };
  mock = diagMock({ listFor: () => [bare], txFor: () => ['nope'] });
  const row = (await (await reconcile(false)).json()).diagnostics.settlements[0];
  assert.equal(row.total_amount, null);
  assert.equal(row.effective_amount, null);
  assert.equal(row.currency, null);
});

// ---- main-account look (the Paystack support finding) -----------------
// Paystack: a transaction is listed in the MAIN account's settlement; the
// subaccount settlement's own transaction list is always empty.
const mainLive = () => diagMock({
  listFor: () => [settlementItem(12085311, 'success')],
  mainListFor: () => [{ ...settlementItem(12085310, 'success'), total_amount: 2500, effective_amount: 2500 }],
  txFor: (id) => (id === '12085310' ? ['ref-diag-1'] : []),
});

test('check payouts: reference found in a main-account settlement is reported with the next subaccount settlement, never proposed', async () => {
  calls = [];
  mock = mainLive();
  const r = await (await reconcile(false)).json();
  assert.deepEqual(r.will_change, { settled: 0, processing: 0, failed: 0 }, 'a main-account listing alone is not payout evidence');
  assert.equal(r.changes.length, 0);
  assert.equal(patchesTo('donations').length, 0);
  const main = r.diagnostics.main_account;
  assert.equal(main.ran, true);
  assert.equal(main.settlements_listed, 1);
  assert.equal(main.settlements_opened, 1);
  assert.equal(main.found.length, 1);
  assert.equal(main.found[0].reference, 'ref-diag-1');
  assert.equal(main.found[0].settlement_id, '12085310');
  assert.equal(main.found[0].next_subaccount_settlement.id, '12085311');
  assert.equal(main.found[0].next_subaccount_settlement.total_amount, 97500);
  // The main account is queried with Paystack's documented subaccount=none.
  assert.ok(paystackListCalls().some((c) => new URL(c.url).searchParams.get('subaccount') === 'none'));

  const html = loadPayoutPanelRenderer().renderPayoutCheck(r).html;
  assert.match(html, /Main-account settlements/);
  assert.match(html, /ref-diag-1 is in main settlement #12085310/);
  assert.match(html, /Subaccount settlement #12085311 \(success, NGN 975\.00\) comes right after it/);
  assert.match(html, /Paystack has not confirmed that link, so nothing is marked Settled/);
  assert.doesNotMatch(html, /applyPayoutsBtn/);
});

test('check payouts: main-account look is skipped when the subaccount settlement already proves the payout', async () => {
  calls = [];
  mock = diagMock({ listFor: () => [settlementItem(900, 'success')], txFor: () => ['ref-diag-1'] });
  const r = await (await reconcile(false)).json();
  assert.equal(r.diagnostics.main_account.ran, false);
  assert.ok(!paystackListCalls().some((c) => new URL(c.url).searchParams.get('subaccount') === 'none'));
});

test('check payouts: reference not in any main settlement, or a Paystack error there, is shown and changes nothing', async () => {
  calls = [];
  mock = diagMock({ listFor: () => [], mainListFor: () => [settlementItem(7, 'success')], txFor: () => ['other'] });
  let r = await (await reconcile(false)).json();
  assert.equal(r.diagnostics.main_account.found.length, 0);
  assert.match(loadPayoutPanelRenderer().renderPayoutCheck(r).html, /None of the donation\(s\) checked was found in the main-account settlements/);

  const inner = diagMock({ listFor: () => [], mainListFor: () => [] });
  mock = (url, init) => (url.startsWith('https://api.paystack.co/settlement?') && new URL(url).searchParams.get('subaccount') === 'none'
    ? Response.json({ status: false, message: 'Not allowed' }, { status: 403 }) : inner(url, init));
  r = await (await reconcile(false)).json();
  assert.equal(r.diagnostics.main_account.error, 'Not allowed');
  assert.equal(r.changes.length, 0);
  assert.match(loadPayoutPanelRenderer().renderPayoutCheck(r).html, /Paystack error while reading them: Not allowed/);
});

test('check payouts: the main-account look respects the call budget', async () => {
  calls = [];
  mock = diagMock({
    listFor: () => [],
    mainListFor: () => Array.from({ length: 50 }, (_, i) => settlementItem(1000 + i, 'success')),
    txFor: () => ['unrelated'],
  });
  const r = await (await reconcile(false)).json();
  assert.ok(calls.filter((c) => c.url.startsWith('https://api.paystack.co/')).length <= 24);
  assert.equal(r.truncated, true);
});
