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
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export async function POST(request) {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured yet.' }, 503);

    const supabase = getServerSupabase();
    if (!supabase) return json({ error: 'Supabase server access is not configured yet.' }, 503);

    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Sign in before choosing a subscription.' }, 401);

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    const user = userData?.user;
    if (userError || !user) return json({ error: 'Your sign-in session is invalid. Please sign in again.' }, 401);

    const body = await request.json().catch(() => ({}));
    const plan = String(body.plan || '').toLowerCase();
    const locationSlug = String(body.locationSlug || 'exclusive').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!['gold','premium','platinum'].includes(plan)) return json({ error: 'Choose a valid subscription plan.' }, 400);

    let priceId = null;
    if (locationSlug) {
      const priceColumn = `stripe_price_${plan}`;
      const { data: location } = await supabase.from('locations').select(`slug,name,status,visibility,${priceColumn}`).eq('slug', locationSlug).single();
      if (!location || location.status !== 'live' || location.visibility !== 'public') return json({ error: 'That location is not currently available for public checkout.' }, 400);
      priceId = location[priceColumn] || null;
    }
    if (!priceId && locationSlug === 'exclusive') {
      priceId = { gold: process.env.STRIPE_PRICE_GOLD, premium: process.env.STRIPE_PRICE_PREMIUM, platinum: process.env.STRIPE_PRICE_PLATINUM }[plan];
    }
    if (!priceId) return json({ error: 'Stripe pricing for this location is not configured yet.' }, 400);

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id,subscription,subscription_status')
      .eq('id', user.id)
      .single();
    if (profileError) return json({ error: 'We could not load your BeSeen account.' }, 500);

    let customerId = profile?.stripe_customer_id || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        name: user.user_metadata?.full_name || undefined,
        metadata: { beseen_user_id: user.id }
      });
      customerId = customer.id;
      await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
    }

    const origin = new URL(request.url).origin;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
      allow_promotion_codes: true,
      metadata: { beseen_user_id: user.id, plan, location_slug: locationSlug },
      subscription_data: {
        metadata: { beseen_user_id: user.id, plan, location_slug: locationSlug }
      }
    });

    return json({ url: session.url });
  } catch (error) {
    console.error('create-checkout-session error', error);
    return json({ error: 'We could not start checkout. Please try again.' }, 500);
  }
}
