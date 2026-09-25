import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const EXTRA_LOCATION_DISCOUNT_CENTS = 5000;
const PLAN_RANK = { none: 0, gold: 1, premium: 2, platinum: 3 };

function getServerSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !serviceKey) return null;

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function cleanPlan(value) {
  const plan = String(value || '').toLowerCase();

  return ['gold', 'premium', 'platinum'].includes(plan)
    ? plan
    : 'none';
}

function splitSlugs(value) {
  return [
    ...new Set(
      String(value || '')
        .split(',')
        .map(v => v.trim().toLowerCase())
        .filter(Boolean)
    )
  ];
}

function parsePlanMap(value, slugs, fallback) {
  const map = new Map();

  String(value || '')
    .split(',')
    .forEach(part => {
      const [slug, plan] = part
        .split(':')
        .map(v => String(v || '').trim().toLowerCase());

      if (
        slug &&
        ['gold', 'premium', 'platinum'].includes(plan)
      ) {
        map.set(slug, plan);
      }
    });

  slugs.forEach(slug => {
    if (!map.has(slug)) {
      map.set(slug, cleanPlan(fallback));
    }
  });

  return map;
}

function customerIdFrom(value) {
  return typeof value === 'string'
    ? value
    : value?.id || null;
}

function subscriptionIdFromInvoice(invoice) {
  if (typeof invoice?.subscription === 'string') {
    return invoice.subscription;
  }

  if (invoice?.subscription?.id) {
    return invoice.subscription.id;
  }

  const parentSub =
    invoice?.parent?.subscription_details?.subscription;

  if (typeof parentSub === 'string') {
    return parentSub;
  }

  return parentSub?.id || null;
}

async function logEvent(
  supabase,
  {
    userId,
    customerId,
    subscriptionId,
    type,
    details = {}
  }
) {
  const { error } = await supabase
    .from('billing_events')
    .insert({
      user_id: userId || null,
      stripe_customer_id: customerId || null,
      stripe_subscription_id: subscriptionId || null,
      event_type: type,
      details
    });

  if (error) {
    console.error('billing event log failed', error);
  }
}

async function userIdByCustomer(supabase, customerId) {
  if (!customerId) return null;

  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  return data?.id || null;
}

async function updateByUserId(supabase, userId, values) {
  if (!userId) return;

  const { error } = await supabase
    .from('profiles')
    .update({
      ...values,
      updated_at: new Date().toISOString()
    })
    .eq('id', userId);

  if (error) throw error;
}

async function updateByCustomerId(
  supabase,
  customerId,
  values
) {
  if (!customerId) return;

  const { error } = await supabase
    .from('profiles')
    .update({
      ...values,
      updated_at: new Date().toISOString()
    })
    .eq('stripe_customer_id', customerId);

  if (error) throw error;
}

async function syncProfileAccess(supabase, userId) {
  if (!userId) return;

  const { data: rows, error } = await supabase
    .from('subscription_locations')
    .select(
      'plan,status,stripe_customer_id,stripe_subscription_id'
    )
    .eq('user_id', userId);

  if (error) throw error;

  const activeRows = (rows || []).filter(row =>
    ['active', 'trialing'].includes(
      String(row.status || '').toLowerCase()
    )
  );

  const pastDueRows = (rows || []).filter(
    row =>
      String(row.status || '').toLowerCase() ===
      'past_due'
  );

  let bestPlan = 'none';

  activeRows.forEach(row => {
    const plan = cleanPlan(row.plan);

    if (PLAN_RANK[plan] > PLAN_RANK[bestPlan]) {
      bestPlan = plan;
    }
  });

  const source =
    activeRows[0] ||
    pastDueRows[0] ||
    rows?.[0] ||
    null;

  const status = activeRows.length
    ? 'active'
    : pastDueRows.length
      ? 'past_due'
      : 'inactive';

  await updateByUserId(supabase, userId, {
    subscription: bestPlan,
    subscription_status: status,
    stripe_customer_id:
      source?.stripe_customer_id || null,
    stripe_subscription_id:
      source?.stripe_subscription_id || null
  });
}

