import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const PRIMARY_OWNER_EMAIL =
  (process.env.BESEEN_OWNER_EMAIL || 'akilhsen4@gmail.com').toLowerCase();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return null;
  }

  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );
}

async function requireOwner(request, supabase) {
  const token = (request.headers.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim();

  if (!token) {
    return { error: json({ error: 'Sign in first.' }, 401) };
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return {
      error: json({ error: 'Invalid sign-in session.' }, 401)
    };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id,email,role')
    .eq('id', data.user.id)
    .single();

  if (profile?.role !== 'owner') {
    return {
      error: json({ error: 'Owner access required.' }, 403)
    };
  }

  return {
    user: data.user,
    profile
  };
}

function cleanSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function cleanPlan(value) {
  const plan = String(value || '').toLowerCase();

  return ['gold', 'premium', 'platinum'].includes(plan)
    ? plan
    : '';
}

function cleanBillingSource(value) {
  const source = String(value || '').toLowerCase();

  return ['stripe', 'zelle', 'cash', 'check', 'other'].includes(source)
    ? source
    : '';
}

function cleanNote(value) {
  return String(value || '').trim().slice(0, 1000);
}

function cents(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  return Math.round(n);
}

async function loadProfile(supabase, userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select(
      'id,email,full_name,role,subscription,subscription_status,stripe_customer_id'
    )
    .eq('id', userId)
    .single();

  if (error || !data) return null;

  return data;
}

async function loadLocation(supabase, slug) {
  const { data, error } = await supabase
    .from('locations')
    .select(
      'id,slug,name,gold_price_cents,premium_price_cents,platinum_price_cents,stripe_price_gold,stripe_price_premium,stripe_price_platinum'
    )
    .eq('slug', slug)
    .single();

  if (error || !data) return null;

  return data;
}

function standardPriceId(location, plan) {
  let priceId =
    location?.[`stripe_price_${plan}`] || null;

  if (location?.slug === 'exclusive') {
    priceId =
      {
        gold: process.env.STRIPE_PRICE_GOLD,
        premium: process.env.STRIPE_PRICE_PREMIUM,
        platinum: process.env.STRIPE_PRICE_PLATINUM
      }[plan] || priceId;
  }

  return priceId;
}

function standardPriceCents(location, plan) {
  return Number(
    location?.[`${plan}_price_cents`] || 0
  );
}

async function ensureStripeCustomer(supabase, profile) {
  let customerId =
    profile?.stripe_customer_id || null;

  if (customerId) {
    try {
      const customer =
        await stripe.customers.retrieve(customerId);

      if (customer?.deleted) {
        customerId = null;
      }
    } catch (error) {
      if (
        error?.code === 'resource_missing' ||
        error?.type === 'StripeInvalidRequestError'
      ) {
        customerId = null;
      } else {
        throw error;
      }
    }
  }

  if (!customerId) {
    const customer =
      await stripe.customers.create({
        email: profile?.email || undefined,
        name: profile?.full_name || undefined,
        metadata: {
          beseen_user_id: profile.id
        }
      });

    customerId = customer.id;

    await supabase
      .from('profiles')
      .update({
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString()
      })
      .eq('id', profile.id);
  }

  return customerId;
}

async function createCustomRecurringPrice({
  basePriceId,
  unitAmount,
  userId,
  locationSlug,
  plan
}) {
  const basePrice =
    await stripe.prices.retrieve(basePriceId);

  const productId =
    typeof basePrice.product === 'string'
      ? basePrice.product
      : basePrice.product?.id;

  if (!productId) {
    throw new Error(
      'Could not determine the Stripe product for this plan.'
    );
  }

  return stripe.prices.create({
    currency: 'usd',
    unit_amount: unitAmount,
    recurring: {
      interval: 'month'
    },
    product: productId,
    nickname:
      `BeSeen custom ${plan} — ${locationSlug}`.slice(
        0,
        250
      ),
    metadata: {
      beseen_custom_price: 'true',
      beseen_user_id: userId,
      location_slug: locationSlug,
      plan
    }
  });
}

async function loadSubscriptionRow(
  supabase,
  userId,
  locationSlug
) {
  const { data, error } = await supabase
    .from('subscription_locations')
    .select(
      'id,user_id,location_id,location_slug,plan,status,list_price_cents,billed_price_cents,discount_cents,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,stripe_price_id,current_period_end,custom_price_cents,custom_price_active,billing_source,paid_through,next_charge_at'
    )
    .eq('user_id', userId)
    .eq('location_slug', locationSlug)
    .in('status', [
      'active',
      'trialing',
      'past_due'
    ])
    .order('created_at', {
      ascending: false
    })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function resolveSubscriptionItem(
  row,
  fallbackPriceId
) {
  if (!row?.stripe_subscription_id) {
    return null;
  }

  const items =
    await stripe.subscriptionItems.list({
      subscription:
        row.stripe_subscription_id,
      limit: 100
    });

  if (row.stripe_subscription_item_id) {
    const byId =
      items.data.find(
        item =>
          item.id ===
          row.stripe_subscription_item_id
      );

    if (byId) return byId;
  }

  if (row.stripe_price_id) {
    const bySavedPrice =
      items.data.find(
        item =>
          item.price?.id ===
          row.stripe_price_id
      );

    if (bySavedPrice) {
      return bySavedPrice;
    }
  }

  if (fallbackPriceId) {
    const byFallback =
      items.data.find(
        item =>
          item.price?.id ===
          fallbackPriceId
      );

    if (byFallback) {
      return byFallback;
    }
  }

  if (items.data.length === 1) {
    return items.data[0];
  }

  return null;
}

async function saveOverride(
  supabase,
  values
) {
  const { data, error } =
    await supabase
      .from('billing_overrides')
      .upsert(
        {
          ...values,
          updated_at:
            new Date().toISOString()
        },
        {
          onConflict:
            'user_id,location_slug'
        }
      )
      .select()
      .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function GET(request) {
  const supabase = db();

  if (!supabase) {
    return json(
      {
        error:
          'Supabase server access is not configured.'
      },
      503
    );
  }

  const auth =
    await requireOwner(
      request,
      supabase
    );

  if (auth.error) {
    return auth.error;
  }

  const [
    { data: accounts, error: accountError },
    { data: subscriptionRows, error: rowError },
    { data: overrides, error: overrideError }
  ] = await Promise.all([
    supabase
      .from('profiles')
      .select(
        'id,email,full_name,role,subscription,subscription_status,created_at,stripe_customer_id'
      )
      .order(
        'created_at',
        {
          ascending: false
        }
      ),

    supabase
      .from('subscription_locations')
      .select(
        'id,user_id,location_id,location_slug,plan,status,list_price_cents,billed_price_cents,discount_cents,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,stripe_price_id,current_period_end,custom_price_cents,custom_price_active,billing_source,paid_through,next_charge_at'
      )
      .order(
        'created_at',
        {
          ascending: false
        }
      ),

    supabase
      .from('billing_overrides')
      .select(
        'id,user_id,location_id,location_slug,plan,standard_price_cents,custom_price_cents,custom_price_active,billing_source,paid_through,next_charge_at,migration_status,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,stripe_custom_price_id,stripe_checkout_session_id,owner_note,updated_at'
      )
      .order(
        'updated_at',
        {
          ascending: false
        }
      )
  ]);

  if (
    accountError ||
    rowError ||
    overrideError
  ) {
    console.error(
      'admin account load failed',
      {
        accountError,
        rowError,
        overrideError
      }
    );

    return json(
      {
        error:
          'Could not load owner billing data.'
      },
      500
    );
  }

  const rowsByUser = new Map();
  const overridesByUser = new Map();

  for (
    const row of
    subscriptionRows || []
  ) {
    const list =
      rowsByUser.get(row.user_id) ||
      [];

    list.push(row);
    rowsByUser.set(
      row.user_id,
      list
    );
  }

  for (
    const row of
    overrides || []
  ) {
    const list =
      overridesByUser.get(
        row.user_id
      ) || [];

    list.push(row);
    overridesByUser.set(
      row.user_id,
      list
    );
  }

  return json({
    accounts:
      (accounts || []).map(
        account => ({
          ...account,

          primary_owner:
            String(
              account.email || ''
            ).toLowerCase() ===
            PRIMARY_OWNER_EMAIL,

          advertising_locations:
            rowsByUser.get(
              account.id
            ) || [],

          billing_overrides:
            overridesByUser.get(
              account.id
            ) || []
        })
      )
  });
}

export async function PATCH(request) {
  try {
    if (
      !process.env
        .STRIPE_SECRET_KEY
    ) {
      return json(
        {
          error:
            'Stripe is not configured.'
        },
        503
      );
    }

    const supabase = db();

    if (!supabase) {
      return json(
        {
          error:
            'Supabase server access is not configured.'
        },
        503
      );
    }

    const auth =
      await requireOwner(
        request,
        supabase
      );

    if (auth.error) {
      return auth.error;
    }

    const body =
      await request
        .json()
        .catch(() => ({}));

    const action =
      String(
        body.action ||
          (
            body.role
              ? 'role'
              : ''
          )
      ).toLowerCase();

    const userId =
      String(
        body.userId || ''
      ).trim();

    if (!userId) {
      return json(
        {
          error:
            'Choose a customer first.'
        },
        400
      );
    }

    const target =
      await loadProfile(
        supabase,
        userId
      );

    if (!target) {
      return json(
        {
          error:
            'Account not found.'
        },
        404
      );
    }

    if (action === 'role') {
      const role =
        String(
          body.role || ''
        ).toLowerCase();

      if (
        ![
          'member',
          'admin',
          'owner'
        ].includes(role)
      ) {
        return json(
          {
            error:
              'Choose a valid account and role.'
          },
          400
        );
      }

      if (
        String(
          target.email || ''
        ).toLowerCase() ===
          PRIMARY_OWNER_EMAIL &&
        role !== 'owner'
      ) {
        return json(
          {
            error:
              'The primary BeSeen Owner account is protected and cannot be demoted.'
          },
          400
        );
      }

      const { error } =
        await supabase
          .from('profiles')
          .update({
            role,
            updated_at:
              new Date().toISOString()
          })
          .eq(
            'id',
            userId
          );

      if (error) {
        return json(
          {
            error:
              'Could not update that role.'
          },
          500
        );
      }

      return json({
        ok: true,
        role
      });
    }

    const locationSlug =
      cleanSlug(
        body.locationSlug
      );

    if (!locationSlug) {
      return json(
        {
          error:
            'Choose an advertising location.'
        },
        400
      );
    }

    const location =
      await loadLocation(
        supabase,
        locationSlug
      );

    if (!location) {
      return json(
        {
          error:
            'Advertising location not found.'
        },
        404
      );
    }

    if (
      action ===
      'set_custom_price'
    ) {
      const row =
        await loadSubscriptionRow(
          supabase,
          userId,
          locationSlug
        );

      if (
        !row ||
        !row.stripe_subscription_id
      ) {
        return json(
          {
            error:
              'This customer does not have an active Stripe subscription for that location. Use the offline/Zelle migration option instead.'
          },
          400
        );
      }

      const plan =
        cleanPlan(
          row.plan
        );

      if (!plan) {
        return json(
          {
            error:
              'The customer plan is invalid.'
          },
          400
        );
      }

      const customPriceCents =
        cents(
          body.customPriceCents
        );

      if (
        customPriceCents === null ||
        customPriceCents < 100
      ) {
        return json(
          {
            error:
              'Custom monthly price must be at least $1.00.'
          },
          400
        );
      }

      const basePriceId =
        standardPriceId(
          location,
          plan
        );

      if (!basePriceId) {
        return json(
          {
            error:
              'The standard Stripe price for this plan is not configured.'
          },
          400
        );
      }

      const item =
        await resolveSubscriptionItem(
          row,
          basePriceId
        );

      if (!item) {
        return json(
          {
            error:
              'We could not identify this location inside the Stripe subscription.'
          },
          409
        );
      }

      const stripeUnitAmount =
        customPriceCents +
        Number(
          row.discount_cents || 0
        );

      const customPrice =
        await createCustomRecurringPrice(
          {
            basePriceId,
            unitAmount:
              stripeUnitAmount,
            userId,
            locationSlug,
            plan
          }
        );

      await stripe.subscriptions.update(
        row.stripe_subscription_id,
        {
          items: [
            {
              id: item.id,
              price:
                customPrice.id,
              quantity:
                item.quantity || 1
            }
          ],
          proration_behavior:
            'none'
        }
      );

      const standardCents =
        standardPriceCents(
          location,
          plan
        );

      const now =
        new Date().toISOString();

      const { error: rowUpdateError } =
        await supabase
          .from(
            'subscription_locations'
          )
          .update({
            custom_price_cents:
              customPriceCents,
            custom_price_active:
              true,
            billed_price_cents:
              customPriceCents,
            stripe_price_id:
              customPrice.id,
            billing_source:
              'stripe',
            updated_at: now
          })
          .eq(
            'id',
            row.id
          );

      if (rowUpdateError) {
        throw rowUpdateError;
      }

      const override =
        await saveOverride(
          supabase,
          {
            user_id: userId,
            location_id:
              location.id,
            location_slug:
              locationSlug,
            plan,
            standard_price_cents:
              standardCents,
            custom_price_cents:
              customPriceCents,
            custom_price_active:
              true,
            billing_source:
              'stripe',
            paid_through:
              null,
            next_charge_at:
              row.current_period_end ||
              null,
            migration_status:
              'active',
            stripe_customer_id:
              row.stripe_customer_id ||
              target.stripe_customer_id ||
              null,
            stripe_subscription_id:
              row.stripe_subscription_id,
            stripe_subscription_item_id:
              item.id,
            stripe_custom_price_id:
              customPrice.id,
            stripe_checkout_session_id:
              null,
            owner_note:
              cleanNote(
                body.ownerNote
              ) || null,
            created_by:
              auth.user.id,
            updated_by:
              auth.user.id
          }
        );

      return json({
        ok: true,
        action:
          'set_custom_price',
        customPriceCents,
        standardPriceCents:
          standardCents,
        effective:
          'next_billing_cycle',
        override
      });
    }

    if (
      action ===
      'restore_standard_price'
    ) {
      const row =
        await loadSubscriptionRow(
          supabase,
          userId,
          locationSlug
        );

      if (
        !row ||
        !row.stripe_subscription_id
      ) {
        return json(
          {
            error:
              'No active Stripe subscription was found for that location.'
          },
          400
        );
      }

      const plan =
        cleanPlan(
          row.plan
        );

      const basePriceId =
        standardPriceId(
          location,
          plan
        );

      if (!basePriceId) {
        return json(
          {
            error:
              'The standard Stripe price for this plan is not configured.'
          },
          400
        );
      }

      const item =
        await resolveSubscriptionItem(
          row,
          basePriceId
        );

      if (!item) {
        return json(
          {
            error:
              'We could not identify this location inside the Stripe subscription.'
          },
          409
        );
      }

      await stripe.subscriptions.update(
        row.stripe_subscription_id,
        {
          items: [
            {
              id: item.id,
              price:
                basePriceId,
              quantity:
                item.quantity || 1
            }
          ],
          proration_behavior:
            'none'
        }
      );

      const standardCents =
        standardPriceCents(
          location,
          plan
        );

      const billedCents =
        Math.max(
          0,
          standardCents -
            Number(
              row.discount_cents ||
                0
            )
        );

      const now =
        new Date().toISOString();

      const { error: rowUpdateError } =
        await supabase
          .from(
            'subscription_locations'
          )
          .update({
            custom_price_cents:
              null,
            custom_price_active:
              false,
            billed_price_cents:
              billedCents,
            stripe_price_id:
              basePriceId,
            billing_source:
              'stripe',
            updated_at: now
          })
          .eq(
            'id',
            row.id
          );

      if (rowUpdateError) {
        throw rowUpdateError;
      }

      await saveOverride(
        supabase,
        {
          user_id: userId,
          location_id:
            location.id,
          location_slug:
            locationSlug,
          plan,
          standard_price_cents:
            standardCents,
          custom_price_cents:
            null,
          custom_price_active:
            false,
          billing_source:
            'stripe',
          paid_through:
            null,
          next_charge_at:
            row.current_period_end ||
            null,
          migration_status:
            'active',
          stripe_customer_id:
            row.stripe_customer_id ||
            target.stripe_customer_id ||
            null,
          stripe_subscription_id:
            row.stripe_subscription_id,
          stripe_subscription_item_id:
            item.id,
          stripe_custom_price_id:
            null,
          stripe_checkout_session_id:
            null,
          owner_note:
            cleanNote(
              body.ownerNote
            ) || null,
          created_by:
            auth.user.id,
          updated_by:
            auth.user.id
        }
      );

      return json({
        ok: true,
        action:
          'restore_standard_price',
        standardPriceCents:
          standardCents,
        billedPriceCents:
          billedCents,
        effective:
          'next_billing_cycle'
      });
    }

    if (
      action ===
      'create_offline_migration'
    ) {
      const plan =
        cleanPlan(
          body.plan
        );

      if (!plan) {
        return json(
          {
            error:
              'Choose Gold, Premium, or Platinum.'
          },
          400
        );
      }

      const billingSource =
        cleanBillingSource(
          body.billingSource
        );

      if (
        !billingSource ||
        billingSource ===
          'stripe'
      ) {
        return json(
          {
            error:
              'Choose Zelle, cash, check, or other as the current payment source.'
          },
          400
        );
      }

      const nextCharge =
        new Date(
          body.nextChargeAt
        );

      if (
        Number.isNaN(
          nextCharge.getTime()
        )
      ) {
        return json(
          {
            error:
              'Choose a valid next Stripe charge date.'
          },
          400
        );
      }

      const nowMs =
        Date.now();

      if (
        nextCharge.getTime() <=
        nowMs + 5 * 60 * 1000
      ) {
        return json(
          {
            error:
              'The first Stripe charge must be scheduled in the future.'
          },
          400
        );
      }

      const maxFutureMs =
        nowMs +
        2 *
          365 *
          24 *
          60 *
          60 *
          1000;

      if (
        nextCharge.getTime() >
        maxFutureMs
      ) {
        return json(
          {
            error:
              'The first Stripe charge cannot be more than two years away.'
          },
          400
        );
      }

      const standardCents =
        standardPriceCents(
          location,
          plan
        );

      const requestedCustom =
        body.customPriceCents ===
          null ||
        body.customPriceCents ===
          undefined ||
        body.customPriceCents ===
          ''
          ? null
          : cents(
              body.customPriceCents
            );

      if (
        requestedCustom !==
          null &&
        requestedCustom < 100
      ) {
        return json(
          {
            error:
              'Custom monthly price must be at least $1.00.'
          },
          400
        );
      }

      const finalMonthlyCents =
        requestedCustom ??
        standardCents;

      const customActive =
        requestedCustom !== null &&
        requestedCustom !==
          standardCents;

      const basePriceId =
        standardPriceId(
          location,
          plan
        );

      if (!basePriceId) {
        return json(
          {
            error:
              'The standard Stripe price for this plan is not configured.'
          },
          400
        );
      }

      let checkoutPriceId =
        basePriceId;

      let customStripePriceId =
        null;

      if (customActive) {
        const customPrice =
          await createCustomRecurringPrice(
            {
              basePriceId,
              unitAmount:
                finalMonthlyCents,
              userId,
              locationSlug,
              plan
            }
          );

        checkoutPriceId =
          customPrice.id;

        customStripePriceId =
          customPrice.id;
      }

      const customerId =
        await ensureStripeCustomer(
          supabase,
          target
        );

      const metadata = {
        beseen_user_id:
          userId,
        plan,
        location_slug:
          locationSlug,
        location_slugs:
          locationSlug,
        location_plan_map:
          `${locationSlug}:${plan}`,
        discounted_location_slugs:
          '',
        discount_per_location_cents:
          '0',
        billing_source:
          billingSource,
        custom_price_cents:
          String(
            finalMonthlyCents
          ),
        offline_migration:
          'true'
      };

      const trialEnd =
        Math.floor(
          nextCharge.getTime() /
            1000
        );

      const origin =
        new URL(
          request.url
        ).origin;

      const session =
        await stripe.checkout
          .sessions.create({
            mode:
              'subscription',

            customer:
              customerId,

            client_reference_id:
              userId,

            line_items: [
              {
                price:
                  checkoutPriceId,
                quantity: 1
              }
            ],

            payment_method_collection:
              'always',

            success_url:
              `${origin}/account.html?billing=migration-success`,

            cancel_url:
              `${origin}/account.html?billing=migration-cancelled`,

            metadata,

            subscription_data: {
              trial_end:
                trialEnd,

              trial_settings: {
                end_behavior: {
                  missing_payment_method:
                    'cancel'
                }
              },

              metadata
            }
          });

      const paidThrough =
        body.paidThrough
          ? new Date(
              body.paidThrough
            )
          : nextCharge;

      const paidThroughIso =
        Number.isNaN(
          paidThrough.getTime()
        )
          ? nextCharge.toISOString()
          : paidThrough.toISOString();

      const override =
        await saveOverride(
          supabase,
          {
            user_id:
              userId,
            location_id:
              location.id,
            location_slug:
              locationSlug,
            plan,
            standard_price_cents:
              standardCents,
            custom_price_cents:
              customActive
                ? finalMonthlyCents
                : null,
            custom_price_active:
              customActive,
            billing_source:
              billingSource,
            paid_through:
              paidThroughIso,
            next_charge_at:
              nextCharge.toISOString(),
            migration_status:
              'pending_payment_method',
            stripe_customer_id:
              customerId,
            stripe_subscription_id:
              null,
            stripe_subscription_item_id:
              null,
            stripe_custom_price_id:
              customStripePriceId,
            stripe_checkout_session_id:
              session.id,
            owner_note:
              cleanNote(
                body.ownerNote
              ) || null,
            created_by:
              auth.user.id,
            updated_by:
              auth.user.id
          }
        );

      await stripe.checkout
        .sessions.update(
          session.id,
          {
            metadata: {
              ...metadata,
              billing_override_id:
                override.id
            }
          }
        );

      return json({
        ok: true,
        action:
          'create_offline_migration',
        url:
          session.url,
        nextChargeAt:
          nextCharge.toISOString(),
        monthlyPriceCents:
          finalMonthlyCents,
        overrideId:
          override.id
      });
    }

    return json(
      {
        error:
          'Unknown owner billing action.'
      },
      400
    );
  } catch (error) {
    console.error(
      'admin-accounts error',
      error
    );

    return json(
      {
        error:
          error?.message ||
          'Owner billing update failed.'
      },
      500
    );
  }
}
