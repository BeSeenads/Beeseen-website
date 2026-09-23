import { createClient } from '@supabase/supabase-js';
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
function db(){if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY)return null;return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}})}
export async function POST(request){
  const supabase=db(); if(!supabase)return json({error:'Supabase is not configured.'},503);
  const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
  const {data:userData}=await supabase.auth.getUser(token); if(!userData?.user)return json({error:'Sign in required.'},401);
  const {data:profile}=await supabase.from('profiles').select('role').eq('id',userData.user.id).single();
  if(!['owner','admin'].includes(profile?.role))return json({error:'Staff access required.'},403);
  const form=await request.formData().catch(()=>null); const file=form?.get('file');
  if(!file||typeof file.arrayBuffer!=='function')return json({error:'Choose an image first.'},400);
  if(!String(file.type||'').startsWith('image/'))return json({error:'Only image files are allowed.'},400);
  if(Number(file.size||0)>8*1024*1024)return json({error:'Image must be 8 MB or smaller.'},400);
  const ext=(String(file.name||'image.jpg').split('.').pop()||'jpg').replace(/[^a-z0-9]/gi,'').toLowerCase()||'jpg';
  const path=`locations/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const buffer=await file.arrayBuffer();
  const {error}=await supabase.storage.from('location-images').upload(path,buffer,{contentType:file.type||'image/jpeg',upsert:false});
  if(error)return json({error:'Image upload failed.'},500);
  const {data}=supabase.storage.from('location-images').getPublicUrl(path);
  return json({url:data.publicUrl});
}
