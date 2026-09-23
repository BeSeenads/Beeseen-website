import { createClient } from '@supabase/supabase-js';

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
function db(){if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY)return null;return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}})}
const allowed=new Set(['qr_scan','landing_visit','phone_click','form_start','form_submit','directions_click','listing_view','custom']);

export async function POST(request){
  const supabase=db(); if(!supabase) return json({error:'Tracking is not configured.'},503);
  const body=await request.json().catch(()=>({}));
  const code=String(body.code||'').trim().slice(0,120);
  const eventType=String(body.eventType||'').trim();
  if(!code||!allowed.has(eventType)) return json({error:'Invalid tracking event.'},400);
  const {data:campaign,error}=await supabase.from('campaigns').select('id,status').eq('tracking_code',code).single();
  if(error||!campaign||campaign.status!=='live') return json({error:'Campaign is not active.'},404);
  const metadata=(body.metadata&&typeof body.metadata==='object'&&!Array.isArray(body.metadata))?body.metadata:{};
  const {error:insertError}=await supabase.from('tracking_events').insert({
    campaign_id:campaign.id,event_type:eventType,
    page_path:String(body.pagePath||'').slice(0,500)||null,
    session_id:String(body.sessionId||'').slice(0,160)||null,
    metadata
  });
  if(insertError) return json({error:'Event could not be recorded.'},500);
  return json({ok:true});
}
