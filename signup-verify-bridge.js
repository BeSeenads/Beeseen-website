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
      setTimeout(() => {
        window.location.href = `/verify-email.html${email ? `?email=${encodeURIComponent(email)}` : ''}`;
      }, 80);
    }

    return response;
  };
})();
