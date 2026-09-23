# BeSeen — Vercel-ready project

This folder contains the current BeSeen website and a real Supabase authentication scaffold.

## Owner
The current owner email is:

`akilhsen4@gmail.com`

The supplied Supabase SQL automatically assigns that verified account the `owner` role when the account is created.

## Deploy to Vercel
1. Upload this folder to a GitHub repo, or drag/import the project into Vercel.
2. In Supabase, create a project.
3. Open **SQL Editor** in Supabase and run `supabase/schema.sql` once.
4. In Supabase **Authentication > URL Configuration**, set your Vercel production URL as the Site URL. Add the production URL to Redirect URLs as well.
5. In Vercel, open **Project Settings > Environment Variables** and add:
   - `SUPABASE_URL` = your Supabase Project URL
   - `SUPABASE_ANON_KEY` = your Supabase anon/public key
6. Redeploy the Vercel project.
7. Create the account for `akilhsen4@gmail.com`, verify the email, and sign in. The database trigger gives that account Owner access.

## Important
- The public site is deployable immediately.
- Real sign-in requires Supabase environment variables.
- Gold/Premium/Platinum payment buttons are not connected to Stripe yet.
- Owner dashboard numbers / QR analytics shown in the current design are UI placeholders until Stripe, campaign tracking, host applications, and device data are connected.
- Do not implement roles by checking email in browser JavaScript. Roles live in the Supabase `profiles` table.

## Next production connections
- Stripe Checkout + Billing webhooks
- Host application storage / notifications
- QR tracking endpoints
- Ad upload storage
- Device heartbeat / status reporting
- Owner/Admin management actions
