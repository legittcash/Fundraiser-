// lib/paystack.js
//
// Small shared helper for the few Paystack REST API calls the ADMIN
// dashboard needs to manage beneficiary bank accounts and settlement:
// listing banks, resolving/verifying an account number, and creating or
// updating a Paystack Subaccount. This file only ever runs inside
// Vercel serverless functions — NEVER in the browser — so it's safe to
// use the SECRET key here. It is never imported by any public-facing
// or frontend-served file.
//
// Every function below uses Paystack's own documented endpoints only:
//   - GET  /bank            (List Banks)
//   - GET  /bank/resolve     (Resolve/verify an account number)
//   - POST /subaccount       (Create Subaccount)
//   - PUT  /subaccount/:code (Update Subaccount)
// Nothing here is invented — see README.md for links and the exact
// fields each endpoint is documented to accept/return.
//
// Every function returns { ok: true, data } on success or
// { ok: false, error } on failure — callers decide how to report that
// to the admin. None of these ever throw.

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

// GET /bank — Paystack's documented "List Banks" endpoint. Used to
// populate a bank dropdown in the admin beneficiary form so an admin
// never has to type a raw bank code by hand.
export async function listNigerianBanks() {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/bank?currency=NGN&country=nigeria&perPage=100`, {
      headers: authHeaders(),
    });
    const json = await response.json();
    if (!response.ok || !json.status) {
      return { ok: false, error: json.message || 'Failed to load the bank list from Paystack.' };
    }
    const banks = (json.data || []).map((b) => ({ name: b.name, code: b.code }));
    return { ok: true, data: banks };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// GET /bank/resolve — Paystack's documented account-verification
// endpoint. Confirms a bank_code + account_number combination is real
// and returns the account's registered name, so the admin can visually
// confirm they're about to settle to the right person before enabling
// automatic settlement.
export async function resolveAccountNumber(accountNumber, bankCode) {
  try {
    const url =
      `${PAYSTACK_BASE_URL}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}` +
      `&bank_code=${encodeURIComponent(bankCode)}`;
    const response = await fetch(url, { headers: authHeaders() });
    const json = await response.json();
    if (!response.ok || !json.status) {
      return { ok: false, error: json.message || 'Could not verify this account number with Paystack.' };
    }
    return { ok: true, data: { account_name: json.data.account_name, account_number: json.data.account_number } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// POST /subaccount — Paystack's documented "Create Subaccount" endpoint.
//
// IMPORTANT (easy to get backwards): per Paystack's own documentation,
// "percentage_charge" is the share that goes to the MAIN account — the
// beneficiary's subaccount receives the REMAINDER. A platform that wants
// to take no extra cut beyond Paystack's own transaction fee should
// pass 0, meaning the beneficiary gets 100% of the split.
export async function createSubaccount({ businessName, bankCode, accountNumber, percentageCharge, primaryContactPhone }) {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/subaccount`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        business_name: businessName,
        settlement_bank: bankCode,
        account_number: accountNumber,
        percentage_charge: percentageCharge,
        ...(primaryContactPhone ? { primary_contact_phone: primaryContactPhone } : {}),
      }),
    });
    const json = await response.json();
    if (!response.ok || !json.status) {
      return { ok: false, error: json.message || 'Failed to create a Paystack subaccount for this beneficiary.' };
    }
    return { ok: true, data: { subaccount_code: json.data.subaccount_code, account_name: json.data.account_name } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// POST /transaction/initialize — Paystack's documented server-side
// transaction initialization endpoint. This is the foundation of the
// secure checkout flow: our server (never the visitor's browser)
// decides the final amount, whether a beneficiary subaccount is used,
// and what platform fee (if any) applies, then asks Paystack to create
// the transaction with those exact terms. Paystack responds with an
// authorization_url — a hosted Paystack checkout page we redirect the
// visitor's browser to. The browser never sees or can influence
// "subaccount", "transaction_charge", or "bearer" at all.
export async function initializeTransaction({
  email,
  amountKobo,
  metadata,
  callbackUrl,
  subaccountCode,
  transactionChargeKobo,
  bearer,
}) {
  try {
    const body = {
      email,
      amount: amountKobo,
      currency: 'NGN',
      callback_url: callbackUrl,
      metadata,
    };
    // Only include split-payment parameters when there's an actual
    // subaccount to split with — omitting them entirely means the full
    // amount goes to the platform's main account, exactly as it always
    // has for campaigns with no beneficiary.
    if (subaccountCode) {
      body.subaccount = subaccountCode;
      // transaction_charge overrides the subaccount's default
      // percentage_charge for THIS ONE transaction — this is what lets
      // a variable, capped platform fee (1% up to ₦1,000) be applied
      // per-donation rather than a fixed percentage. Per Paystack's own
      // documentation: "the amount specified goes to the main account
      // regardless of the split configuration."
      if (transactionChargeKobo && transactionChargeKobo > 0) {
        body.transaction_charge = transactionChargeKobo;
      }
      // "bearer" is Paystack's own documented parameter controlling WHO
      // absorbs Paystack's transaction fee in a split payment: "account"
      // (the platform's main account, Paystack's default) or
      // "subaccount" (the beneficiary). Passing "subaccount" here is
      // what makes the beneficiary's actual settlement match our own
      // accounting formula (gross - paystack_fee - platform_fee) —
      // otherwise Paystack's fee would be deducted from the platform's
      // share instead, and the beneficiary would receive more than our
      // records say they should.
      if (bearer) {
        body.bearer = bearer;
      }
    }

    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok || !json.status) {
      return { ok: false, error: json.message || 'Failed to initialize payment with Paystack.' };
    }
    return {
      ok: true,
      data: {
        authorization_url: json.data.authorization_url,
        access_code: json.data.access_code,
        reference: json.data.reference,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// PUT /subaccount/:code — updates an existing subaccount's bank details
// or percentage split, e.g. after an admin corrects a beneficiary's bank
// details on an already-verified campaign.
export async function updateSubaccount(subaccountCode, { businessName, bankCode, accountNumber, percentageCharge }) {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/subaccount/${encodeURIComponent(subaccountCode)}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        business_name: businessName,
        settlement_bank: bankCode,
        account_number: accountNumber,
        percentage_charge: percentageCharge,
      }),
    });
    const json = await response.json();
    if (!response.ok || !json.status) {
      return { ok: false, error: json.message || 'Failed to update the Paystack subaccount.' };
    }
    return { ok: true, data: json.data };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
