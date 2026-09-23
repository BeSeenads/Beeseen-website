import { createClient } from '@supabase/supabase-js';
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'}})}
function db(){if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY)return null;return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}})}
export async function GET(request){
  const supabase=db(); if(!supabase) return json({error:'Analytics are not configured.'},503);
  const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
  if(!token) return json({error:'Sign in required.'},401);
  const {data:userData,error:userError}=await supabase.auth.getUser(token); const user=userData?.user;
  if(userError||!user) return json({error:'Invalid sign-in session.'},401);
  const {data:profile}=await supabase.from('profiles').select('role').eq('id',user.id).single();
  const staff=['owner','admin'].includes(profile?.role);
  let q=supabase.from('campaigns').select('id');
  if(!staff) q=q.eq('advertiser_id',user.id);
  const {data:campaigns,error:campaignError}=await q;
  if(campaignError) return json({error:'Could not load campaigns.'},500);
  const ids=(campaigns||[]).map(c=>c.id);
  if(!ids.length) return json({metrics:{qr_scan:0,landing_visit:0,phone_click:0,form_start:0,form_submit:0,directions_click:0,listing_view:0,custom:0,total:0,high_intent:0,engagement_rate:0}});
  const {data:events,error}=await supabase.from('tracking_events').select('event_type').in('campaign_id',ids);
  if(error) return json({error:'Could not load analytics.'},500);
  const m={qr_scan:0,landing_visit:0,phone_click:0,form_start:0,form_submit:0,directions_click:0,listing_view:0,custom:0,total:0,high_intent:0,engagement_rate:0};
  for(const e of (events||[])){if(m[e.event_type]!==undefined)m[e.event_type]++;m.total++;}
  m.high_intent=m.phone_click+m.form_submit+m.directions_click+m.listing_view;
  m.engagement_rate=m.qr_scan?Number(((m.high_intent/m.qr_scan)*100).toFixed(1)):0;
  return json({metrics:m});
}
