import { createClient } from '@supabase/supabase-js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30, s-maxage=60' } });
}
export async function GET() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return json({ locations: [] });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.from('locations')
    .select('id,slug,name,city,status,visibility,short_description,description,device_count,image_url,gold_price_cents,premium_price_cents,platinum_price_cents,sort_order')
    .eq('status', 'live').eq('visibility', 'public').order('sort_order', { ascending: true }).order('name', { ascending: true });
  if (error) return json({ locations: [] });
  return json({ locations: data || [] });
}
