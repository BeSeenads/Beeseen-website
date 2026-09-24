# BeSeen — Vercel + Supabase + Stripe

This is the current BeSeen production scaffold. The public website, real Supabase authentication, referral capture, and Stripe subscription checkout wiring are included.

## Owner
The current owner email is:

`akilhsen4@gmail.com`

The supplied Supabase SQL assigns that verified account the `owner` role when the account is created.

## 1. Supabase setup
1. Create a Supabase project.
2. Open **SQL Editor** and run `supabase/schema.sql` once.
3. In **Authentication > URL Configuration**, set your Vercel production URL as the Site URL and add it to Redirect URLs.
4. Copy your project URL, publishable key, and secret key.

## 2. Stripe setup
Create three recurring monthly Prices in Stripe:
- Gold — $200/month
- Premium — $250/month
- Platinum — $300/month

Copy each Stripe Price ID (`price_...`).

In Stripe, create a webhook endpoint pointing to:

`https://YOUR-DOMAIN.com/api/stripe-webhook`

Subscribe it to these events:
- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Copy the webhook signing secret (`whsec_...`).

## 3. Vercel environment variables
Add these in **Vercel > Project > Settings > Environment Variables**:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_GOLD`
- `STRIPE_PRICE_PREMIUM`
- `STRIPE_PRICE_PLATINUM`

Never put `SUPABASE_SECRET_KEY`, `STRIPE_SECRET_KEY`, or `STRIPE_WEBHOOK_SECRET` in browser JavaScript or GitHub.

## 4. What happens after setup
- Customers create/sign into BeSeen accounts through Supabase.
- A signed-in customer clicks Gold, Premium, or Platinum.
- BeSeen calls `/api/create-checkout-session` and redirects them to Stripe Checkout.
- Stripe collects the payment and creates the recurring subscription.
- Stripe calls `/api/stripe-webhook`.
- The webhook updates that customer's `profiles.subscription` and `subscription_status` in Supabase.
- The next time the profile loads, the website automatically unlocks the correct advertiser experience.

## 5. Billing management
`/api/create-billing-portal` is included so a signed-in customer can later be given a **Manage Billing** button using Stripe Customer Portal.

## Important
- The Stripe/Supabase integration is wired, but it will not become live until the environment variables and Stripe Price IDs are added in Vercel.
- Sample owner/advertiser analytics numbers have been removed. Metrics start empty/zero and populate only from real Supabase tracking events and active Stripe subscriptions.
- Device/host/ad-upload workflows still show an honest unconnected state until those pipelines are added.
- Keep Supabase Row Level Security enabled. Server-only operations use the secret key inside Vercel Functions.
- Referral codes entered at signup continue to be saved to `profiles.referral_code`.

## Referral center
- The signup form accepts an optional referral code and `?ref=CODE` automatically pre-fills it.
- Every profile gets a unique `my_referral_code` in Supabase.
- Signed-in users see a **Referrals** button in their account bar with their code, share link, referral count, and active-subscriber count.
- Run the latest `supabase/schema.sql` to add/refill the referral columns and `get_my_referral_stats()` RPC.
- Referral rewards are intentionally not hard-coded yet; decide the reward rules first, then they can be added to Stripe/Supabase logic.

## Owner account + account roles
- `akilhsen4@gmail.com` is the protected primary Owner account.
- Rerunning `supabase/schema.sql` promotes that profile to `owner` if the account already exists.
- The Owner Control Center now has **Accounts & Roles**.
- `/api/admin-accounts` verifies the signed-in Supabase session on the server before listing accounts or changing a role.
- The primary Owner cannot be demoted from the Control Center.
- Subscription tier/status are read-only in the role manager because Stripe is the billing source of truth.


## Multi-location savings
BeSeen now supports multi-location subscriptions directly from the location pricing flow.
- The first location uses the normal monthly package price.
- Every additional live public location receives **$50 off per month**.
- Example totals when locations use the standard package prices:
  - Gold: 1 location $200/mo; 2 locations $350/mo; 3 locations $500/mo.
  - Premium: 1 location $250/mo; 2 locations $450/mo; 3 locations $650/mo.
  - Platinum: 1 location $300/mo; 2 locations $550/mo; 3 locations $800/mo.
- The website's multi-location builder loads live locations from Supabase automatically, so new live locations appear without editing `index.html`.
- Stripe Checkout receives one recurring line item per selected location and a permanent $50/month discount for each additional location.
- `public.subscription_locations` records the real location, plan, list price, billed price, discount, Stripe subscription, and status for each purchased location.
- Existing active BeSeen locations count toward the discount, so an advertiser adding another location later receives the $50/month additional-location rate automatically.

After deploying this version, rerun `supabase/schema.sql` once so the `subscription_locations` table and RLS policies are created.

## No-code Location Manager
- The Owner/Admin Control Center now has a **Location Manager**.
- New locations are stored in Supabase `public.locations`; no `index.html` edit is needed when BeSeen expands.
- A location can be `Future`, `Live`, or `Paused`, with visibility `Owner only`, `Platinum`, or `Public website`.
- Only `Live + Public website` locations are returned by `/api/locations` and automatically added to the public Locations menu.
- When `STRIPE_SECRET_KEY` is configured, saving a new location automatically creates a Stripe Product and monthly Gold/Premium/Platinum Prices. Changing a monthly price creates a replacement Stripe Price and archives the old one.
- Existing Exclusive checkout can still use `STRIPE_PRICE_GOLD`, `STRIPE_PRICE_PREMIUM`, and `STRIPE_PRICE_PLATINUM` as its fallback until Exclusive receives location-specific Stripe Price IDs.

## Future teasers and live locations
The Owner Location Manager now has a single **Publish as** control:
- **Future teaser — Platinum / FOMO section** stores the location as `status=future` + `visibility=platinum` and serves it through `/api/private-locations` only to active Platinum subscribers or BeSeen staff.
- **Live public location — Locations menu** stores it as `status=live` + `visibility=public`; `/api/locations` then exposes it to the public Locations dropdown and checkout can use its Stripe prices.
- **Owner-only draft** and **Paused / hidden** keep a location off customer-facing pages.

This lets the Owner announce a location privately first, then publish it live later without editing website code.


## Included future BeSeen placements
Running the latest `supabase/schema.sql` seeds the private Platinum/FOMO list with:
- Magical Touch Car Wash — Inkster
- Magical Touch Car Wash — Greenfield
- Magical Touch Car Wash — Allen Park
- Magical Touch Car Wash — Redford
- EV Station
- Digital Billboard — Greenfield
- Monday Coffee Club
- Gallery

These are stored as `future + platinum`, so the names are not returned by the public locations API. Owner/Admin can edit them in Location Manager and later switch any one to Live Public.

## Real analytics foundation
The schema now includes `campaigns` and `tracking_events`.
- `/api/qr?c=TRACKING_CODE` records a real QR scan and redirects to that campaign's configured landing URL.
- `/api/track-event` records supported first-party campaign actions such as landing visits, phone clicks, forms, directions, and listing views.
- `/api/analytics?scope=user` returns real metrics for the signed-in advertiser's campaigns.
- `/api/analytics?scope=admin` returns real staff totals and Stripe monthly recurring revenue when Stripe is connected.
- No sample analytics rows are inserted into Supabase.

A campaign still needs a real `campaigns` record/tracking code before events can be attributed to it.

## Location photo uploads
Owner/Admin can upload a location photo directly from Location Manager.
The image is stored in the public `location-images` Supabase Storage bucket through the authenticated `/api/upload-location-image` server route.


## Vercel Hobby compatibility
This build uses exactly 12 serverless API functions so it fits the Vercel Hobby plan limit. Advertiser analytics and owner/admin metrics are combined in `/api/analytics` to avoid exceeding that limit.


## Multi-location add button
Subscription sections show a small **+ Add Location** button. Clicking it opens the full multi-location savings builder, where every additional live location is $50 off per month.

## Remember me
The sign-in and create-account screens include an optional **Remember me** control. When enabled, Supabase session data is persisted on that device so the user stays signed in; BeSeen does not store the user's plaintext password. When disabled, the auth session uses browser session storage.

## Subscription business + ad intake
This version adds a campaign setup step before Stripe Checkout. Signed-in advertisers provide business information and choose either **Upload my own ad** or **Have BeSeen create my ad**. Finished ad uploads are stored privately in the Supabase `advertiser-assets` bucket, and campaign intake records are saved in `public.subscription_intakes` before checkout. Rerun `supabase/schema.sql` once when deploying this version.

## Owner subscriber visibility
The Owner/Admin Advertisers page now loads real paid subscriber data from Supabase. It shows the signed-in subscriber name/email, business name/type captured during campaign intake, Stripe-synced plan/status, subscribed locations, and whether the advertiser uploaded their own ad or asked BeSeen to create it. No sample subscriber rows are seeded.

## Additional-location CTA
Subscription sections use a compact `+ Add Another Location — $50 Off/mo` button that opens the full multi-location selection modal.

## Advertiser analytics access
- Gold and above can see their own account-scoped campaign totals and performance by subscribed BeSeen location.
- Platinum additionally unlocks deeper analytics such as unique/repeat scanner estimates (where session IDs are present), lead conversion rate, strongest location, and strongest tracked scan hour.
- Advertiser analytics are fetched server-side from `/api/analytics?scope=user` and are restricted to campaigns owned by the authenticated advertiser. Owner/Admin staff can access network-wide metrics separately.

## Automatic QR campaign setup

The subscription intake now requires a **QR destination URL**. After Stripe confirms payment, the webhook automatically creates one campaign per purchased BeSeen location with:

- the advertiser account
- the specific BeSeen location
- the customer-provided destination URL
- a unique tracking code
- an active tracked redirect at `/api/qr?c=...`

Because each location gets a different tracking code, QR scans are attributed to the correct advertiser and location automatically. The advertiser's **Creative + QR Hub** reads only campaigns permitted by Supabase RLS and displays/can download the generated QR code.

When deploying this version over an existing Supabase project, run the latest `supabase/schema.sql` once. It safely adds `qr_destination_url`, campaign linkage fields, and indexes using `IF NOT EXISTS`.


## Owner QR Library update
- Subscription intake wording now clearly asks for **Link your QR code should lead to**.
- After successful Stripe checkout, the existing webhook automatically creates one campaign/tracking code per purchased location.
- Owner/Admin can open **Control Center > Campaigns + QR Library** to see every generated campaign QR, the subscriber, the BeSeen tracking URL, and the final redirect URL.
- **Download QR** gives the PNG to place directly into the customer's creative; no manual QR generation is required.


## Owner advertiser → location QR workflow
The Owner Control Center Campaigns + QR Library now groups paid QR campaigns by advertiser, then by BeSeen location. Click an advertiser to expand their subscribed locations; click a location to open that placement's tracked QR code, destination URL, and download/copy actions. This uses existing campaigns/location data and does not require a new database table.