async function upsertSubscriptionLocations(
  supabase,
  {
    userId,
    customerId,
    subscriptionId,
    fallbackPlan,
    status,
    locationSlugs,
    discountedSlugs,
    planMap
  }
) {
  if (
    !userId ||
    !subscriptionId ||
    !locationSlugs.length
  ) {
    return;
  }

  const { data: locations, error } = await supabase
    .from('locations')
    .select(
      'id,slug,name,gold_price_cents,premium_price_cents,platinum_price_cents'
    )
    .in('slug', locationSlugs);

  if (error) throw error;

  const locMap = new Map(
    (locations || []).map(loc => [
      loc.slug,
      loc
    ])
  );

  const discountSet =
    new Set(discountedSlugs);

  const rows = locationSlugs.map(slug => {
    const loc = locMap.get(slug);

    const plan = cleanPlan(
      planMap?.get(slug) || fallbackPlan
    );

    const list = Number(
      loc?.[`${plan}_price_cents`] || 0
    );

    const discount =
      discountSet.has(slug)
        ? Math.min(
            EXTRA_LOCATION_DISCOUNT_CENTS,
            list
          )
        : 0;

    return {
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      location_id: loc?.id || null,
      location_slug: slug,
      plan,
      status: status || 'active',
      list_price_cents: list,
      billed_price_cents:
        Math.max(0, list - discount),
      discount_cents: discount,
      updated_at:
        new Date().toISOString()
    };
  });

  const { error: upsertError } =
    await supabase
      .from('subscription_locations')
      .upsert(rows, {
        onConflict:
          'stripe_subscription_id,location_slug'
      });

  if (upsertError) {
    throw upsertError;
  }
}

async function syncItemFields(
  supabase,
  subscriptionId,
  locationSlugs,
  planMap,
  cancelAtPeriodEnd = false
) {
  if (
    !subscriptionId ||
    !locationSlugs.length
  ) {
    return;
  }

  const [
    { data: locations },
    items
  ] = await Promise.all([
    supabase
      .from('locations')
      .select(
        'id,slug,stripe_price_gold,stripe_price_premium,stripe_price_platinum'
      )
      .in('slug', locationSlugs),

    stripe.subscriptionItems.list({
      subscription: subscriptionId,
      limit: 100
    })
  ]);

  const locMap = new Map(
    (locations || []).map(l => [
      l.slug,
      l
    ])
  );

  const unused = [...items.data];

  for (
    let index = 0;
    index < locationSlugs.length;
    index++
  ) {
    const slug = locationSlugs[index];
    const loc = locMap.get(slug);

    const plan =
      cleanPlan(planMap.get(slug));

    let expected =
      loc?.[`stripe_price_${plan}`] ||
      null;

    if (slug === 'exclusive') {
      expected =
        {
          gold:
            process.env.STRIPE_PRICE_GOLD,
          premium:
            process.env.STRIPE_PRICE_PREMIUM,
          platinum:
            process.env.STRIPE_PRICE_PLATINUM
        }[plan] || expected;
    }

    let foundIndex =
      unused.findIndex(
        i =>
          expected &&
          i.price?.id === expected
      );

    if (
      foundIndex < 0 &&
      unused.length ===
        locationSlugs.length - index
    ) {
      foundIndex = 0;
    }

    if (foundIndex < 0) continue;

    const item =
      unused.splice(foundIndex, 1)[0];

    const start =
      Number(
        item.current_period_start ||
        0
      );

    const end =
      Number(
        item.current_period_end ||
        0
      );

    await supabase
      .from('subscription_locations')
      .update({
        stripe_subscription_item_id:
          item.id,

        stripe_price_id:
          item.price?.id ||
          expected ||
          null,

        current_period_start:
          start
            ? new Date(
                start * 1000
              ).toISOString()
            : null,

        current_period_end:
          end
            ? new Date(
                end * 1000
              ).toISOString()
            : null,

        cancel_at_period_end:
          !!cancelAtPeriodEnd,

        updated_at:
          new Date().toISOString()
      })
      .eq(
        'stripe_subscription_id',
        subscriptionId
      )
      .eq(
        'location_slug',
        slug
      );
  }
}

async function updateSubscriptionRows(
  supabase,
  subscriptionId,
  status,
  paymentFailed = null
) {
  if (!subscriptionId) return [];

  const values = {
    status,
    updated_at:
      new Date().toISOString()
  };

  if (paymentFailed !== null) {
    values.payment_failed =
      paymentFailed;
  }

  const { data, error } =
    await supabase
      .from('subscription_locations')
      .update(values)
      .eq(
        'stripe_subscription_id',
        subscriptionId
      )
      .select('user_id');

  if (error) throw error;

  return [
    ...new Set(
      (data || [])
        .map(r => r.user_id)
        .filter(Boolean)
    )
  ];
}

