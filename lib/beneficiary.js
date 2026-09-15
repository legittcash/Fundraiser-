// lib/beneficiary.js
//
// Shared helper for inserting a brand-new beneficiary row linked to a
// campaign. Used by BOTH the admin's combined campaign+beneficiary
// creation flow (api/admin/campaigns.js) and the public visitor
// submission flow (api/submit-campaign.js) — both always create a
// FRESH beneficiary for a FRESH campaign, so this only ever inserts; it
// never updates an existing beneficiary. That "edit an existing
// beneficiary" path stays exactly where it already lives, in
// api/admin/beneficiaries.js, for the admin's dedicated verification
// workflow — this file does not duplicate or replace that.
//
// IMPORTANT: the row this creates always starts completely inert from a
// settlement standpoint. This function never sets verification_status,
// settlement_enabled, or paystack_subaccount_code — they're left to the
// "beneficiaries" table's own column defaults ('pending', false, null).
// Those three fields can ONLY ever be changed afterward by the existing
// admin verification workflow (api/admin/beneficiaries.js's
// ?route=verify and ?route=settlement). This is what guarantees a
// visitor (or even an admin, through this particular code path) can
// never cause a beneficiary to start out verified or settlement-enabled.

function supabaseHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function insertBeneficiary({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }, fields) {
  const payload = {
    fundraiser_id: fields.fundraiserId,
    beneficiary_name: fields.beneficiaryName,
    bank_name: fields.bankName || null,
    bank_code: fields.bankCode,
    account_number: String(fields.accountNumber),
    primary_phone_number: fields.primaryPhoneNumber || null,
    secondary_phone_number: fields.secondaryPhoneNumber || null,
    settlement_percentage: 0,
  };

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/beneficiaries`, {
      method: 'POST',
      headers: supabaseHeaders(SUPABASE_SERVICE_ROLE_KEY, { Prefer: 'return=representation' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errText = await response.text();
      return { ok: false, error: errText };
    }
    const created = await response.json();
    return { ok: true, data: created[0] };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// Deletes a beneficiary row by fundraiser_id. Used as a compensating
// rollback step if a combined campaign+beneficiary creation fails
// partway through — kept here for symmetry/completeness even though the
// current callers roll back by deleting the CAMPAIGN row instead (which
// cascades to remove the beneficiary automatically, per the existing
// "on delete cascade" foreign key already set up in supabase.sql).
export async function deleteBeneficiaryByFundraiserId({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }, fundraiserId) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/beneficiaries?fundraiser_id=eq.${encodeURIComponent(fundraiserId)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    return { ok: response.ok };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
