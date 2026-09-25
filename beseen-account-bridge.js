(() => {
  const ACCOUNT_URL = '/account.html';
  const OWNER_BILLING_URL = '/owner-billing.html';

  function role() {
    return String(window.__beseenCurrentRole || 'guest').toLowerCase();
  }

  function isSignedIn() {
    return role() !== 'guest' && role() !== '';
  }

  function syncNav() {
    const nav = document.getElementById('navSignIn');

    if (nav) {
      nav.textContent = isSignedIn() ? 'My Account' : 'Sign In';
      nav.setAttribute(
        'aria-label',
        isSignedIn() ? 'Open My Account' : 'Sign In'
      );
    }

    const bar = document.getElementById('bsAccountBar');

    if (bar && isSignedIn() && !document.getElementById('bsMyAccount')) {
      const btn = document.createElement('button');

      btn.className = 'bs-account-btn';
      btn.id = 'bsMyAccount';
      btn.type = 'button';
      btn.textContent = 'My Account';

      btn.addEventListener('click', () => {
        window.location.href = ACCOUNT_URL;
      });

      const signOut = document.getElementById('bsChangeAccount');

      if (signOut) {
        bar.insertBefore(btn, signOut);
      } else {
        bar.appendChild(btn);
      }
    }

    if (
      bar &&
      role() === 'owner' &&
      !document.getElementById('bsOwnerBilling')
    ) {
      const billingBtn = document.createElement('button');

      billingBtn.className = 'bs-account-btn';
      billingBtn.id = 'bsOwnerBilling';
      billingBtn.type = 'button';
      billingBtn.textContent = 'Billing Control';

      billingBtn.addEventListener('click', () => {
        window.location.href = OWNER_BILLING_URL;
      });

      const signOut = document.getElementById('bsChangeAccount');

      if (signOut) {
        bar.insertBefore(billingBtn, signOut);
      } else {
        bar.appendChild(billingBtn);
      }
    }
  }

  document.addEventListener(
    'click',
    (event) => {
      const nav = event.target.closest?.('#navSignIn');

      if (nav && isSignedIn()) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        window.location.href = ACCOUNT_URL;
      }
    },
    true
  );

  function maybeOpenAddLocation() {
    const params = new URLSearchParams(window.location.search);

    if (params.get('add_location') !== '1') return;

    let attempts = 0;

    const timer = setInterval(() => {
      attempts++;

      const btn = document.querySelector('.multi-location-open');

      if (btn) {
        clearInterval(timer);

        btn.click();

        history.replaceState(
          {},
          '',
          window.location.pathname + window.location.hash
        );
      } else if (attempts > 30) {
        clearInterval(timer);
      }
    }, 250);
  }

  const timer = setInterval(syncNav, 350);

  setTimeout(() => {
    clearInterval(timer);
  }, 20000);

  window.addEventListener('load', () => {
    syncNav();
    maybeOpenAddLocation();
  });

  const authWait = setInterval(() => {
    const client = window.__beseenSupabaseClient;

    if (!client?.auth) return;

    clearInterval(authWait);

    client.auth.onAuthStateChange(() => {
      setTimeout(syncNav, 0);
    });
  }, 250);

  setTimeout(() => {
    clearInterval(authWait);
  }, 15000);
})();