async function finalizeExpiredLocationCancellations(
  supabase,
  subscriptionId
) {
  if (!subscriptionId) return [];

  const now =
    new Date().toISOString();

  const { data: expiring, error } =
    await supabase
      .from('subscription_locations')
      .select(
        'id,user_id,location_id'
      )
      .eq(
        'stripe_subscription_id',
        subscriptionId
      )
      .eq(
        'cancel_at_period_end',
        true
      )
      .lte(
        'current_period_end',
        now
      )
      .not(
        'status',
        'eq',
        'canceled'
      );

  if (error) throw error;

  for (const row of expiring || []) {
    await supabase
      .from('subscription_locations')
      .update({
        status: 'canceled',
        canceled_at: now,
        payment_failed: false,
        updated_at: now
      })
      .eq('id', row.id);

    if (row.location_id) {
      await supabase
        .from('campaigns')
        .update({
          status: 'ended',
          updated_at: now
        })
        .eq(
          'stripe_subscription_id',
          subscriptionId
        )
        .eq(
          'location_id',
          row.location_id
        );
    }
  }

  return [
    ...new Set(
      (expiring || [])
        .map(r => r.user_id)
        .filter(Boolean)
    )
  ];
}

function buildTrackingCode(locationSlug) {
  const prefix =
    String(locationSlug || 'campaign')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 36) ||
    'campaign';

  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

async function ensureAutomaticCampaigns(
  supabase,
  {
    intakeId,
    userId,
    subscriptionId,
    locationSlugs
  }
) {
  if (
    !intakeId ||
    !userId ||
    !locationSlugs?.length
  ) {
    return;
  }

  const {
    data: intake,
    error: intakeError
  } =
    await supabase
      .from('subscription_intakes')
      .select(
        'id,business_name,qr_destination_url'
      )
      .eq('id', intakeId)
      .eq('user_id', userId)
      .maybeSingle();

  if (intakeError) {
    throw intakeError;
  }

  if (!intake?.qr_destination_url) {
    return;
  }

  const {
    data: locations,
    error: locationError
  } =
    await supabase
      .from('locations')
      .select(
        'id,slug,name'
      )
      .in(
        'slug',
        locationSlugs
      );

  if (locationError) {
    throw locationError;
  }

  for (
    const loc of
    locations || []
  ) {
    const {
      data: existing,
      error: existingError
    } =
      await supabase
        .from('campaigns')
        .select(
          'id,tracking_code,status'
        )
        .eq(
          'subscription_intake_id',
          intake.id
        )
        .eq(
          'location_id',
          loc.id
        )
        .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    const values = {
      advertiser_id:
        userId,

      location_id:
        loc.id,

      name:
        `${intake.business_name} — ${loc.name}`.slice(
          0,
          180
        ),

      landing_url:
        intake.qr_destination_url,

      status:
        existing?.status ||
        'draft',

      subscription_intake_id:
        intake.id,

      stripe_subscription_id:
        subscriptionId,

      updated_at:
        new Date().toISOString()
    };

    if (existing?.id) {
      const { error } =
        await supabase
          .from('campaigns')
          .update(values)
          .eq(
            'id',
            existing.id
          );

      if (error) throw error;
    } else {
      const { error } =
        await supabase
          .from('campaigns')
          .insert({
            ...values,
            tracking_code:
              buildTrackingCode(
                loc.slug
              )
          });

      if (error) throw error;
    }
  }
}

async function syncCampaignTerminalStatus(
  supabase,
  subscriptionId,
  subscriptionStatus
) {
  if (!subscriptionId) return;

  const status =
    String(
      subscriptionStatus || ''
    ).toLowerCase();

  let campaignStatus = null;

  if (
    [
      'canceled',
      'unpaid',
      'incomplete_expired'
    ].includes(status)
  ) {
    campaignStatus = 'ended';
  } else if (
    status === 'paused'
  ) {
    campaignStatus = 'paused';
  }

  if (!campaignStatus) return;

  const { error } =
    await supabase
      .from('campaigns')
      .update({
        status: campaignStatus,
        updated_at:
          new Date().toISOString()
      })
      .eq(
        'stripe_subscription_id',
        subscriptionId
      );

  if (error) throw error;
}

