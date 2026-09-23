import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

function getServerSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function planFromSubscription(subscription) {
  const plan = String(subscription?.metadata?.plan || '').toLowerCase();
  return ['gold', 'premium', 'platinum'].includes(plan) ? plan : 'none';
}

async function updateByUserId(supabase, userId, values) {
  if (!userId) return;
  const { error } = await supabase.from('profiles').update({ ...values, updated_at: new Date().toISOString() }).eq('id', userId);
  if (error) throw error;
}

async function updateByCustomerId(supabase, customerId, values) {
  if (!customerId) return;
  const { error } = await supabase.from('profiles').update({ ...values, updated_at: new Date().toISOString() }).eq('stripe_customer_id', customerId);
  if (error) throw error;
}

export async function POST(request) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Stripe webhook is not configured.', { status: 503 });
  }
  const supabase = getServerSupabase();
  if (!supabase) return new Response('Supabase server access is not configured.', { status: 503 });

  const signature = request.headers.get('stripe-signature');
  const rawBody = await request.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('Invalid Stripe signature', error);
    return new Response('Invalid signature', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;
        const userId = session.metadata?.beseen_user_id || session.client_reference_id;
        const plan = String(session.metadata?.plan || '').toLowerCase();
        await updateByUserId(supabase, userId, {
          stripe_customer_id: typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
          stripe_subscription_id: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null,
          subscription: ['gold','premium','platinum'].includes(plan) ? plan : 'none',
          subscription_status: 'active'
        });
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.beseen_user_id;
        const plan = planFromSubscription(subscription);
        const stripeStatus = subscription.status || 'inactive';
        const keepPlan = !['canceled','unpaid','incomplete_expired'].includes(stripeStatus);
        const values = {
          stripe_subscription_id: subscription.id,
          stripe_customer_id: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id || null,
          subscription: keepPlan ? plan : 'none',
          subscription_status: stripeStatus
        };
        if (userId) await updateByUserId(supabase, userId, values);
        else await updateByCustomerId(supabase, values.stripe_customer_id, values);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.beseen_user_id;
        const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id || null;
        const values = { subscription: 'none', subscription_status: 'canceled', stripe_subscription_id: null };
        if (userId) await updateByUserId(supabase, userId, values);
        else await updateByCustomerId(supabase, customerId, values);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null;
        await updateByCustomerId(supabase, customerId, { subscription_status: 'past_due' });
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null;
        await updateByCustomerId(supabase, customerId, { subscription_status: 'active' });
        break;
      }
      default:
        break;
    }
    return new Response('ok', { status: 200 });
  } catch (error) {
    console.error('Stripe webhook handler error', error);
    return new Response('Webhook handling failed', { status: 500 });
  }
}
