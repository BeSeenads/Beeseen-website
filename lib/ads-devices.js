import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const ADS_API = 'https://adapi.cnszfyd.cn/api/';
const SESSION_EVENT = 'ads_console_session';
const VISITOR_ID = 'beseen-control-center';
const FINGERPRINT = createHash('sha256').update(VISITOR_ID).digest('hex').slice(0, 32);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}
async function requireStaff(request, supabase) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: json({ error: 'Sign in first.' }, 401) };
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return { error: json({ error: 'Invalid sign-in session.' }, 401) };
  const { data: profile } = await supabase.from('profiles').select('id,role').eq('id', data.user.id).single();
  if (!['owner', 'admin'].includes(profile?.role)) return { error: json({ error: 'BeSeen staff access required.' }, 403) };
  return { user: data.user, profile };
}
function adsConfigured() {
  return Boolean(String(process.env.ADS_USERNAME || '').trim() && String(process.env.ADS_PASSWORD || '').trim());
}
function cookiesFrom(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie().map(part => part.split(';')[0]).filter(Boolean).join('; ');
  }
  const raw = response.headers.get('set-cookie') || '';
  return raw ? raw.split(';')[0] : '';
}
function expiryFrom(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now() + 6 * 60 * 60 * 1000;
  if (n > 1e12) return n;
  if (n > 1e9) return n * 1000;
  return Date.now() + n * 1000;
}
async function adsFetch(path, { method = 'GET', token = '', cookie = '', body, params } = {}) {
  const url = new URL(path.replace(/^\//, ''), ADS_API);
  if (params) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value == null ? '' : String(value));
  }
  const headers = {
    accept: 'application/json',
    'x-visitor-id': VISITOR_ID,
    'x-fingerprint': FINGERPRINT
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    payload,
    token: response.headers.get('token') || '',
    expiresIn: response.headers.get('expires_in') || '',
    cookie: cookiesFrom(response)
  };
}
function captchaImage(payload) {
  const blob = String(payload?.data?.base_64_blob || payload?.data?.base64 || '');
  if (!blob) return '';
  return blob.startsWith('data:') ? blob : `data:image/png;base64,${blob}`;
}
async function freshCaptcha(message) {
  const result = await adsFetch('captcha', { method: 'POST', body: {} });
  const image = captchaImage(result.payload);
  const captchaId = String(result.payload?.data?.id || '');
  if (!image || !captchaId) {
    return { configured: true, needsCaptcha: true, message: message || 'The screen console did not return a calculation check.' };
  }
  return {
    configured: true,
    needsCaptcha: true,
    captchaId,
    captchaImage: image,
    message: message || 'Type the calculation shown here to connect the screen list.'
  };
}
function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(process.env.SUPABASE_SECRET_KEY).digest(), iv);
  const enc = Buffer.concat([cipher.update(String(text || ''), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function unseal(payload) {
  if (!payload) return '';
  const buf = Buffer.from(String(payload), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(process.env.SUPABASE_SECRET_KEY).digest(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
async function readSession(supabase) {
  const { data } = await supabase
    .from('billing_events')
    .select('id,details,created_at')
    .eq('event_type', SESSION_EVENT)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const details = data?.details || {};
  if (!details.token || Number(details.expires_at || 0) < Date.now() + 15000) return null;
  try {
    return { id: data.id, token: unseal(details.token), cookie: unseal(details.cookie) };
  } catch {
    return null;
  }
}
async function saveSession(supabase, token, expiresAt, cookie) {
  const details = { token: seal(token), expires_at: expiresAt, cookie: seal(cookie || ''), v: 1 };
  const { data: existing } = await supabase
    .from('billing_events')
    .select('id')
    .eq('event_type', SESSION_EVENT)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const write = existing?.id
    ? await supabase.from('billing_events').update({ details, created_at: new Date().toISOString() }).eq('id', existing.id)
    : await supabase.from('billing_events').insert({ event_type: SESSION_EVENT, details });
  if (write.error) throw new Error('Could not keep the screen console signed in.');
}
async function clearSession(supabase) {
  await supabase.from('billing_events').delete().eq('event_type', SESSION_EVENT);
}
function screenFrom(row) {
  const name = ['name', 'remark', 'address', 'location', 'title', 'note', 'group_name']
    .map(key => String(row?.[key] || '').trim())
    .find(Boolean) || '';
  const waiting = Number(row?.load_count || 0);
  return {
    id: String(row?.id || ''),
    mac: String(row?.mac || ''),
    name,
    account: String(row?.username || ''),
    online: row?.state === true || row?.state === 1 || row?.state === '1',
    adReady: waiting === 0,
    waiting,
    expired: Boolean(row?.is_expire),
    created: String(row?.ctime || ''),
    expires: String(row?.gtime || '')
  };
}
async function listScreens(token, cookie) {
  const screens = [];
  let page = 1;
  let total = 0;
  do {
    const result = await adsFetch('mac/maclist', {
      token,
      cookie,
      params: { page, pageSize: 100, user_id: '', team_id: 1, display: 1, search: '' }
    });
    const code = Number(result.payload?.code);
    if (result.status === 401 || code === 401) return { unauthorized: true };
    if (code !== 200) {
      const message = String(result.payload?.message || 'The screen console could not load devices.');
      return { error: message.slice(0, 180) };
    }
    const batch = Array.isArray(result.payload?.data?.data) ? result.payload.data.data : [];
    total = Number(result.payload?.data?.total || batch.length);
    screens.push(...batch.map(screenFrom));
    if (!batch.length) break;
    page += 1;
  } while (screens.length < total && page <= 20);
  screens.sort((a, b) => Number(a.online) - Number(b.online) || a.mac.localeCompare(b.mac));
  const online = screens.filter(screen => screen.online).length;
  return { screens, online, offline: screens.length - online };
}
function devicePayload(list) {
  return {
    configured: true,
    needsCaptcha: false,
    devices: list.screens,
    online: list.online,
    offline: list.offline,
    checkedAt: new Date().toISOString()
  };
}
async function login(captchaId, code) {
  const result = await adsFetch('login', {
    method: 'POST',
    body: {
      username: String(process.env.ADS_USERNAME || '').trim(),
      password: String(process.env.ADS_PASSWORD || ''),
      captchaid: captchaId,
      code
    }
  });
  const token = result.token || String(result.payload?.data?.token || result.payload?.token || '');
  if (Number(result.payload?.code) !== 200 || !token) {
    return { error: String(result.payload?.message || 'The calculation did not match. Try the new one.') };
  }
  return { token, expiresAt: expiryFrom(result.expiresIn), cookie: result.cookie };
}

export async function handleDeviceGet(request) {
  const supabase = db();
  if (!supabase) return json({ error: 'Supabase server access is not configured.' }, 503);
  const auth = await requireStaff(request, supabase);
  if (auth.error) return auth.error;
  if (!adsConfigured()) {
    return json({
      configured: false,
      message: 'Add ADS_USERNAME and ADS_PASSWORD in the Vercel project settings, then redeploy.'
    });
  }
  const forceCaptcha = new URL(request.url).searchParams.get('captcha') === '1';
  if (!forceCaptcha) {
    const session = await readSession(supabase);
    if (session) {
      try {
        const list = await listScreens(session.token, session.cookie);
        if (list.unauthorized) await clearSession(supabase);
        else if (list.error) return json({ configured: true, needsCaptcha: false, message: list.error, devices: [] });
        else return json(devicePayload(list));
      } catch (error) {
        console.error('device list failed', error?.name || 'error');
        return json({ configured: true, needsCaptcha: false, message: 'The screen console did not respond.', devices: [] });
      }
    }
  }
  try {
    return json(await freshCaptcha());
  } catch (error) {
    console.error('device captcha failed', error?.name || 'error');
    return json({ configured: true, needsCaptcha: true, message: 'The screen console did not respond.' });
  }
}

export async function handleDevicePost(request, parsedBody) {
  const supabase = db();
  if (!supabase) return json({ error: 'Supabase server access is not configured.' }, 503);
  const auth = await requireStaff(request, supabase);
  if (auth.error) return auth.error;
  if (!adsConfigured()) return json({ configured: false, message: 'Add ADS_USERNAME and ADS_PASSWORD in the Vercel project settings, then redeploy.' });
  const body = parsedBody || await request.json().catch(() => ({}));
  const captchaId = String(body.captchaId || '').trim().slice(0, 120);
  const code = String(body.code || '').trim().slice(0, 12);
  if (!captchaId || !code) return json({ error: 'Type the calculation result.' }, 400);
  let signedIn;
  try {
    signedIn = await login(captchaId, code);
  } catch (error) {
    console.error('device login failed', error?.name || 'error');
    return json({ configured: true, needsCaptcha: true, message: 'The screen console did not respond.' });
  }
  if (signedIn.error) {
    try {
      const next = await freshCaptcha(signedIn.error);
      return json(next);
    } catch {
      return json({ configured: true, needsCaptcha: true, message: signedIn.error });
    }
  }
  try {
    await saveSession(supabase, signedIn.token, signedIn.expiresAt, signedIn.cookie);
  } catch (error) {
    console.error('device session save failed', error?.message || 'error');
    return json({ configured: true, needsCaptcha: true, message: 'The calculation was accepted, but the sign-in could not be saved. Try it again.' });
  }
  try {
    const list = await listScreens(signedIn.token, signedIn.cookie);
    if (list.unauthorized || list.error) {
      await clearSession(supabase);
      return json(await freshCaptcha(list.error || 'The screen list did not open. Try the calculation again.'));
    }
    return json(devicePayload(list));
  } catch (error) {
    console.error('device list after login failed', error?.name || 'error');
    return json({ configured: true, needsCaptcha: false, message: 'Signed in, but the screen list did not load. Refresh in a moment.', devices: [] });
  }
}
