(() => {
  if (window.__beseenSignupVerifyBridgeInstalled) return;
  window.__beseenSignupVerifyBridgeInstalled = true;

  const originalFetch = window.fetch.bind(window);

  function isSignupRequest(url, init) {
    try {
      const method = String(init?.method || (url instanceof Request ? url.method : 'GET')).toUpperCase();
      const rawUrl = url instanceof Request ? url.url : String(url || '');
      return method === 'POST' && /\/auth\/v1\/signup(?:\?|$)/i.test(rawUrl);
    } catch {
      return false;
    }
  }

  function withRedirect(input, init) {
    const rawUrl = input instanceof Request ? input.url : String(input || '');
    const url = new URL(rawUrl, window.location.href);
    url.searchParams.set('redirect_to', `${window.location.origin}/verify-email.html`);

    if (input instanceof Request) {
      return [new Request(url.toString(), input), init];
    }

    return [url.toString(), init];
  }

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
      .bs-signup-success-btn{border:0;border-radius:13px;padding:12px 16px;font:inherit;font-weight:850;cursor:pointer;text-decoration:none}.bs-signup-success-primary{background:#1877ff;color:#fff}.bs-signup-success-light{background:#fff;color:#10213f;border:1px solid #dfe7f3}
      @keyframes bsSignupPop{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:none}}@keyframes bsSignupCheck{0%{transform:scale(.5);opacity:0}70%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
    `;
    document.head.appendChild(style);
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
        <p>We sent a verification email to finish setting up your BeSeen account.</p>
        ${email ? `<div class="bs-signup-email">${email.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</div>` : ''}
        <div class="bs-signup-success-note">Open the email and press the verification link. Once you verify, BeSeen will sign you in and bring you back to the website automatically.</div>
        <div class="bs-signup-success-actions">
          <button class="bs-signup-success-btn bs-signup-success-primary" type="button" id="bsSignupSuccessDone">Got it</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    document.getElementById('bsSignupSuccessDone')?.addEventListener('click', () => {
      overlay.remove();
    });
  }

  window.fetch = async function(input, init) {
    const signup = isSignupRequest(input, init);
    let requestInput = input;
    let requestInit = init;

    if (signup) {
      [requestInput, requestInit] = withRedirect(input, init);
    }

    const response = await originalFetch(requestInput, requestInit);

    if (signup && response.ok) {
      const email = document.getElementById('bsauthCreateEmail')?.value?.trim() || '';
      setTimeout(() => showSuccess(email), 120);
    }

    return response;
  };
})();
