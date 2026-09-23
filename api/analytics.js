import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'}
  });
}

function db(){
  if(!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return null;
  return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{
    auth:{persistSession:false,autoRefreshToken:false}
  });
}

async function getUser(request,supabase){
  const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
  if(!token) return null;
  const {data,error}=await supabase.auth.getUser(token);
  if(error || !data?.user) return null;
  return data.user;
}

async function getRole(userId,supabase){
  const {data}=await supabase.from('profiles').select('role').eq('id',userId).single();
  return data?.role || 'member';
}

async function userAnalytics(user,role,supabase){
  const staff=['owner','admin'].includes(role);
  let q=supabase.from('campaigns').select('id');
  if(!staff) q=q.eq('advertiser_id',user.id);
  const {data:campaigns,error:campaignError}=await q;
  if(campaignError) return json({error:'Could not load campaigns.'},500);

  const ids=(campaigns||[]).map(c=>c.id);
  const empty={qr_scan:0,landing_visit:0,phone_click:0,form_start:0,form_submit:0,directions_click:0,listing_view:0,custom:0,total:0,high_intent:0,engagement_rate:0};
  if(!ids.length) return json({metrics:empty});

  const {data:events,error}=await supabase.from('tracking_events').select('event_type').in('campaign_id',ids);
  if(error) return json({error:'Could not load analytics.'},500);

  const m={...empty};
  for(const e of (events||[])){
    if(m[e.event_type]!==undefined) m[e.event_type]++;
    m.total++;
  }
  m.high_intent=m.phone_click+m.form_submit+m.directions_click+m.listing_view;
  m.engagement_rate=m.qr_scan?Number(((m.high_intent/m.qr_scan)*100).toFixed(1)):0;
  return json({metrics:m});
}

async function staffAnalytics(role,supabase){
  if(!['owner','admin'].includes(role)) return json({error:'Staff access required.'},403);

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
    }catch(e){
      console.error('Stripe MRR lookup failed',e);
    }
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

export async function GET(request){
  const supabase=db();
  if(!supabase) return json({error:'Analytics are not configured.'},503);
  const user=await getUser(request,supabase);
  if(!user) return json({error:'Sign in required.'},401);
  const role=await getRole(user.id,supabase);
  const url=new URL(request.url);
  const scope=(url.searchParams.get('scope')||'user').toLowerCase();
  return scope==='admin' ? staffAnalytics(role,supabase) : userAnalytics(user,role,supabase);
}
