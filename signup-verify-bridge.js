import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let signupBusy = false;
let authClient = null;

function rememberStorage() {
  const useLocal = localStorage.getItem('beseen_remember_me') === '1';
  const store = useLocal ? localStorage : sessionStorage;
  return {
    getItem: key => store.getItem(key),
    setItem: (key, value) => store.setItem(key, value),
    removeItem: key => store.removeItem(key)
  };
}

async function getClient() {
  if (authClient) return authClient;
  const cfg = await fetch('/api/config', { cache: 'no-store' }).then(r => r.json());
  if (!cfg.supabaseUrl || !cfg.supabasePublishableKey) {
    throw new Error('BeSeen authentication is not configured.');
  }
  authClient = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: {
      persistSession: true,
      storage: rememberStorage(),
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
  return authClient;
}

function setFeedback(message) {
  const el = document.getElementById('bsauthCreateFeedback') || document.getElementById('bsauthLoginFeedback');
  if (el) el.textContent = message;
}

function isCreateAction(target) {
  const form = document.getElementById('bsauthCreateForm');
  const button = target?.closest?.('button');
  if (!form || !button || !form.contains(button)) return false;
  return /(create|sign\s*up|register)/i.test(button.textContent || '');
}

async function handleSignup() {
  if (signupBusy) return;

  const full_name = document.getElementById('bsauthCreateName')?.value?.trim() || '';
  const email = document.getElementById('bsauthCreateEmail')?.value?.trim() || '';
  const password = document.getElementById('bsauthCreatePassword')?.value || '';
  const referral_code = document.getElementById('bsauthReferralCode')?.value?.trim() || '';
  const remember = !!document.getElementById('bsauthRememberCreate')?.checked;

  if (!email || password.length < 8) {
    setFeedback('Use a valid email and a password with at least 8 characters.');
    return;
  }

  signupBusy = true;
  setFeedback('Creating your account…');

  try {
    if (remember) localStorage.setItem('beseen_remember_me', '1');
    else localStorage.removeItem('beseen_remember_me');

    const supabase = await getClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/verify-email.html`,
        data: {
          full_name,
          referral_code,
          referred_by_code: referral_code
        }
      }
    });

    if (error) throw error;

    window.location.href = `/verify-email.html?email=${encodeURIComponent(email)}`;
  } catch (error) {
    signupBusy = false;
    setFeedback(error?.message || 'Could not create your account.');
  }
}

document.addEventListener('click', event => {
  if (!isCreateAction(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  handleSignup();
}, true);

document.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  const form = document.getElementById('bsauthCreateForm');
  if (!form || !form.contains(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  handleSignup();
}, true);
