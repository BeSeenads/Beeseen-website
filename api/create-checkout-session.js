import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const EXTRA_LOCATION_DISCOUNT_CENTS = 5000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

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

function isBillboardLocation(loc) {
  return `${loc?.slug || ''} ${loc?.name || ''}`
    .toLowerCase()
    .includes('billboard');
}

function isOnePriceLocation(loc) {
  if (isBillboardLocation(loc)) return true;
  const gold = Number(loc?.gold_price_cents) || 0;
  const premium = Number(loc?.premium_price_cents) || 0;
  const platinum = Number(loc?.platinum_price_cents) || 0;
  return gold > 0 && premium === 0 && platinum === 0;
}

function cleanSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function cleanText(value, max = 300) {
  return String(value || '')
    .trim()
    .slice(0, max);
}

const EXCLUSIVE_MONTHLY_CENTS = {
  gold: 30000,
  premium: 35000,
  platinum: 40000
};

function isMatchingMonthlyPrice(price, cents) {
  if (!price || price.deleted || price.active === false) {
    return false;
  }

  return (
    price.currency === 'usd' &&
    price.recurring?.interval === 'month' &&
    Number(price.unit_amount) === cents
  );
}

function productIdFromPrice(price) {
  if (!price?.product) return null;
  return typeof price.product === 'string'
    ? price.product
    : price.product.id || null;
}

async function retrievePrice(stripeClient, priceId) {
  if (!priceId) return null;

  try {
    return await stripeClient.prices.retrieve(priceId);
  } catch (error) {
    if (
      error?.code === 'resource_missing' ||
      error?.statusCode === 404
    ) {
      return null;
    }

    throw error;
  }
}

export async function exclusiveMonthlyPriceId(
  stripeClient,
  plan,
  locationPriceId
) {
  const cents = EXCLUSIVE_MONTHLY_CENTS[plan];

  if (!cents) return null;

  const envPriceId =
    {
      gold: process.env.STRIPE_PRICE_GOLD,
      premium: process.env.STRIPE_PRICE_PREMIUM,
      platinum: process.env.STRIPE_PRICE_PLATINUM
    }[plan] || null;

  let productId = null;

  for (const candidateId of [locationPriceId, envPriceId]) {
    const price = await retrievePrice(
      stripeClient,
      candidateId
    );

    if (!price) continue;

    if (!productId) {
      productId = productIdFromPrice(price);
    }

    if (isMatchingMonthlyPrice(price, cents)) {
      return {
        id: price.id,
        source: candidateId === locationPriceId ? 'location' : 'env'
      };
    }
  }

  const lookupKey = `beseen_exclusive_${plan}_${cents}`;
  const listed = await stripeClient.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1
  });
  const reused = (listed.data || []).find(price =>
    isMatchingMonthlyPrice(price, cents)
  );

  if (reused) {
    return { id: reused.id, source: 'lookup' };
  }

  if (!productId) {
    const product = await stripeClient.products.create({
      name: 'BeSeen — Exclusive Hookah Lounge',
      metadata: {
        beseen_location_slug: 'exclusive'
      }
    });
    productId = product.id;
  }

  const created = await stripeClient.prices.create(
    {
      product: productId,
      unit_amount: cents,
      currency: 'usd',
      recurring: { interval: 'month' },
      lookup_key: lookupKey,
      transfer_lookup_key: true,
      nickname: `Exclusive Hookah Lounge — ${plan[0].toUpperCase()}${plan.slice(1)}`,
      metadata: {
        beseen_location_slug: 'exclusive',
        beseen_plan: plan
      }
    },
    {
      idempotencyKey: `beseen-exclusive-${plan}-${cents}`
    }
  );

  if (!isMatchingMonthlyPrice(created, cents)) {
    throw new Error(
      'Exclusive Stripe price was not created at the package amount.'
    );
  }

  return { id: created.id, source: 'created' };
}

