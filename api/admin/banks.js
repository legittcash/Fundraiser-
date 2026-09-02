// api/admin/banks.js
//
// Lets the admin beneficiary form populate a proper bank dropdown
// instead of asking the admin to type a raw Paystack bank code by hand.
// Calls Paystack's documented "List Banks" endpoint server-side, so the
// PAYSTACK_SECRET_KEY never has to leave the server.

import { rejectIfNotAdmin } from '../../lib/admin-auth.js';
import { listNigerianBanks } from '../../lib/paystack.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (rejectIfNotAdmin(req, res)) return;

  const result = await listNigerianBanks();
  if (!result.ok) {
    return res.status(502).json({ error: result.error });
  }

  return res.status(200).json({ banks: result.data });
}