export async function POST(request) {
  if (
    !process.env.STRIPE_SECRET_KEY ||
    !process.env.STRIPE_WEBHOOK_SECRET
  ) {
    return new Response(
      'Stripe webhook is not configured.',
      {
        status: 503
      }
    );
  }

  const supabase =
    getServerSupabase();

  if (!supabase) {
    return new Response(
      'Supabase server access is not configured.',
      {
        status: 503
      }
    );
  }

  const signature =
    request.headers.get(
      'stripe-signature'
    );

  const rawBody =
    await request.text();

  let event;

  try {
    event =
      stripe.webhooks.constructEvent(
        rawBody,
        signature,
        process.env
          .STRIPE_WEBHOOK_SECRET
      );
  } catch (error) {
    console.error(
      'Invalid Stripe signature',
      error
    );

    return new Response(
      'Invalid signature',
      {
        status: 400
      }
    );
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session =
          event.data.object;

        if (
          session.mode !==
          'subscription'
        ) {
          break;
        }

        const userId =
          session.metadata
            ?.beseen_user_id ||
          session.client_reference_id;

        const fallbackPlan =
          cleanPlan(
            session.metadata?.plan
          );

        const customerId =
          customerIdFrom(
            session.customer
          );

        const subscriptionId =
          customerIdFrom(
            session.subscription
          );

        const locationSlugs =
          splitSlugs(
            session.metadata
              ?.location_slugs ||
              session.metadata
                ?.location_slug
          );

        const discountedSlugs =
          splitSlugs(
            session.metadata
              ?.discounted_location_slugs
          );

        const planMap =
          parsePlanMap(
            session.metadata
              ?.location_plan_map,
            locationSlugs,
            fallbackPlan
          );

        const intakeId =
          session.metadata
            ?.intake_id ||
          null;

        if (intakeId) {
          const {
            error: intakeError
          } =
            await supabase
              .from(
                'subscription_intakes'
              )
              .update({
                status: 'paid',
                stripe_customer_id:
                  customerId,
                stripe_subscription_id:
                  subscriptionId,
                updated_at:
                  new Date().toISOString()
              })
              .eq('id', intakeId)
              .eq(
                'user_id',
                userId
              );

          if (intakeError) {
            console.error(
              'Could not update subscription intake',
              intakeError
            );
          }
        }

        await upsertSubscriptionLocations(
          supabase,
          {
            userId,
            customerId,
            subscriptionId,
            fallbackPlan,
            status: 'active',
            locationSlugs,
            discountedSlugs,
            planMap
          }
        );

        await syncItemFields(
          supabase,
          subscriptionId,
          locationSlugs,
          planMap,
          false
        );

        await ensureAutomaticCampaigns(
          supabase,
          {
            intakeId,
            userId,
            subscriptionId,
            locationSlugs
          }
        );

        if (
          locationSlugs.length
        ) {
          await syncProfileAccess(
            supabase,
            userId
          );
        } else {
          await updateByUserId(
            supabase,
            userId,
            {
              stripe_customer_id:
                customerId,
              stripe_subscription_id:
                subscriptionId,
              subscription:
                fallbackPlan,
              subscription_status:
                'active'
            }
          );
        }

        await logEvent(
          supabase,
          {
            userId,
            customerId,
            subscriptionId,
            type:
              'checkout_completed',
            details: {
              location_slugs:
                locationSlugs,
              plan_map:
                Object.fromEntries(
                  planMap
                )
            }
          }
        );

        break;
      }

      case 'customer.subscription.updated': {
        const subscription =
          event.data.object;

        const customerId =
          customerIdFrom(
            subscription.customer
          );

        const userId =
          subscription.metadata
            ?.beseen_user_id ||
          await userIdByCustomer(
            supabase,
            customerId
          );

        const fallbackPlan =
          cleanPlan(
            subscription.metadata
              ?.plan
          );

        const status =
          subscription.status ||
          'inactive';

        const locationSlugs =
          splitSlugs(
            subscription.metadata
              ?.location_slugs ||
              subscription.metadata
                ?.location_slug
          );

        const discountedSlugs =
          splitSlugs(
            subscription.metadata
              ?.discounted_location_slugs
          );

        const planMap =
          parsePlanMap(
            subscription.metadata
              ?.location_plan_map,
            locationSlugs,
            fallbackPlan
          );

        if (
          userId &&
          locationSlugs.length
        ) {
          await upsertSubscriptionLocations(
            supabase,
            {
              userId,
              customerId,
              subscriptionId:
                subscription.id,
              fallbackPlan,
              status,
              locationSlugs,
              discountedSlugs,
              planMap
            }
          );

          await syncItemFields(
            supabase,
            subscription.id,
            locationSlugs,
            planMap,
            !!subscription.cancel_at_period_end
          );

          if (
            subscription.cancel_at_period_end
          ) {
            await supabase
              .from(
                'subscription_locations'
              )
              .update({
                cancel_at_period_end:
                  true,
                cancellation_requested_at:
                  new Date().toISOString(),
                updated_at:
                  new Date().toISOString()
              })
              .eq(
                'stripe_subscription_id',
                subscription.id
              )
              .in(
                'location_slug',
                locationSlugs
              );
          }

          await syncProfileAccess(
            supabase,
            userId
          );
        } else {
          const values = {
            stripe_subscription_id:
              subscription.id,

            stripe_customer_id:
              customerId,

            subscription:
              [
                'canceled',
                'unpaid',
                'incomplete_expired'
              ].includes(status)
                ? 'none'
                : fallbackPlan,

            subscription_status:
              status
          };

          if (userId) {
            await updateByUserId(
              supabase,
              userId,
              values
            );
          } else {
            await updateByCustomerId(
              supabase,
              customerId,
              values
            );
          }
        }

        await syncCampaignTerminalStatus(
          supabase,
          subscription.id,
          status
        );

        await logEvent(
          supabase,
          {
            userId,
            customerId,
            subscriptionId:
              subscription.id,
            type:
              'subscription_updated',
            details: {
              status,
              cancel_at_period_end:
                !!subscription.cancel_at_period_end,
              location_slugs:
                locationSlugs
            }
          }
        );

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription =
          event.data.object;

        const customerId =
          customerIdFrom(
            subscription.customer
          );

        const userId =
          subscription.metadata
            ?.beseen_user_id ||
          await userIdByCustomer(
            supabase,
            customerId
          );

        await supabase
          .from(
            'subscription_intakes'
          )
          .update({
            status:
              'subscription_canceled',
            updated_at:
              new Date().toISOString()
          })
          .eq(
            'stripe_subscription_id',
            subscription.id
          );

        await supabase
          .from('campaigns')
          .update({
            status: 'ended',
            updated_at:
              new Date().toISOString()
          })
          .eq(
            'stripe_subscription_id',
            subscription.id
          );

        const {
          data: affected,
          error
        } =
          await supabase
            .from(
              'subscription_locations'
            )
            .update({
              status: 'canceled',
              cancel_at_period_end:
                false,
              canceled_at:
                new Date().toISOString(),
              payment_failed:
                false,
              updated_at:
                new Date().toISOString()
            })
            .eq(
              'stripe_subscription_id',
              subscription.id
            )
            .select(
              'user_id'
            );

        if (error) {
          throw error;
        }

        const affectedUsers =
          [
            ...new Set(
              (affected || [])
                .map(
                  r => r.user_id
                )
                .filter(Boolean)
            )
          ];

        if (
          affectedUsers.length
        ) {
          for (
            const id of
            affectedUsers
          ) {
            await syncProfileAccess(
              supabase,
              id
            );
          }
        } else {
          const values = {
            subscription:
              'none',

            subscription_status:
              'canceled',

            stripe_subscription_id:
              null
          };

          if (userId) {
            await updateByUserId(
              supabase,
              userId,
              values
            );
          } else {
            await updateByCustomerId(
              supabase,
              customerId,
              values
            );
          }
        }

        await logEvent(
          supabase,
          {
            userId,
            customerId,
            subscriptionId:
              subscription.id,
            type:
              'subscription_canceled',
            details: {
              ended_at:
                new Date().toISOString()
            }
          }
        );

        break;
      }

      case 'invoice.payment_failed':
      case 'invoice.paid': {
        const invoice =
          event.data.object;

        const customerId =
          customerIdFrom(
            invoice.customer
          );

        const subscriptionId =
          subscriptionIdFromInvoice(
            invoice
          );

        const status =
          event.type ===
          'invoice.paid'
            ? 'active'
            : 'past_due';

        const paymentFailed =
          event.type ===
          'invoice.payment_failed';

        let affectedUsers =
          await updateSubscriptionRows(
            supabase,
            subscriptionId,
            status,
            paymentFailed
          );

        const finalized =
          await finalizeExpiredLocationCancellations(
            supabase,
            subscriptionId
          );

        affectedUsers =
          [
            ...new Set([
              ...affectedUsers,
              ...finalized
            ])
          ];

        if (
          affectedUsers.length
        ) {
          for (
            const id of
            affectedUsers
          ) {
            await syncProfileAccess(
              supabase,
              id
            );
          }
        } else {
          await updateByCustomerId(
            supabase,
            customerId,
            {
              subscription_status:
                status
            }
          );
        }

        await logEvent(
          supabase,
          {
            userId:
              affectedUsers[0] ||
              await userIdByCustomer(
                supabase,
                customerId
              ),

            customerId,
            subscriptionId,

            type:
              event.type,

            details: {
              invoice_id:
                invoice.id,
              amount_paid:
                invoice.amount_paid,
              amount_due:
                invoice.amount_due
            }
          }
        );

        break;
      }

      default:
        break;
    }

    return new Response('ok', {
      status: 200
    });
  } catch (error) {
    console.error(
      'Stripe webhook handler error',
      error
    );

    return new Response(
      'Webhook handling failed',
      {
        status: 500
      }
    );
  }
}
