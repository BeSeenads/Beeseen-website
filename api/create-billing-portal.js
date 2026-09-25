import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const PLAN_RANK = { gold: 1, premium: 2, platinum: 3 };

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

async function requireUser(request, supabase) {
  const token = (request.headers.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim();

  if (!token) {
    return {
      error: json({ error: 'Sign in first.' }, 401)
    };
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return {
      error: json(
        { error: 'Your sign-in session is invalid.' },
        401
      )
    };
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id,email,full_name,role,stripe_customer_id')
    .eq('id', data.user.id)
    .single();

  if (profileError || !profile) {
    return {
      error: json(
        { error: 'BeSeen profile not found.' },
        404
      )
    };
  }

  return {
    user: data.user,
    profile
  };
}

function validUrl(value) {
  let raw = String(value || '')
    .trim()
    .slice(0, 1200);

  if (!raw) return '';

  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  try {
    const u = new URL(raw);

    return ['http:', 'https:'].includes(u.protocol)
      ? u.toString()
      : '';
  } catch {
    return '';
  }
}

function parsePlanMap(value, slugs = [], fallback = 'gold') {
  const map = new Map();

  String(value || '')
    .split(',')
    .forEach(part => {
      const [slug, plan] = part
        .split(':')
        .map(v => String(v || '').trim().toLowerCase());

      if (slug && PLAN_RANK[plan]) {
        map.set(slug, plan);
      }
    });

  slugs.forEach(slug => {
    if (!map.has(slug)) {
      map.set(slug, fallback);
    }
  });

  return map;
}

function encodePlanMap(map) {
  return [...map.entries()]
    .map(([slug, plan]) => `${slug}:${plan}`)
    .join(',');
}

async function logEvent(
  supabase,
  userId,
  customerId,
  subscriptionId,
  eventType,
  details = {}
) {
  const { error } = await supabase
    .from('billing_events')
    .insert({
      user_id: userId || null,
      stripe_customer_id: customerId || null,
      stripe_subscription_id: subscriptionId || null,
      event_type: eventType,
      details
    });

  if (error) {
    console.error('billing event log failed', error);
  }
}

async function ownedLocation(
  supabase,
  userId,
  id
) {
  const { data, error } = await supabase
    .from('subscription_locations')
    .select(
      'id,user_id,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,stripe_price_id,location_id,location_slug,plan,status,list_price_cents,billed_price_cents,discount_cents,current_period_end,cancel_at_period_end,created_at'
    )
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

async function priceForLocation(
  supabase,
  row,
  plan
) {
  const { data: loc, error } = await supabase
    .from('locations')
    .select(
      'id,slug,name,gold_price_cents,premium_price_cents,platinum_price_cents,stripe_price_gold,stripe_price_premium,stripe_price_platinum'
    )
    .eq('id', row.location_id)
    .single();

  if (error || !loc) {
    throw new Error(
      'Advertising location was not found.'
    );
  }

  let priceId =
    loc[`stripe_price_${plan}`] || null;

  if (loc.slug === 'exclusive') {
    priceId =
      {
        gold: process.env.STRIPE_PRICE_GOLD,
        premium: process.env.STRIPE_PRICE_PREMIUM,
        platinum: process.env.STRIPE_PRICE_PLATINUM
      }[plan] || priceId;
  }

  if (!priceId) {
    throw new Error(
      `Stripe ${plan} pricing is not configured for ${loc.name}.`
    );
  }

  return {
    loc,
    priceId,
    listCents: Number(
      loc[`${plan}_price_cents`] || 0
    )
  };
}

async function resolveItem(
  supabase,
  row
) {
  const items =
    await stripe.subscriptionItems.list({
      subscription:
        row.stripe_subscription_id,
      limit: 100
    });

  if (row.stripe_subscription_item_id) {
    const found = items.data.find(
      i =>
        i.id ===
        row.stripe_subscription_item_id
    );

    if (found) {
      return found;
    }
  }

  if (row.stripe_price_id) {
    const found = items.data.find(
      i =>
        i.price?.id ===
        row.stripe_price_id
    );

    if (found) {
      return found;
    }
  }

  try {
    const { priceId } =
      await priceForLocation(
        supabase,
        row,
        row.plan
      );

    const matches = items.data.filter(
      i => i.price?.id === priceId
    );

    if (matches.length === 1) {
      return matches[0];
    }
  } catch {}

  if (items.data.length === 1) {
    return items.data[0];
  }

  return null;
}

async function portalSession(
  profile,
  request
) {
  if (!profile.stripe_customer_id) {
    return json(
      {
        error:
          'No Stripe billing account exists for this profile yet.'
      },
      400
    );
  }

  const origin =
    new URL(request.url).origin;

  const portal =
    await stripe.billingPortal.sessions.create(
      {
        customer:
          profile.stripe_customer_id,
        return_url:
          `${origin}/account.html`
      }
    );

  return json({
    url: portal.url
  });
}

export async function POST(request) {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return json(
        {
          error:
            'Stripe is not configured yet.'
        },
        503
      );
    }

    const supabase = db();

    if (!supabase) {
      return json(
        {
          error:
            'Supabase server access is not configured yet.'
        },
        503
      );
    }

    const auth =
      await requireUser(
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
      String(body.action || 'portal')
        .toLowerCase();

    const { user, profile } = auth;

    if (action === 'portal') {
      return portalSession(
        profile,
        request
      );
    }

    if (action === 'upgrade') {
      const row =
        await ownedLocation(
          supabase,
          user.id,
          String(
            body.customerLocationId ||
              ''
          )
        );

      if (!row) {
        return json(
          {
            error:
              'That advertising location was not found.'
          },
          404
        );
      }

      if (row.cancel_at_period_end) {
        return json(
          {
            error:
              'This location is already scheduled to end.'
          },
          400
        );
      }

      const newPlan =
        String(body.newPlan || '')
          .toLowerCase();

      if (
        !PLAN_RANK[newPlan] ||
        PLAN_RANK[newPlan] <=
          PLAN_RANK[row.plan]
      ) {
        return json(
          {
            error:
              'Only upgrades are allowed. Downgrades are disabled.'
          },
          400
        );
      }

      const item =
        await resolveItem(
          supabase,
          row
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

      const {
        loc,
        priceId,
        listCents
      } =
        await priceForLocation(
          supabase,
          row,
          newPlan
        );

      const subscription =
        await stripe.subscriptions.retrieve(
          row.stripe_subscription_id
        );

      const slugs =
        String(
          subscription.metadata
            ?.location_slugs ||
            row.location_slug
        )
          .split(',')
          .map(v =>
            v.trim().toLowerCase()
          )
          .filter(Boolean);

      const planMap =
        parsePlanMap(
          subscription.metadata
            ?.location_plan_map,
          slugs,
          subscription.metadata?.plan ||
            row.plan
        );

      planMap.set(
        row.location_slug,
        newPlan
      );

      await stripe.subscriptions.update(
        row.stripe_subscription_id,
        {
          items: [
            {
              id: item.id,
              price: priceId
            }
          ],
          proration_behavior:
            'create_prorations',
          metadata: {
            ...subscription.metadata,
            location_plan_map:
              encodePlanMap(planMap)
          }
        }
      );

      await supabase
        .from(
          'subscription_locations'
        )
        .update({
          plan: newPlan,
          stripe_subscription_item_id:
            item.id,
          stripe_price_id: priceId,
          list_price_cents:
            listCents,
          billed_price_cents:
            Math.max(
              0,
              listCents -
                Number(
                  row.discount_cents ||
                    0
                )
            ),
          updated_at:
            new Date().toISOString()
        })
        .eq('id', row.id)
        .eq('user_id', user.id);

      await logEvent(
        supabase,
        user.id,
        profile.stripe_customer_id,
        row.stripe_subscription_id,
        'plan_upgraded',
        {
          location_slug:
            row.location_slug,
          location_name: loc.name,
          from_plan: row.plan,
          to_plan: newPlan
        }
      );

      return json({
        ok: true,
        plan: newPlan
      });
    }

    if (action === 'cancel') {
      const row =
        await ownedLocation(
          supabase,
          user.id,
          String(
            body.customerLocationId ||
              ''
          )
        );

      if (!row) {
        return json(
          {
            error:
              'That advertising location was not found.'
          },
          404
        );
      }

      if (row.cancel_at_period_end) {
        return json({
          ok: true,
          alreadyScheduled: true
        });
      }

      const {
        data: siblingRows,
        error: siblingError
      } =
        await supabase
          .from(
            'subscription_locations'
          )
          .select(
            'id,location_id,location_slug,status,discount_cents,cancel_at_period_end,current_period_end'
          )
          .eq('user_id', user.id)
          .eq(
            'stripe_subscription_id',
            row.stripe_subscription_id
          )
          .not(
            'status',
            'in',
            '("canceled","inactive")'
          );

      if (siblingError) {
        throw siblingError;
      }

      const subscription =
        await stripe.subscriptions.retrieve(
          row.stripe_subscription_id
        );

      const item =
        await resolveItem(
          supabase,
          row
        );

      const endUnix =
        Number(
          item?.current_period_end ||
            subscription.current_period_end ||
            0
        );

      const endIso =
        endUnix
          ? new Date(
              endUnix * 1000
            ).toISOString()
          : row.current_period_end ||
            null;

      const activeSiblings =
        (siblingRows || []).filter(
          r =>
            !r.cancel_at_period_end
        );

      if (
        activeSiblings.length <= 1
      ) {
        await stripe.subscriptions.update(
          row.stripe_subscription_id,
          {
            cancel_at_period_end: true
          }
        );
      } else {
        if (!item) {
          return json(
            {
              error:
                'We could not identify this location inside the Stripe subscription.'
            },
            409
          );
        }

        const remaining =
          activeSiblings.filter(
            r => r.id !== row.id
          );

        const remainingDiscount =
          remaining.reduce(
            (sum, r) =>
              sum +
              Number(
                r.discount_cents ||
                  0
              ),
            0
          );

        let discounts = '';

        if (remainingDiscount > 0) {
          const coupon =
            await stripe.coupons.create(
              {
                amount_off:
                  remainingDiscount,
                currency: 'usd',
                duration: 'forever',
                name:
                  'BeSeen remaining location savings'
              }
            );

          discounts = [
            {
              coupon: coupon.id
            }
          ];
        }

        const slugs =
          String(
            subscription.metadata
              ?.location_slugs || ''
          )
            .split(',')
            .map(v =>
              v.trim().toLowerCase()
            )
            .filter(Boolean)
            .filter(
              v =>
                v !==
                row.location_slug
            );

        const planMap =
          parsePlanMap(
            subscription.metadata
              ?.location_plan_map,
            slugs,
            subscription.metadata
              ?.plan || row.plan
          );

        planMap.delete(
          row.location_slug
        );

        await stripe.subscriptions.update(
          row.stripe_subscription_id,
          {
            items: [
              {
                id: item.id,
                deleted: true
              }
            ],
            discounts,
            proration_behavior:
              'none',
            metadata: {
              ...subscription.metadata,
              location_slugs:
                slugs.join(','),
              location_slug:
                slugs[0] || '',
              location_plan_map:
                encodePlanMap(
                  planMap
                )
            }
          }
        );
      }

      await supabase
        .from(
          'subscription_locations'
        )
        .update({
          cancel_at_period_end:
            true,
          cancellation_requested_at:
            new Date().toISOString(),
          current_period_end:
            endIso,
          updated_at:
            new Date().toISOString()
        })
        .eq('id', row.id)
        .eq('user_id', user.id);

      await logEvent(
        supabase,
        user.id,
        profile.stripe_customer_id,
        row.stripe_subscription_id,
        'cancellation_scheduled',
        {
          location_slug:
            row.location_slug,
          ends_at: endIso,
          refund: false
        }
      );

      return json({
        ok: true,
        endsAt: endIso
      });
    }

    if (action === 'update_qr') {
      const campaignId =
        String(
          body.campaignId || ''
        );

      const destination =
        validUrl(
          body.destinationUrl
        );

      if (!destination) {
        return json(
          {
            error:
              'Enter a valid QR destination URL.'
          },
          400
        );
      }

      const {
        data: campaign
      } =
        await supabase
          .from('campaigns')
          .select(
            'id,advertiser_id'
          )
          .eq('id', campaignId)
          .single();

      if (
        !campaign ||
        campaign.advertiser_id !==
          user.id
      ) {
        return json(
          {
            error:
              'Campaign not found.'
          },
          404
        );
      }

      const { error } =
        await supabase
          .from('campaigns')
          .update({
            landing_url:
              destination,
            updated_at:
              new Date().toISOString()
          })
          .eq('id', campaignId);

      if (error) {
        throw error;
      }

      return json({
        ok: true,
        destinationUrl:
          destination
      });
    }

    if (action === 'review_ad') {
      const campaignId =
        String(
          body.campaignId || ''
        );

      const decision =
        String(
          body.decision || ''
        ).toLowerCase();

      if (
        ![
          'approved',
          'changes_requested'
        ].includes(decision)
      ) {
        return json(
          {
            error:
              'Choose a valid review decision.'
          },
          400
        );
      }

      const {
        data: campaign
      } =
        await supabase
          .from('campaigns')
          .select(
            'id,advertiser_id,ad_preview_url'
          )
          .eq('id', campaignId)
          .single();

      if (
        !campaign ||
        campaign.advertiser_id !==
          user.id
      ) {
        return json(
          {
            error:
              'Campaign not found.'
          },
          404
        );
      }

      if (
        !campaign.ad_preview_url
      ) {
        return json(
          {
            error:
              'There is no ad preview to review yet.'
          },
          400
        );
      }

      const message =
        String(
          body.message || ''
        )
          .trim()
          .slice(0, 1200);

      const { error } =
        await supabase
          .from('campaigns')
          .update({
            approval_status:
              decision,
            customer_feedback:
              decision ===
              'changes_requested'
                ? message
                : null,
            customer_reviewed_at:
              new Date().toISOString(),
            updated_at:
              new Date().toISOString()
          })
          .eq('id', campaignId);

      if (error) {
        throw error;
      }

      return json({
        ok: true,
        approvalStatus:
          decision
      });
    }

    if (
      action ===
        'campaign_status' ||
      action ===
        'set_preview'
    ) {
      if (
        !['owner', 'admin'].includes(
          profile.role
        )
      ) {
        return json(
          {
            error:
              'Owner/Admin access required.'
          },
          403
        );
      }

      const campaignId =
        String(
          body.campaignId || ''
        );

      const {
        data: campaign
      } =
        await supabase
          .from('campaigns')
          .select('id')
          .eq('id', campaignId)
          .single();

      if (!campaign) {
        return json(
          {
            error:
              'Campaign not found.'
          },
          404
        );
      }

      if (
        action ===
        'campaign_status'
      ) {
        let status =
          String(
            body.status || ''
          ).toLowerCase();

        if (
          status ===
          'preparing'
        ) {
          status = 'draft';
        }

        if (
          ![
            'draft',
            'live',
            'paused',
            'ended'
          ].includes(status)
        ) {
          return json(
            {
              error:
                'Choose a valid campaign status.'
            },
            400
          );
        }

        const { error } =
          await supabase
            .from('campaigns')
            .update({
              status,
              updated_at:
                new Date().toISOString()
            })
            .eq(
              'id',
              campaignId
            );

        if (error) {
          throw error;
        }

        return json({
          ok: true,
          status
        });
      }

      const preview =
        validUrl(
          body.previewUrl
        );

      if (
        String(
          body.previewUrl || ''
        ).trim() &&
        !preview
      ) {
        return json(
          {
            error:
              'Enter a valid preview URL.'
          },
          400
        );
      }

      const { error } =
        await supabase
          .from('campaigns')
          .update({
            ad_preview_url:
              preview || null,
            approval_status:
              'pending',
            customer_feedback:
              null,
            creative_updated_at:
              new Date().toISOString(),
            updated_at:
              new Date().toISOString()
          })
          .eq('id', campaignId);

      if (error) {
        throw error;
      }

      return json({
        ok: true,
        previewUrl:
          preview || null
      });
    }

    return json(
      {
        error:
          'Unknown account action.'
      },
      400
    );
  } catch (error) {
    console.error(
      'create-billing-portal/account action error',
      error
    );

    return json(
      {
        error:
          error?.message ||
          'We could not complete that account action.'
      },
      500
    );
  }
}