function cleanDestinationUrl(value) {
  let raw = String(value || '')
    .trim()
    .slice(0, 1000);

  if (!raw) return '';

  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  try {
    const parsed = new URL(raw);

    if (
      !['http:', 'https:'].includes(
        parsed.protocol
      )
    ) {
      return '';
    }

    return parsed.toString();
  } catch {
    return '';
  }
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

    const supabase =
      getServerSupabase();

    if (!supabase) {
      return json(
        {
          error:
            'Supabase server access is not configured yet.'
        },
        503
      );
    }

    const authHeader =
      request.headers.get(
        'authorization'
      ) || '';

    const token =
      authHeader
        .replace(/^Bearer\s+/i, '')
        .trim();

    if (!token) {
      return json(
        {
          error:
            'Sign in before choosing a subscription.'
        },
        401
      );
    }

    const {
      data: userData,
      error: userError
    } =
      await supabase.auth.getUser(
        token
      );

    const user = userData?.user;

    if (userError || !user) {
      return json(
        {
          error:
            'Your sign-in session is invalid. Please sign in again.'
        },
        401
      );
    }

    const body =
      await request
        .json()
        .catch(() => ({}));

    const plan =
      String(body.plan || '')
        .toLowerCase();

    if (
      ![
        'gold',
        'premium',
        'platinum'
      ].includes(plan)
    ) {
      return json(
        {
          error:
            'Choose a valid subscription plan.'
        },
        400
      );
    }

    const intake =
      body.intake &&
      typeof body.intake ===
        'object'
        ? body.intake
        : {};

    const businessName =
      cleanText(
        intake.businessName,
        120
      );

    const businessType =
      cleanText(
        intake.businessType,
        80
      );

    const websiteOrSocial =
      cleanText(
        intake.websiteOrSocial,
        300
      );

    const phone =
      cleanText(
        intake.phone,
        40
      );

    const campaignDetails =
      cleanText(
        intake.campaignDetails,
        1500
      );

    const qrDestinationUrl =
      cleanDestinationUrl(
        intake.qrDestinationUrl
      );

    const creativeChoice =
      cleanText(
        intake.creativeChoice,
        30
      );

    const adAssetPath =
      cleanText(
        intake.adAssetPath,
        500
      ) || null;

    if (
      businessName.length < 2
    ) {
      return json(
        {
          error:
            'Enter your business name before checkout.'
        },
        400
      );
    }

    if (
      businessType.length < 2
    ) {
      return json(
        {
          error:
            'Tell us what type of business you have.'
        },
        400
      );
    }

    if (
      campaignDetails.length < 5
    ) {
      return json(
        {
          error:
            'Tell us what you want to promote.'
        },
        400
      );
    }

    if (!qrDestinationUrl) {
      return json(
        {
          error:
            'Enter a valid website or page for your QR code to open.'
        },
        400
      );
    }

    if (
      ![
        'own_ad',
        'beseen_create'
      ].includes(creativeChoice)
    ) {
      return json(
        {
          error:
            'Choose how you want your ad creative handled.'
        },
        400
      );
    }

    if (
      creativeChoice ===
        'own_ad' &&
      !adAssetPath
    ) {
      return json(
        {
          error:
            'Upload your finished ad before checkout.'
        },
        400
      );
    }

    if (
      creativeChoice ===
        'own_ad' &&
      !adAssetPath.startsWith(
        `${user.id}/ads/`
      )
    ) {
      return json(
        {
          error:
            'That ad upload does not belong to your account.'
        },
        400
      );
    }

    const requestedSlugs =
      Array.isArray(
        body.locationSlugs
      )
        ? body.locationSlugs
            .map(cleanSlug)
            .filter(Boolean)
        : [
            cleanSlug(
              body.locationSlug ||
                'exclusive'
            )
          ].filter(Boolean);

    const locationSlugs =
      [...new Set(requestedSlugs)];

    if (!locationSlugs.length) {
      return json(
        {
          error:
            'Choose at least one location.'
        },
        400
      );
    }

    if (
      locationSlugs.length > 20
    ) {
      return json(
        {
          error:
            'Choose 20 locations or fewer per checkout.'
        },
        400
      );
    }

    const priceColumn =
      `stripe_price_${plan}`;

    const {
      data: locations,
      error: locationsError
    } =
      await supabase
        .from('locations')
        .select(
          'id,slug,name,status,visibility,gold_price_cents,premium_price_cents,platinum_price_cents,stripe_price_gold,stripe_price_premium,stripe_price_platinum'
        )
        .in(
          'slug',
          locationSlugs
        );

    if (locationsError) {
      return json(
        {
          error:
            'We could not load those locations.'
        },
        500
      );
    }

    const locationMap =
      new Map(
        (locations || []).map(
          loc => [
            loc.slug,
            loc
          ]
        )
      );

    const orderedLocations =
      locationSlugs
        .map(
          slug =>
            locationMap.get(slug)
        )
        .filter(Boolean);

    if (
      orderedLocations.length !==
      locationSlugs.length
    ) {
      return json(
        {
          error:
            'One or more selected locations could not be found.'
        },
        400
      );
    }

    if (
      orderedLocations.some(
        loc =>
          loc.status !== 'live' ||
          loc.visibility !==
            'public'
      )
    ) {
      return json(
        {
          error:
            'One or more selected locations are not currently available for public checkout.'
        },
        400
      );
    }

    const {
      data: profile,
      error: profileError
    } =
      await supabase
        .from('profiles')
        .select(
          'stripe_customer_id,subscription,subscription_status'
        )
        .eq('id', user.id)
        .single();

    if (profileError) {
      return json(
        {
          error:
            'We could not load your BeSeen account.'
        },
        500
      );
    }

    const {
      data: existingRows
    } =
      await supabase
        .from(
          'subscription_locations'
        )
        .select(
          'location_slug,status'
        )
        .eq('user_id', user.id)
        .in('status', [
          'active',
          'trialing',
          'past_due'
        ]);

    const existingActiveSlugs =
      new Set(
        (existingRows || []).map(
          row =>
            row.location_slug
        )
      );

    const duplicate =
      orderedLocations.find(
        loc =>
          existingActiveSlugs.has(
            loc.slug
          )
      );

    if (duplicate) {
      return json(
        {
          error:
            `${duplicate.name} is already on your active BeSeen subscription.`
        },
        400
      );
    }

    const {
      data: intakeRow,
      error: intakeError
    } =
      await supabase
        .from(
          'subscription_intakes'
        )
        .insert({
          user_id: user.id,
          business_name:
            businessName,
          business_type:
            businessType,
          website_or_social:
            websiteOrSocial ||
            null,
          contact_phone:
            phone || null,
          campaign_details:
            campaignDetails,
          qr_destination_url:
            qrDestinationUrl,
          creative_choice:
            creativeChoice,
          ad_asset_path:
            adAssetPath,
          plan,
          location_slugs:
            orderedLocations.map(
              loc => loc.slug
            ),
          status:
            'checkout_started'
        })
        .select('id')
        .single();

    if (
      intakeError ||
      !intakeRow?.id
    ) {
      console.error(
        'subscription intake insert failed',
        intakeError
      );

      return json(
        {
          error:
            'We could not save your campaign information. Please try again.'
        },
        500
      );
    }

    const lineItems = [];

    for (
      const loc of
      orderedLocations
    ) {
      if (isBillboardLocation(loc)) {
        lineItems.push({
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: 110000,
            recurring: { interval: 'month' },
            product_data: {
              name: `BeSeen — ${loc.name}`
            }
          }
        });
        continue;
      }

      if (isOnePriceLocation(loc)) {
        const onePriceId = loc.stripe_price_gold || null;
        if (!onePriceId) {
          return json(
            {
              error:
                `Stripe pricing for ${loc.name} is not configured yet.`
            },
            400
          );
        }
        lineItems.push({
          price: onePriceId,
          quantity: 1
        });
        continue;
      }

      let priceId =
        loc[priceColumn] ||
        null;

      if (loc.slug === 'exclusive') {
        const cents =
          EXCLUSIVE_MONTHLY_CENTS[plan];
        let resolvedId = null;

        try {
          resolvedId = (
            await exclusiveMonthlyPriceId(
              stripe,
              plan,
              priceId
            )
          )?.id || null;
        } catch (error) {
          console.error(
            'exclusive monthly price resolve failed',
            error
          );
        }

        if (
          resolvedId &&
          resolvedId !== priceId
        ) {
          const {
            error: priceSaveError
          } = await supabase
            .from('locations')
            .update({
              [priceColumn]: resolvedId,
              updated_at:
                new Date().toISOString()
            })
            .eq('id', loc.id)
            .eq('slug', 'exclusive');

          if (priceSaveError) {
            console.error(
              'exclusive price id save failed',
              priceSaveError
            );
          }
        }

        if (resolvedId) {
          lineItems.push({
            price: resolvedId,
            quantity: 1
          });
        } else {
          lineItems.push({
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: cents,
              recurring: {
                interval: 'month'
              },
              product_data: {
                name: `BeSeen — ${loc.name}`
              }
            }
          });
        }

        continue;
      }

      if (!priceId) {
        return json(
          {
            error:
              `Stripe pricing for ${loc.name} is not configured yet.`
          },
          400
        );
      }

      lineItems.push({
        price: priceId,
        quantity: 1
      });
    }

    const hasLegacyActiveSubscription =
      existingActiveSlugs.size ===
        0 &&
      profile?.subscription &&
      profile.subscription !==
        'none' &&
      [
        'active',
        'trialing',
        'past_due'
      ].includes(
        String(
          profile.subscription_status ||
            ''
        ).toLowerCase()
      );

    const existingLocationCount =
      existingActiveSlugs.size ||
      (
        hasLegacyActiveSubscription
          ? 1
          : 0
      );

    const discountedLocations =
      orderedLocations.filter(
        (loc, index) =>
          !isOnePriceLocation(loc) &&
          (
            existingLocationCount >
              0 ||
            index > 0
          )
      );

    const totalDiscountCents =
      discountedLocations.length *
      EXTRA_LOCATION_DISCOUNT_CENTS;

    let customerId =
      profile?.stripe_customer_id ||
      null;

    if (customerId) {
      try {
        const existingCustomer = await stripe.customers.retrieve(customerId);
        if (existingCustomer?.deleted) customerId = null;
      } catch (error) {
        if (error?.code === 'resource_missing') customerId = null;
        else throw error;
      }
    }

    if (!customerId) {
      const customer =
        await stripe.customers.create(
          {
            email:
              user.email ||
              undefined,
            name:
              user.user_metadata
                ?.full_name ||
              undefined,
            metadata: {
              beseen_user_id:
                user.id
            }
          }
        );

      customerId =
        customer.id;

      await supabase
        .from('profiles')
        .update({
          stripe_customer_id:
            customerId
        })
        .eq('id', user.id);
    }

    const discounts = [];

    if (
      totalDiscountCents > 0
    ) {
      const coupon =
        await stripe.coupons.create(
          {
            amount_off:
              totalDiscountCents,
            currency: 'usd',
            duration: 'forever',
            name:
              `BeSeen multi-location savings (${discountedLocations.length} × $50)`
          }
        );

      discounts.push({
        coupon: coupon.id
      });
    }

    const origin =
      new URL(
        request.url
      ).origin;

    const locationPlanMap =
      orderedLocations
        .map(
          loc =>
            `${loc.slug}:${plan}`
        )
        .join(',');

    const metadata = {
      beseen_user_id:
        user.id,

      plan,

      location_slug:
        orderedLocations[0]
          ?.slug || '',

      location_slugs:
        orderedLocations
          .map(
            loc => loc.slug
          )
          .join(','),

      location_plan_map:
        locationPlanMap,

      discounted_location_slugs:
        discountedLocations
          .map(
            loc => loc.slug
          )
          .join(','),

      discount_per_location_cents:
        String(
          EXTRA_LOCATION_DISCOUNT_CENTS
        ),

      intake_id:
        intakeRow.id
    };

    const session =
      await stripe.checkout
        .sessions.create({
          mode:
            'subscription',

          customer:
            customerId,

          client_reference_id:
            user.id,

          line_items:
            lineItems,

          ...(discounts.length
            ? {
                discounts
              }
            : {}),

          success_url:
            `${origin}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,

          cancel_url:
            `${origin}/?checkout=cancelled`,

          ...(discounts.length ===
          0
            ? {
                allow_promotion_codes:
                  true
              }
            : {}),

          metadata,

          subscription_data: {
            metadata
          }
        });

    await supabase
      .from(
        'subscription_intakes'
      )
      .update({
        stripe_checkout_session_id:
          session.id,
        updated_at:
          new Date().toISOString()
      })
      .eq(
        'id',
        intakeRow.id
      );

    return json({
      url: session.url,
      locationCount:
        orderedLocations.length,
      discountedLocationCount:
        discountedLocations.length,
      monthlyDiscountCents:
        totalDiscountCents
    });
  } catch (error) {
    console.error(
      'create-checkout-session error',
      error
    );

    return json(
      {
        error:
          'We could not start checkout. Please try again.'
      },
      500
    );
  }
}
