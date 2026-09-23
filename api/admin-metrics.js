import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'}})}
function db(){if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY)return null;return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}})}
async function requireStaff(request,supabase){
  const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim(); if(!token)return null;
  const {data}=await supabase.auth.getUser(token); if(!data?.user)return null;
  const {data:profile}=await supabase.from('profiles').select('role').eq('id',data.user.id).single();
  return ['owner','admin'].includes(profile?.role)?data.user:null;
}
export async function GET(request){
  const supabase=db(); if(!supabase)return json({error:'Supabase server access is not configured.'},503);
  if(!await requireStaff(request,supabase))return json({error:'Staff access required.'},403);
  const [{count:activeSubscriptions},{count:liveCampaigns},{count:qrScans},{count:landingVisits},{count:phoneClicks},{count:formSubmits},{count:liveLocations},{count:futureLocations}] = await Promise.all([
    supabase.from('profiles').select('*',{count:'exact',head:true}).in('subscription_status',['active','trialing']).neq('subscription','none'),
    supabase.from('campaigns').select('*',{count:'exact',head:true}).eq('status','live'),
    supabase.from('tracking_events').select('*',{count:'exact',head:true}).eq('event_type','qr_scan'),
    supabase.from('tracking_events').select('*',{count:'exact',head:true}).eq('event_type','landing_visit'),
    supabase.from('tracking_events').select('*',{count:'exact',head:true}).eq('event_type','phone_click'),
    supabase.from('tracking_events').select('*',{count:'exact',head:true}).eq('event_type','form_submit'),
    supabase.from('locations').select('*',{count:'exact',head:true}).eq('status','live').eq('visibility','public'),
    supabase.from('locations').select('*',{count:'exact',head:true}).eq('status','future').eq('visibility','platinum')
  ]);
  let mrrCents=0;
  if(stripe){
    try{
      let starting_after;
      do{
        const page=await stripe.subscriptions.list({status:'active',limit:100,...(starting_after?{starting_after}:{})});
        for(const sub of page.data){
          for(const item of sub.items.data){
            if(item.price?.recurring?.interval==='month') mrrCents+=(item.price.unit_amount||0)*(item.quantity||1);
          }
        }
        starting_after=page.has_more?page.data.at(-1)?.id:undefined;
      }while(starting_after);
    }catch(e){console.error('Stripe MRR lookup failed',e);}
  }
  return json({metrics:{
    mrr_cents:mrrCents,
    active_subscriptions:activeSubscriptions||0,
    live_campaigns:liveCampaigns||0,
    qr_scans:qrScans||0,
    landing_visits:landingVisits||0,
    phone_clicks:phoneClicks||0,
    attributed_leads:formSubmits||0,
    live_locations:liveLocations||0,
    future_locations:futureLocations||0
  }});
}
