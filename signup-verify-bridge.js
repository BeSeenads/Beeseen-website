(() => {
  if (window.__beseenSignupVerifyBridgeInstalled) return;
  window.__beseenSignupVerifyBridgeInstalled = true;

  let busy = false;
  let clientPromise = null;

  function ensureStyles() {
    if (document.getElementById('beseenSignupSuccessStyles')) return;
    const style = document.createElement('style');
    style.id = 'beseenSignupSuccessStyles';
    style.textContent = `
      .bs-signup-success-overlay{position:fixed;inset:0;z-index:999999;display:grid;place-items:center;padding:22px;background:rgba(3,12,31,.82);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
      .bs-signup-success-card{width:min(520px,100%);background:#fff;border-radius:28px;padding:38px 30px;text-align:center;box-shadow:0 35px 110px rgba(0,0,0,.45);animation:bsSignupPop .35s cubic-bezier(.2,.85,.25,1.08)}
      .bs-signup-success-logo{font-size:30px;font-weight:950;letter-spacing:-.06em;margin-bottom:22px}.bs-signup-success-logo .be{color:#ed334f}.bs-signup-success-logo .seen{color:#1877ff}
      .bs-signup-success-check{width:82px;height:82px;border-radius:50%;margin:0 auto 18px;display:grid;place-items:center;background:#e8f8ef;color:#138a55;font-size:42px;font-weight:950;animation:bsSignupCheck .5s ease both}
      .bs-signup-success-card h2{margin:0 0 10px;color:#10213f;font-size:30px;letter-spacing:-.04em}.bs-signup-success-card p{margin:0 auto;color:#6f7f9b;line-height:1.6;font-weight:650;max-width:420px}
      .bs-signup-email{margin:18px auto 0;padding:11px 14px;border-radius:12px;background:#f5f8fd;border:1px solid #dfe7f3;color:#10213f;font-weight:850;word-break:break-word}
      .bs-signup-success-note{margin-top:18px;font-size:13px;color:#536783;font-weight:800}.bs-signup-success-actions{display:flex;justify-content:center;gap:9px;flex-wrap:wrap;margin-top:24px}
      .bs-signup-success-btn{border:0;border-radius:13px;padding:12px 16px;font:inherit;font-weight:850;cursor:pointer;text-decoration:none}.bs-signup-success-primary{background:#1877ff;color:#fff}
      @keyframes bsSignupPop{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:none}}@keyframes bsSignupCheck{0%{transform:scale(.5);opacity:0}70%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function showSuccess(email) {
    ensureStyles();
    document.getElementById('beseenSignupSuccessOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'bs-signup-success-overlay';
    overlay.id = 'beseenSignupSuccessOverlay';
    overlay.innerHTML = `
      <div class="bs-signup-success-card" role="dialog" aria-modal="true" aria-labelledby="bsSignupSuccessTitle">
        <div class="bs-signup-success-logo"><span class="be">Be</span><span class="seen">Seen</span></div>
        <div class="bs-signup-success-check">✓</div>
        <h2 id="bsSignupSuccessTitle">Account created!</h2>
        <p>Your account was created successfully. Verify your email to continue.</p>
        ${email ? `<div class="bs-signup-email">${escapeHtml(email)}</div>` : ''}
        <div class="bs-signup-success-note">Check your inbox and click the BeSeen verification link. After you verify, you’ll be signed in and brought back to BeSeen automatically.</div>
        <div class="bs-signup-success-actions">
          <button class="bs-signup-success-btn bs-signup-success-primary" type="button" id="bsSignupSuccessDone">Got it — I’ll verify my email</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('bsSignupSuccessDone')?.addEventListener('click', () => overlay.remove());
  }

  function setFeedback(message) {
    const el = document.getElementById('bsauthCreateFeedback') || document.getElementById('bsauthLoginFeedback');
    if (el) el.textContent = message;
  }

  async function getClient() {
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      const [{ createClient }, cfg] = await Promise.all([
        import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'),
        fetch('/api/config', { cache: 'no-store' }).then(r => r.json())
      ]);
      if (!cfg.supabaseUrl || !cfg.supabasePublishableKey) {
        throw new Error('BeSeen authentication is not configured.');
      }
      const remember = localStorage.getItem('beseen_remember_me') === '1';
      const store = remember ? localStorage : sessionStorage;
      return createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: {
            getItem: key => store.getItem(key),
            setItem: (key, value) => store.setItem(key, value),
            removeItem: key => store.removeItem(key)
          }
        }
      });
    })();
    return clientPromise;
  }

  function isCreateButton(target) {
    const button = target?.closest?.('button');
    if (!button) return null;
    if (button.id === 'bsauthFakeCreate') return button;
    const form = document.getElementById('bsauthCreateForm');
    if (!form || !form.contains(button)) return null;
    return /create account|sign up|register/i.test(button.textContent || '') ? button : null;
  }

  async function handleCreate(button) {
    if (busy) return;
    const full_name = document.getElementById('bsauthCreateName')?.value?.trim() || '';
    const email = document.getElementById('bsauthCreateEmail')?.value?.trim() || '';
    const password = document.getElementById('bsauthCreatePassword')?.value || '';
    const referral_code = document.getElementById('bsauthReferralCode')?.value?.trim() || '';
    const remember = !!document.getElementById('bsauthRememberCreate')?.checked;

    if (!email || password.length < 8) {
      setFeedback('Use a valid email and a password with at least 8 characters.');
      return;
    }

    busy = true;
    if (button) button.disabled = true;
    setFeedback('Creating your account…');

    try {
      if (remember) localStorage.setItem('beseen_remember_me', '1');
      else localStorage.removeItem('beseen_remember_me');
      clientPromise = null;

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
      setFeedback('Account created. Verify your email to continue.');
      showSuccess(email);
    } catch (error) {
      setFeedback(error?.message || 'Could not create your account.');
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  }

  document.addEventListener('click', event => {
    const button = isCreateButton(event.target);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    handleCreate(button);
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const form = document.getElementById('bsauthCreateForm');
    if (!form || !form.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    handleCreate(document.getElementById('bsauthFakeCreate'));
  }, true);
})();
