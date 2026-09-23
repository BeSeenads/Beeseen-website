import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function requireStaff(request, supabase) {
  const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim(); if(!token) return {error:json({error:'Sign in first.'},401)};
  const {data,error}=await supabase.auth.getUser(token); if(error||!data?.user) return {error:json({error:'Invalid sign-in session.'},401)};
  const {data:profile}=await supabase.from('profiles').select('id,role').eq('id',data.user.id).single();
  if(!['owner','admin'].includes(profile?.role)) return {error:json({error:'BeSeen staff access required.'},403)};
  return {user:data.user,profile};
}
const cleanSlug=v=>String(v||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
const int=v=>Math.max(0,Math.round(Number(v)||0));
function fields(body) {
  return {
    name:String(body.name||'').trim().slice(0,160), slug:cleanSlug(body.slug||body.name), city:String(body.city||'').trim().slice(0,120),
    status:['live','future','paused'].includes(body.status)?body.status:'future', visibility:['public','platinum','private'].includes(body.visibility)?body.visibility:'private',
    short_description:String(body.short_description||'').trim().slice(0,300), description:String(body.description||'').trim().slice(0,4000), image_url:String(body.image_url||'').trim().slice(0,1500),
    device_count:int(body.device_count), gold_price_cents:int(body.gold_price_cents), premium_price_cents:int(body.premium_price_cents), platinum_price_cents:int(body.platinum_price_cents)
  };
}
async function ensureStripePrices(existing, values) {
  if (!stripe) return {};
  let productId=existing?.stripe_product_id || null;
  if(!productId) {
    const product=await stripe.products.create({name:`BeSeen — ${values.name}`,metadata:{beseen_location_slug:values.slug}}); productId=product.id;
  } else if(existing?.name && existing.name!==values.name) {
    await stripe.products.update(productId,{name:`BeSeen — ${values.name}`});
  }
  const out={stripe_product_id:productId};
  for(const plan of ['gold','premium','platinum']) {
    const amount=values[`${plan}_price_cents`]; const oldAmount=existing?.[`${plan}_price_cents`]; const oldPrice=existing?.[`stripe_price_${plan}`];
    if(amount>0 && (!oldPrice || amount!==oldAmount)) {
      const price=await stripe.prices.create({product:productId,unit_amount:amount,currency:'usd',recurring:{interval:'month'},nickname:`${values.name} — ${plan[0].toUpperCase()+plan.slice(1)}`,metadata:{beseen_location_slug:values.slug,beseen_plan:plan}});
      out[`stripe_price_${plan}`]=price.id;
      if(oldPrice) { try { await stripe.prices.update(oldPrice,{active:false}); } catch {} }
    }
  }
  return out;
}

export async function GET(request) {
  const supabase=db(); if(!supabase) return json({error:'Supabase server access is not configured.'},503); const auth=await requireStaff(request,supabase); if(auth.error) return auth.error;
  const {data,error}=await supabase.from('locations').select('*').order('sort_order',{ascending:true}).order('created_at',{ascending:true}); if(error) return json({error:'Could not load locations.'},500);
  return json({locations:data||[]});
}
export async function POST(request) {
  const supabase=db(); if(!supabase) return json({error:'Supabase server access is not configured.'},503); const auth=await requireStaff(request,supabase); if(auth.error) return auth.error;
  const body=await request.json().catch(()=>({})); const values=fields(body); if(!values.name||!values.slug) return json({error:'Location name and slug are required.'},400);
  let stripeFields={}; try { stripeFields=await ensureStripePrices(null,values); } catch(e) { console.error(e); return json({error:'Stripe could not create the monthly prices for this location.'},502); }
  const {data,error}=await supabase.from('locations').insert({...values,...stripeFields,created_by:auth.user.id}).select('*').single(); if(error) return json({error:error.code==='23505'?'That location slug already exists.':'Could not create location.'},400);
  return json({location:data},201);
}
export async function PATCH(request) {
  const supabase=db(); if(!supabase) return json({error:'Supabase server access is not configured.'},503); const auth=await requireStaff(request,supabase); if(auth.error) return auth.error;
  const body=await request.json().catch(()=>({})); const id=String(body.id||'').trim(); if(!id) return json({error:'Location id is required.'},400);
  const {data:existing,error:readError}=await supabase.from('locations').select('*').eq('id',id).single(); if(readError||!existing) return json({error:'Location not found.'},404);
  const values=fields(body); if(!values.name||!values.slug) return json({error:'Location name and slug are required.'},400);
  let stripeFields={}; try { stripeFields=await ensureStripePrices(existing,values); } catch(e) { console.error(e); return json({error:'Stripe could not update the monthly prices for this location.'},502); }
  const {data,error}=await supabase.from('locations').update({...values,...stripeFields,updated_at:new Date().toISOString()}).eq('id',id).select('*').single(); if(error) return json({error:error.code==='23505'?'That location slug already exists.':'Could not update location.'},400);
  return json({location:data});
}
export async function DELETE(request) {
  const supabase=db(); if(!supabase) return json({error:'Supabase server access is not configured.'},503); const auth=await requireStaff(request,supabase); if(auth.error) return auth.error;
  const body=await request.json().catch(()=>({})); const id=String(body.id||'').trim(); if(!id) return json({error:'Location id is required.'},400);
  const {data:existing}=await supabase.from('locations').select('id,slug,stripe_product_id').eq('id',id).single(); if(!existing) return json({error:'Location not found.'},404); if(existing.slug==='exclusive') return json({error:'The built-in Exclusive location cannot be deleted. Set it to Paused or Private instead.'},400);
  const {error}=await supabase.from('locations').delete().eq('id',id); if(error) return json({error:'Could not delete location.'},500);
  if(stripe && existing.stripe_product_id){ try{ await stripe.products.update(existing.stripe_product_id,{active:false}); }catch{} }
  return json({ok:true});
}
