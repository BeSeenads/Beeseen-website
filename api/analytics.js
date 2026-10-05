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

async function getProfileAccess(userId,supabase){
  const {data}=await supabase.from('profiles').select('role,subscription').eq('id',userId).single();
  return {role:data?.role || 'member',subscription:data?.subscription || 'none'};
}

async function userAnalytics(user,access,supabase){
  const staff=['owner','admin'].includes(access.role);
  let q=supabase.from('campaigns').select('id,location_id,name');
  if(!staff) q=q.eq('advertiser_id',user.id);
  const {data:campaigns,error:campaignError}=await q;
  if(campaignError) return json({error:'Could not load campaigns.'},500);

  const ids=(campaigns||[]).map(c=>c.id);
  const empty={qr_scan:0,landing_visit:0,phone_click:0,form_start:0,form_submit:0,directions_click:0,listing_view:0,custom:0,total:0,high_intent:0,engagement_rate:0};
  if(!ids.length) return json({metrics:empty,by_location:[],platinum_details:{unique_scanners:0,repeat_scans:0,lead_conversion_rate:0,best_hour_label:null,best_location_name:null,best_location_scans:0},tier:access.subscription});

  const {data:events,error}=await supabase.from('tracking_events').select('campaign_id,event_type,session_id,created_at').in('campaign_id',ids);
  if(error) return json({error:'Could not load analytics.'},500);

  const m={...empty};
  for(const e of (events||[])){
    if(m[e.event_type]!==undefined) m[e.event_type]++;
    m.total++;
  }
  m.high_intent=m.phone_click+m.form_submit+m.directions_click+m.listing_view;
  m.engagement_rate=m.qr_scan?Number(((m.high_intent/m.qr_scan)*100).toFixed(1)):0;

  const locationIds=[...new Set((campaigns||[]).map(c=>c.location_id).filter(Boolean))];
  let locationMap=new Map();
  if(locationIds.length){
    const {data:locations}=await supabase.from('locations').select('id,name').in('id',locationIds);
    locationMap=new Map((locations||[]).map(l=>[l.id,l.name]));
  }
  const campaignMap=new Map((campaigns||[]).map(c=>[c.id,c]));
  const byLoc=new Map();
  for(const c of (campaigns||[])){
    const key=c.location_id||'unassigned';
    if(!byLoc.has(key)) byLoc.set(key,{location_id:c.location_id||null,location_name:c.location_id?(locationMap.get(c.location_id)||'BeSeen location'):'Unassigned campaign',...empty});
  }
  for(const e of (events||[])){
    const c=campaignMap.get(e.campaign_id); if(!c) continue;
    const key=c.location_id||'unassigned';
    if(!byLoc.has(key)) byLoc.set(key,{location_id:c.location_id||null,location_name:c.location_id?(locationMap.get(c.location_id)||'BeSeen location'):'Unassigned campaign',...empty});
    const row=byLoc.get(key);
    if(row[e.event_type]!==undefined) row[e.event_type]++;
    row.total++;
  }
  const by_location=[...byLoc.values()].map(row=>{
    row.high_intent=row.phone_click+row.form_submit+row.directions_click+row.listing_view;
    row.engagement_rate=row.qr_scan?Number(((row.high_intent/row.qr_scan)*100).toFixed(1)):0;
    return row;
  }).sort((a,b)=>b.qr_scan-a.qr_scan || b.total-a.total);

  const qrEvents=(events||[]).filter(e=>e.event_type==='qr_scan');
  const uniqueSessions=new Set(qrEvents.map(e=>e.session_id).filter(Boolean));
  const uniqueScanners=uniqueSessions.size || (qrEvents.length?qrEvents.length:0);
  const repeatScans=Math.max(0,qrEvents.length-uniqueScanners);
  const hourCounts=new Map();
  const detroitHourFmt=new Intl.DateTimeFormat('en-US',{hour:'numeric',hour12:false,timeZone:'America/Detroit'});
  for(const e of qrEvents){
    const d=new Date(e.created_at); if(Number.isNaN(d.getTime())) continue;
    const h=Number(detroitHourFmt.format(d))%24; hourCounts.set(h,(hourCounts.get(h)||0)+1);
  }
  let bestHour=null,bestHourCount=0;
  for(const [h,count] of hourCounts){ if(count>bestHourCount){bestHour=h;bestHourCount=count;} }
  const hourLabel=bestHour===null?null:new Intl.DateTimeFormat('en-US',{hour:'numeric',hour12:true,timeZone:'UTC'}).format(new Date(Date.UTC(2026,0,1,bestHour,0,0)));
  const bestLocation=by_location.find(r=>r.qr_scan>0)||null;
  const platinum_details=(staff || access.subscription==='platinum') ? {
    unique_scanners:uniqueScanners,
    repeat_scans:repeatScans,
    lead_conversion_rate:m.qr_scan?Number(((m.form_submit/m.qr_scan)*100).toFixed(1)):0,
    best_hour_label:hourLabel,
    best_location_name:bestLocation?.location_name||null,
    best_location_scans:bestLocation?.qr_scan||0
  } : null;
  return json({metrics:m,by_location,platinum_details,tier:access.subscription});
}

