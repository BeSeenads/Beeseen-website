(() => {
  if (window.__beseenSignupVerifyBridgeInstalled) return;
  window.__beseenSignupVerifyBridgeInstalled = true;

  let busy = false;
  let clientPromise = null;

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function ensureStyles() {
    if (document.getElementById('beseenSignupBridgeStyles')) return;

    const style = document.createElement('style');
    style.id = 'beseenSignupBridgeStyles';

    style.textContent = `
      #bsauthGate{
        overflow-y:auto !important;
        align-items:flex-start !important;
        justify-content:center !important;
        padding:24px 12px !important;
      }

      #bsauthGate > *{
        margin:auto !important;
        max-height:none !important;
        overflow:visible !important;
      }

      #bsauthCreateForm,
      #bsauthLoginForm{
        padding-bottom:32px !important;
      }

      .bs-signup-overlay{
        position:fixed;
        inset:0;
        z-index:999999;
        display:grid;
        place-items:center;
        padding:22px;
        background:rgba(3,12,31,.82);
        backdrop-filter:blur(12px);
        -webkit-backdrop-filter:blur(12px);
      }

      .bs-signup-card{
        width:min(520px,100%);
        background:#fff;
        border-radius:28px;
        padding:38px 30px;
        text-align:center;
        box-shadow:0 35px 110px rgba(0,0,0,.45);
        animation:bsPop .3s ease;
      }

      .bs-signup-logo{
        font-size:30px;
        font-weight:950;
        letter-spacing:-.06em;
        margin-bottom:22px;
      }

      .bs-signup-logo .be{color:#ed334f}
      .bs-signup-logo .seen{color:#1877ff}

      .bs-spinner{
        width:64px;
        height:64px;
        border:6px solid #dce8fb;
        border-top-color:#1877ff;
        border-radius:50%;
        margin:0 auto 20px;
        animation:bsSpin .75s linear infinite;
      }

      .bs-check{
        width:82px;
        height:82px;
        border-radius:50%;
        margin:0 auto 18px;
        display:grid;
        place-items:center;
        background:#e8f8ef;
        color:#138a55;
        font-size:42px;
        font-weight:950;
      }

      .bs-signup-card h2{
        margin:0 0 10px;
        color:#10213f;
        font-size:30px;
      }

      .bs-signup-card p{
        margin:0 auto;
        color:#6f7f9b;
        line-height:1.6;
        font-weight:650;
        max-width:420px;
      }

      .bs-signup-email{
        margin:18px auto 0;
        padding:11px 14px;
        border-radius:12px;
        background:#f5f8fd;
        border:1px solid #dfe7f3;
        color:#10213f;
        font-weight:850;
        word-break:break-word;
      }

      .bs-signup-btn{
        margin-top:22px;
        border:0;
        border-radius:13px;
        padding:12px 18px;
        background:#1877ff;
        color:white;
        font-weight:850;
        cursor:pointer;
      }

      .beseen-google-btn{
        width:100%;
        padding:13px 16px;
        margin:0 0 18px;
        border:1px solid #d8e0ed;
        border-radius:12px;
        background:white;
        color:#17233c;
        font-weight:850;
        font-size:15px;
        cursor:pointer;
        display:flex;
        align-items:center;
        justify-content:center;
        gap:10px;
      }

      .beseen-google-btn:hover{
        background:#f7f9fd;
      }

      @keyframes bsSpin{
        to{transform:rotate(360deg)}
      }

      @keyframes bsPop{
        from{opacity:0;transform:translateY(15px) scale(.97)}
        to{opacity:1;transform:none}
      }
    `;

    document.head.appendChild(style);
  }

  function removeOverlay() {
    document.getElementById('beseenSignupOverlay')?.remove();
  }

  function showCreating() {
    ensureStyles();
    removeOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'beseenSignupOverlay';
    overlay.className = 'bs-signup-overlay';

    overlay.innerHTML = `
      <div class="bs-signup-card">
        <div class="bs-signup-logo">
          <span class="be">Be</span><span class="seen">Seen</span>
        </div>

        <div class="bs-spinner"></div>

        <h2>Creating your account...</h2>

        <p>
          Just a second while we set up your BeSeen account.
        </p>
      </div>
    `;

    document.body.appendChild(overlay);
  }

  function showSuccess(email) {
    ensureStyles();
    removeOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'beseenSignupOverlay';
    overlay.className = 'bs-signup-overlay';

    overlay.innerHTML = `
      <div class="bs-signup-card">
        <div class="bs-signup-logo">
          <span class="be">Be</span><span class="seen">Seen</span>
        </div>

        <div class="bs-check">✓</div>

        <h2>Account created!</h2>

        <p>
          Verify your email to continue using your BeSeen account.
        </p>

        ${
          email
            ? `<div class="bs-signup-email">${escapeHtml(email)}</div>`
            : ''
        }

        <p style="margin-top:18px;font-size:13px">
          Check your inbox and click the verification link.
          Once verified, you'll return to BeSeen.
        </p>

        <button
          class="bs-signup-btn"
          type="button"
          id="bsSignupDone"
        >
          Got it
        </button>
      </div>
    `;

    document.body.appendChild(overlay);

    document
      .getElementById('bsSignupDone')
      ?.addEventListener('click', removeOverlay);
  }

  function showError(message) {
    removeOverlay();
    alert(message || 'Could not create your account.');
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

      const remember =
        localStorage.getItem('beseen_remember_me') === '1';

      const store = remember
        ? localStorage
        : sessionStorage;

      return createClient(
        cfg.supabaseUrl,
        cfg.supabasePublishableKey,
        {
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
        }
      );
    })();

    return clientPromise;
  }

  async function createAccount() {
    if (busy) return;

    const full_name =
      document.getElementById('bsauthCreateName')
        ?.value?.trim() || '';

    const email =
      document.getElementById('bsauthCreateEmail')
        ?.value?.trim() || '';

    const password =
      document.getElementById('bsauthCreatePassword')
        ?.value || '';

    const referral_code =
      document.getElementById('bsauthReferralCode')
        ?.value?.trim() || '';

    const remember =
      !!document.getElementById('bsauthRememberCreate')
        ?.checked;

    if (!email) {
      alert('Enter your email.');
      return;
    }

    if (password.length < 8) {
      alert('Password must be at least 8 characters.');
      return;
    }

    busy = true;

    // THIS HAPPENS IMMEDIATELY WHEN THEY CLICK
    showCreating();

    try {
      if (remember) {
        localStorage.setItem('beseen_remember_me', '1');
      } else {
        localStorage.removeItem('beseen_remember_me');
      }

      clientPromise = null;

      const supabase = await getClient();

      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo:
            `${window.location.origin}/verify-email.html`,
          data: {
            full_name,
            referral_code,
            referred_by_code: referral_code
          }
        }
      });

      if (error) throw error;

      showSuccess(email);

    } catch (error) {
      showError(error?.message);

    } finally {
      busy = false;
    }
  }

  async function signInWithGoogle() {
    try {
      const supabase = await getClient();

      const { error } =
        await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: `${window.location.origin}/`
          }
        });

      if (error) throw error;

    } catch (error) {
      alert(error?.message || 'Google sign in failed.');
    }
  }

  function connectCreateButton() {
    const button =
      document.getElementById('bsauthFakeCreate');

    if (!button || button.dataset.beseenConnected) return;

    button.dataset.beseenConnected = '1';

    button.addEventListener(
      'click',
      event => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        createAccount();
      },
      true
    );
  }

  function addGoogleButtons() {
    ['bsauthLoginForm', 'bsauthCreateForm']
      .forEach(id => {

        const form = document.getElementById(id);

        if (
          !form ||
          form.querySelector('.beseen-google-btn')
        ) {
          return;
        }

        const button =
          document.createElement('button');

        button.type = 'button';
        button.className = 'beseen-google-btn';

        button.innerHTML = `
          <span style="
            width:22px;
            height:22px;
            display:grid;
            place-items:center;
            border-radius:50%;
            border:1px solid #ddd;
            font-weight:900;
          ">G</span>

          Continue with Google
        `;

        button.addEventListener(
          'click',
          signInWithGoogle
        );

        form.insertBefore(
          button,
          form.firstChild
        );
      });
  }

  ensureStyles();

  const timer = setInterval(() => {
    connectCreateButton();
    addGoogleButtons();
  }, 200);

  setTimeout(() => {
    clearInterval(timer);
  }, 20000);

})();
