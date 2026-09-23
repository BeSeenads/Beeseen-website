import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function getServerSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function POST(request) {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured yet.' }, 503);
    const supabase = getServerSupabase();
    if (!supabase) return json({ error: 'Supabase server access is not configured yet.' }, 503);

    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Sign in first.' }, 401);
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    const user = userData?.user;
    if (userError || !user) return json({ error: 'Your sign-in session is invalid.' }, 401);

    const { data: profile } = await supabase.from('profiles').select('stripe_customer_id').eq('id', user.id).single();
    if (!profile?.stripe_customer_id) return json({ error: 'No Stripe billing account exists for this profile yet.' }, 400);

    const origin = new URL(request.url).origin;
    const portal = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${origin}/`
    });
    return json({ url: portal.url });
  } catch (error) {
    console.error('create-billing-portal error', error);
    return json({ error: 'We could not open billing management.' }, 500);
  }
}
