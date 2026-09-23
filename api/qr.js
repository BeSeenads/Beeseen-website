import { createClient } from '@supabase/supabase-js';
function db(){if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY)return null;return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}})}
export async function GET(request){
  const supabase=db(); if(!supabase) return new Response('Tracking is not configured.',{status:503});
  const url=new URL(request.url); const code=String(url.searchParams.get('c')||'').trim().slice(0,120);
  if(!code) return new Response('Missing campaign code.',{status:400});
  const {data:campaign}=await supabase.from('campaigns').select('id,status,landing_url').eq('tracking_code',code).single();
  if(!campaign||campaign.status!=='live'||!campaign.landing_url) return new Response('Campaign is not active.',{status:404});
  await supabase.from('tracking_events').insert({campaign_id:campaign.id,event_type:'qr_scan',page_path:'/api/qr'});
  return Response.redirect(campaign.landing_url,302);
}
