import { createClient } from '@supabase/supabase-js';

const PRIMARY_OWNER_EMAIL = (process.env.BESEEN_OWNER_EMAIL || 'akilhsen4@gmail.com').toLowerCase();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function requireOwner(request, supabase) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: json({ error: 'Sign in first.' }, 401) };
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return { error: json({ error: 'Invalid sign-in session.' }, 401) };
  const { data: profile } = await supabase.from('profiles').select('id,email,role').eq('id', data.user.id).single();
  if (profile?.role !== 'owner') return { error: json({ error: 'Owner access required.' }, 403) };
  return { user: data.user, profile };
}

export async function GET(request) {
  const supabase = db(); if (!supabase) return json({ error: 'Supabase server access is not configured.' }, 503);
  const auth = await requireOwner(request, supabase); if (auth.error) return auth.error;
  const { data, error } = await supabase.from('profiles').select('id,email,full_name,role,subscription,subscription_status,created_at,stripe_customer_id').order('created_at', { ascending: false });
  if (error) return json({ error: 'Could not load accounts.' }, 500);
  return json({ accounts: (data || []).map(a => ({ ...a, primary_owner: String(a.email || '').toLowerCase() === PRIMARY_OWNER_EMAIL })) });
}

export async function PATCH(request) {
  const supabase = db(); if (!supabase) return json({ error: 'Supabase server access is not configured.' }, 503);
  const auth = await requireOwner(request, supabase); if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({}));
  const userId = String(body.userId || '').trim();
  const role = String(body.role || '').toLowerCase();
  if (!userId || !['member', 'admin', 'owner'].includes(role)) return json({ error: 'Choose a valid account and role.' }, 400);
  const { data: target, error: targetError } = await supabase.from('profiles').select('id,email,role').eq('id', userId).single();
  if (targetError || !target) return json({ error: 'Account not found.' }, 404);
  if (String(target.email || '').toLowerCase() === PRIMARY_OWNER_EMAIL && role !== 'owner') return json({ error: 'The primary BeSeen Owner account is protected and cannot be demoted.' }, 400);
  const { error } = await supabase.from('profiles').update({ role, updated_at: new Date().toISOString() }).eq('id', userId);
  if (error) return json({ error: 'Could not update that role.' }, 500);
  return json({ ok: true, role });
}