async function staffAdvertisers(role,supabase){
  if(!['owner','admin'].includes(role)) return json({error:'Staff access required.'},403);

  const [{data:paidProfiles,error:profileError},{data:campaignRows,error:campaignIdError}]=await Promise.all([
    supabase.from('profiles')
      .select('id,email,full_name,subscription,subscription_status,created_at,stripe_customer_id,stripe_subscription_id')
      .neq('subscription','none')
      .order('created_at',{ascending:false}),
    supabase.from('campaigns').select('advertiser_id')
  ]);
  if(profileError||campaignIdError) return json({error:'Could not load subscribers.'},500);
  const campaignOwnerIds=[...new Set((campaignRows||[]).map(row=>row.advertiser_id).filter(Boolean))];
  let campaignProfiles=[];
  if(campaignOwnerIds.length){
    const {data,error}=await supabase.from('profiles')
      .select('id,email,full_name,subscription,subscription_status,created_at,stripe_customer_id,stripe_subscription_id')
      .in('id',campaignOwnerIds);
    if(error) return json({error:'Could not load subscribers.'},500);
    campaignProfiles=data||[];
  }
  const profiles=[...new Map([...(paidProfiles||[]),...campaignProfiles].map(profile=>[profile.id,profile])).values()];

  const ids=(profiles||[]).map(p=>p.id);
  if(!ids.length) return json({advertisers:[]});

  const [{data:intakes,error:intakeError},{data:subs,error:subsError},{data:manualBilling,error:billingListError}]=await Promise.all([
    supabase.from('subscription_intakes')
      .select('user_id,business_name,business_type,creative_choice,campaign_details,status,location_slugs,created_at')
      .in('user_id',ids)
      .order('created_at',{ascending:false}),
    supabase.from('subscription_locations')
      .select('user_id,location_slug,plan,status')
      .in('user_id',ids),
    supabase.from('billing_overrides')
      .select('user_id,custom_price_cents,custom_price_active,billing_source,stripe_subscription_id,owner_note')
      .in('user_id',ids)
  ]);
  if(intakeError) return json({error:'Could not load subscriber business information.'},500);
  if(subsError) return json({error:'Could not load subscriber locations.'},500);
  if(billingListError) return json({error:'Could not load advertiser payments.'},500);
  const monthlyByUser=new Map();
  const startedByUser=new Map();
  for(const row of (manualBilling||[])){
    const manualNote=String(row.owner_note||'').startsWith('Manual advertiser:');
    if(row.stripe_subscription_id || !row.custom_price_active || !manualNote) continue;
    monthlyByUser.set(row.user_id,(monthlyByUser.get(row.user_id)||0)+ (Number(row.custom_price_cents)||0));
    const started=String(row.owner_note||'').match(/\|\s*started:(\d{4}-\d{2}-\d{2})/)?.[1];
    const previous=startedByUser.get(row.user_id);
    if(started && (!previous || started<previous)) startedByUser.set(row.user_id,started);
  }

  const latestIntake=new Map();
  for(const row of (intakes||[])){ if(!latestIntake.has(row.user_id)) latestIntake.set(row.user_id,row); }

  const byUser=new Map();
  for(const row of (subs||[])){
    if(!byUser.has(row.user_id)) byUser.set(row.user_id,[]);
    byUser.get(row.user_id).push(row);
  }

  const allSlugs=[...new Set((subs||[]).map(r=>r.location_slug).filter(Boolean))];
  let locationMap=new Map();
  if(allSlugs.length){
    const {data:locations}=await supabase.from('locations').select('slug,name').in('slug',allSlugs);
    locationMap=new Map((locations||[]).map(l=>[l.slug,l.name]));
  }
  const {data:campaignPlaces,error:campaignPlaceError}=await supabase.from('campaigns').select('advertiser_id,location_id').in('advertiser_id',ids);
  if(campaignPlaceError) return json({error:'Could not load subscriber locations.'},500);
  const campaignLocationIds=[...new Set((campaignPlaces||[]).map(row=>row.location_id).filter(Boolean))];
  let campaignLocationNames=new Map();
  if(campaignLocationIds.length){
    const {data:campaignLocationRows,error}=await supabase.from('locations').select('id,name,slug').in('id',campaignLocationIds);
    if(error) return json({error:'Could not load subscriber locations.'},500);
    campaignLocationNames=new Map((campaignLocationRows||[]).map(row=>[row.id,row.name]));
    var campaignLocationSlugs=new Map((campaignLocationRows||[]).map(row=>[row.id,row.slug]));
  }
  const campaignLocations=new Map();
  const campaignSlugs=new Map();
  for(const row of (campaignPlaces||[])){
    const name=campaignLocationNames.get(row.location_id);
    const slug=campaignLocationSlugs?.get(row.location_id);
    if(!row.advertiser_id||!name) continue;
    const list=campaignLocations.get(row.advertiser_id)||[];
    list.push(name);
    campaignLocations.set(row.advertiser_id,list);
    if(slug){
      const slugs=campaignSlugs.get(row.advertiser_id)||[];
      slugs.push(slug);
      campaignSlugs.set(row.advertiser_id,slugs);
    }
  }

  const advertisers=(profiles||[]).map(p=>{
    const intake=latestIntake.get(p.id)||null;
    const userSubs=(byUser.get(p.id)||[]).filter(r=>!['canceled','inactive'].includes(String(r.status||'').toLowerCase()));
    const subscribedNames=userSubs.map(r=>locationMap.get(r.location_slug)||r.location_slug).filter(Boolean);
    const campaignNames=(campaignLocations.get(p.id)||[]);
    const locationNames=[...new Set([...subscribedNames,...campaignNames])];
    return {
      id:p.id,
      subscriber_name:p.full_name||null,
      email:p.email||null,
      business_name:intake?.business_name||null,
      business_type:intake?.business_type||null,
      creative_choice:intake?.creative_choice||null,
      campaign_details:intake?.campaign_details||null,
      plan:p.subscription||userSubs[0]?.plan||'none',
      billing_status:p.subscription_status||'inactive',
      monthly_cents:monthlyByUser.get(p.id)||0,
      payment_started:startedByUser.get(p.id)||null,
      manual:!p.email || String(p.email).toLowerCase().endsWith('@advertisers.beseen.invalid'),
      location_slug:(campaignSlugs.get(p.id)||[])[0] || userSubs[0]?.location_slug || null,
      locations:locationNames,
      subscribed_at:intake?.created_at||p.created_at
    };
  });
  return json({advertisers});
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

  const [{data:manualBilling},{data:liveCampaignRows}] = await Promise.all([
    supabase.from('billing_overrides')
      .select('custom_price_cents,user_id,location_id,owner_note')
      .eq('custom_price_active',true)
      .is('stripe_subscription_id',null)
      .like('owner_note','Manual advertiser:%'),
    supabase.from('campaigns').select('advertiser_id,location_id').eq('status','live')
  ]);
  const liveCampaignKeys=new Set((liveCampaignRows||[]).map(row=>`${row.advertiser_id}:${row.location_id}`));
  for(const row of (manualBilling||[])){
    if(!liveCampaignKeys.has(`${row.user_id}:${row.location_id}`)) continue;
    mrrCents += Number(row.custom_price_cents)||0;
  }

  let guestContinues=0;
  const {count:guestCount,error:guestError}=await supabase
    .from('billing_events')
    .select('*',{count:'exact',head:true})
    .eq('event_type','guest_continue');
  if(!guestError) guestContinues=guestCount||0;

  return json({metrics:{
    mrr_cents:mrrCents,
    guest_continues:guestContinues,
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

export async function POST(request){
  const supabase=db();
  if(!supabase) return json({error:'Analytics are not configured.'},503);
  const body=await request.json().catch(()=>({}));
  if(body.event!=='guest_continue') return json({error:'Unknown event.'},400);
  const {error}=await supabase.from('billing_events').insert({
    event_type:'guest_continue',
    details:{source:'continue_as_guest'}
  });
  if(error) return json({error:'Could not record that guest visit.'},500);
  return json({ok:true});
}

export async function GET(request){
  const supabase=db();
  if(!supabase) return json({error:'Analytics are not configured.'},503);
  const user=await getUser(request,supabase);
  if(!user) return json({error:'Sign in required.'},401);
  const access=await getProfileAccess(user.id,supabase);
  const url=new URL(request.url);
  const scope=(url.searchParams.get('scope')||'user').toLowerCase();
  if(scope==='advertisers') return staffAdvertisers(access.role,supabase);
  return scope==='admin' ? staffAnalytics(access.role,supabase) : userAnalytics(user,access,supabase);
}
