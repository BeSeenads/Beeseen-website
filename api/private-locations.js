import { createClient } from '@supabase/supabase-js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' }
  });
}
function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function GET(request) {
  const supabase=db();
  if(!supabase) return json({error:'Supabase server access is not configured.'},503);
  const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
  if(!token) return json({error:'Sign in required.'},401);
  const {data:userData,error:userError}=await supabase.auth.getUser(token);
  const user=userData?.user;
  if(userError||!user) return json({error:'Invalid sign-in session.'},401);
  const {data:profile,error:profileError}=await supabase.from('profiles').select('role,subscription,subscription_status').eq('id',user.id).single();
  if(profileError||!profile) return json({error:'Account profile not found.'},403);
  const staff=['owner','admin'].includes(profile.role);
  const platinum=profile.subscription==='platinum' && ['active','trialing'].includes(String(profile.subscription_status||'').toLowerCase());
  if(!staff && !platinum) return json({error:'Platinum access required.'},403);
  const {data,error}=await supabase.from('locations')
    .select('id,slug,name,city,status,visibility,short_description,description,device_count,image_url,sort_order,created_at')
    .eq('status','future').eq('visibility','platinum').order('sort_order',{ascending:true}).order('created_at',{ascending:true});
  if(error) return json({error:'Could not load private placements.'},500);
  return json({locations:data||[]});
}
