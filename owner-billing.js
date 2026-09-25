(() => {
  const STYLE_ID = 'beseen-owner-billing-style';
  let billingClient = null;
  let billingSession = null;
  let billingProfile = null;
  let ownerData = [];
  let publicLocations = [];
  let lastSwitchUrl = '';
  let patchTimer = null;

  function storageAdapter() {
    const useLocal = localStorage.getItem('beseen_remember_me') === '1';
    const store = useLocal ? localStorage : sessionStorage;
    return {
      getItem: key => store.getItem(key),
      setItem: (key, value) => store.setItem(key, value),
      removeItem: key => store.removeItem(key)
    };
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  function money(cents) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2
    }).format((Number(cents) || 0) / 100);
  }

  function dateText(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function toast(message) {
    const existing = document.getElementById('toast');
    if (existing) {
      existing.textContent = message;
      existing.classList.add('show');
      setTimeout(() => existing.classList.remove('show'), 2800);
      return;
    }
    alert(message);
  }

  async function copy(text, label = 'Copied') {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(label);
    } catch {
      window.prompt('Copy this link:', text);
    }
  }

  async function ownerRequest(method = 'GET', body = null) {
    const response = await fetch('/api/admin-accounts', {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${billingSession.access_token}`
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store'
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Owner billing request failed.');
    }
    return data;
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .owner-billing-shell{background:#fff;border:1px solid var(--line);border-radius:22px;padding:20px;box-shadow:0 12px 30px #071b440a}
      .owner-billing-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(280px,.85fr);gap:16px}
      .owner-billing-panel{border:1px solid var(--line);border-radius:18px;padding:16px;background:#fbfcff}
      .owner-billing-panel h3{margin:0 0 4px;font-size:18px}
      .owner-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
      .owner-form-grid .wide{grid-column:1/-1}
      .owner-form-grid label{display:block;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:#667892;margin:0 0 6px}
      .owner-form-grid input,.owner-form-grid select,.owner-form-grid textarea{width:100%;border:1px solid #cad6e7;border-radius:11px;padding:10px 11px;background:#fff;color:var(--ink)}
      .owner-form-grid textarea{min-height:72px;resize:vertical}
      .owner-summary{display:grid;gap:8px;margin-top:14px}
      .owner-summary .stat{margin:0}
      .owner-billing-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
      .owner-billing-actions .btn{font-size:12px;padding:10px 12px}
      .owner-switch-box{display:none;margin-top:14px;padding:13px;border-radius:14px;background:#edf5ff;border:1px solid #cfe1ff}
      .owner-switch-box.show{display:block}
      .owner-switch-url{font-size:11px;word-break:break-all;color:#3b5476;margin-top:7px}
      .owner-override-list{display:grid;gap:9px;margin-top:14px}
      .owner-override-row{display:grid;grid-template-columns:1.2fr 1fr .8fr .8fr .9fr;gap:10px;align-items:center;border:1px solid #e7edf6;border-radius:14px;padding:11px;background:#fff;font-size:12px}
      .owner-override-row strong{display:block}
      .owner-mini{color:var(--muted);font-size:11px;margin-top:2px}
      .custom-rate-note{margin-top:9px;padding:9px 11px;border-radius:12px;background:#edf5ff;border:1px solid #d5e5ff;color:#185daf;font-size:12px;font-weight:800}
      @media(max-width:850px){.owner-billing-grid{grid-template-columns:1fr}.owner-override-row{grid-template-columns:1fr 1fr}.owner-form-grid{grid-template-columns:1fr}.owner-form-grid .wide{grid-column:auto}}
    `;
    document.head.appendChild(style);
  }

  async function loadPublicLocations() {
    const data = await fetch('/api/locations', { cache: 'no-store' })
      .then(response => response.json())
      .catch(() => ({ locations: [] }));
    publicLocations = data.locations || [];
  }

  function accountById(id) {
    return ownerData.find(account => account.id === id) || null;
  }

  function locationBySlug(slug) {
    return publicLocations.find(location => location.slug === slug) || null;
  }

  function activeRow(account, slug) {
    return (account?.advertising_locations || []).find(row =>
      row.location_slug === slug &&
      ['active', 'trialing', 'past_due'].includes(String(row.status || '').toLowerCase())
    ) || null;
  }

  function overrideRow(account, slug) {
    return (account?.billing_overrides || []).find(row => row.location_slug === slug) || null;
  }

  function standardCents(location, plan) {
    return Number(location?.[`${plan}_price_cents`] || 0);
  }

  function injectOwnerSection() {
    if (document.getElementById('ownerBillingSection')) return;
    const ownerSection = document.getElementById('ownerSection');
    if (!ownerSection) return;

    const section = document.createElement('section');
    section.className = 'section';
    section.id = 'ownerBillingSection';
    section.innerHTML = `
      <div class="sectionhead">
        <div>
          <h2>Owner Billing Control</h2>
          <p>Set special monthly rates or move Zelle/offline customers onto automatic Stripe billing without changing their plan access.</p>
        </div>
      </div>
      <div class="owner-billing-shell">
        <div class="owner-billing-grid">
          <div class="owner-billing-panel">
            <h3>Customer Billing Override</h3>
            <div class="subtle">Only your Owner account can change these settings.</div>
            <div class="owner-form-grid">
              <div class="wide">
                <label>Customer</label>
                <select id="ownerBillingCustomer"></select>
              </div>
              <div>
                <label>Advertising Location</label>
                <select id="ownerBillingLocation"></select>
              </div>
              <div>
                <label>Plan</label>
                <select id="ownerBillingPlan">
                  <option value="gold">Gold</option>
                  <option value="premium">Premium</option>
                  <option value="platinum">Platinum</option>
                </select>
              </div>
              <div>
                <label>Custom Monthly Price</label>
                <input id="ownerBillingPrice" type="number" min="1" step="0.01" placeholder="150.00">
              </div>
              <div>
                <label>Current Payment Source</label>
                <select id="ownerBillingSource">
                  <option value="stripe">Stripe</option>
                  <option value="zelle">Zelle</option>
                  <option value="cash">Cash</option>
                  <option value="check">Check</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label>Paid Through</label>
                <input id="ownerBillingPaidThrough" type="date">
              </div>
              <div>
                <label>Next Stripe Charge</label>
                <input id="ownerBillingNextCharge" type="date">
              </div>
              <div class="wide">
                <label>Owner Note</label>
                <textarea id="ownerBillingNote" placeholder="Example: Long-time customer — locked at $150/month."></textarea>
              </div>
            </div>
            <div class="owner-billing-actions">
              <button class="btn btn-primary" id="ownerSetCustomPrice">Set Custom Price</button>
              <button class="btn btn-light" id="ownerRestorePrice">Restore Standard Price</button>
              <button class="btn btn-dark" id="ownerCreateSwitchLink">Create Stripe Switch Link</button>
            </div>
            <div class="owner-switch-box" id="ownerSwitchBox">
              <strong>Stripe switch link ready</strong>
              <div class="owner-switch-url" id="ownerSwitchUrl"></div>
              <div class="owner-billing-actions"><button class="btn btn-light" id="ownerCopySwitchLink">Copy Link</button><a class="btn btn-light" id="ownerOpenSwitchLink" target="_blank" rel="noopener">Open Link</a></div>
            </div>
          </div>
          <div class="owner-billing-panel">
            <h3>Selected Customer</h3>
            <div class="subtle" id="ownerBillingCustomerMeta">Choose a customer.</div>
            <div class="owner-summary">
              <div class="stat"><small>Plan</small><strong id="ownerSummaryPlan">—</strong></div>
              <div class="stat"><small>Standard Rate</small><strong id="ownerSummaryStandard">—</strong></div>
              <div class="stat"><small>Current / Custom Rate</small><strong id="ownerSummaryCurrent">—</strong></div>
              <div class="stat"><small>Payment Source</small><strong id="ownerSummarySource">—</strong></div>
              <div class="stat"><small>Next Charge</small><strong id="ownerSummaryNext">—</strong></div>
              <div class="stat"><small>Migration Status</small><strong id="ownerSummaryMigration">—</strong></div>
            </div>
          </div>
        </div>
        <div style="margin-top:20px">
          <div class="subtle" style="font-weight:900;text-transform:uppercase;letter-spacing:.08em">Special Billing Records</div>
          <div class="owner-override-list" id="ownerOverrideList"></div>
        </div>
      </div>
    `;

    ownerSection.parentNode.insertBefore(section, ownerSection);
  }

  function populateCustomers() {
    const select = document.getElementById('ownerBillingCustomer');
    if (!select) return;
    const old = select.value;
    const accounts = ownerData
      .filter(account => !account.primary_owner)
      .sort((a, b) => String(a.full_name || a.email || '').localeCompare(String(b.full_name || b.email || '')));

    select.innerHTML = accounts.map(account =>
      `<option value="${esc(account.id)}">${esc(account.full_name || account.email || 'Customer')} — ${esc(account.email || '')}</option>`
    ).join('');

    if (accounts.some(account => account.id === old)) select.value = old;
  }

  function populateLocations() {
    const select = document.getElementById('ownerBillingLocation');
    if (!select) return;
    const old = select.value;
    select.innerHTML = publicLocations.map(location =>
      `<option value="${esc(location.slug)}">${esc(location.name)}${location.city ? ` — ${esc(location.city)}` : ''}</option>`
    ).join('');
    if (publicLocations.some(location => location.slug === old)) select.value = old;
  }

  function deriveMigrationStatus(account, slug, override, row) {
    if (row && ['active', 'trialing', 'past_due'].includes(String(row.status || '').toLowerCase())) {
      if (override?.billing_source && override.billing_source !== 'stripe') return 'Scheduled / On Stripe';
      return override?.migration_status || 'Active';
    }
    return override?.migration_status || 'None';
  }

  function updateSummary() {
    const userId = document.getElementById('ownerBillingCustomer')?.value;
    const slug = document.getElementById('ownerBillingLocation')?.value;
    const account = accountById(userId);
    const location = locationBySlug(slug);
    if (!account || !location) return;

    const row = activeRow(account, slug);
    const override = overrideRow(account, slug);
    const plan = String(row?.plan || override?.plan || document.getElementById('ownerBillingPlan')?.value || 'gold').toLowerCase();
    const standard = Number(override?.standard_price_cents || standardCents(location, plan));
    const current = override?.custom_price_active
      ? Number(override.custom_price_cents || 0)
      : Number(row?.billed_price_cents ?? standard);
    const source = override?.billing_source || row?.billing_source || 'stripe';
    const next = override?.next_charge_at || row?.next_charge_at || row?.current_period_end || null;

    document.getElementById('ownerBillingCustomerMeta').textContent = `${account.full_name || 'Customer'} • ${account.email || ''}`;
    document.getElementById('ownerSummaryPlan').textContent = plan.toUpperCase();
    document.getElementById('ownerSummaryStandard').textContent = `${money(standard)}/mo`;
    document.getElementById('ownerSummaryCurrent').textContent = `${money(current)}/mo${override?.custom_price_active ? ' • Custom' : ''}`;
    document.getElementById('ownerSummarySource').textContent = String(source || 'stripe').toUpperCase();
    document.getElementById('ownerSummaryNext').textContent = dateText(next);
    document.getElementById('ownerSummaryMigration').textContent = deriveMigrationStatus(account, slug, override, row);

    document.getElementById('ownerBillingPlan').value = plan;
    document.getElementById('ownerBillingSource').value = ['stripe', 'zelle', 'cash', 'check', 'other'].includes(source) ? source : 'stripe';
    document.getElementById('ownerBillingPrice').value = override?.custom_price_active && override.custom_price_cents != null
      ? (Number(override.custom_price_cents) / 100).toFixed(2)
      : '';
    document.getElementById('ownerBillingNote').value = override?.owner_note || '';

    if (override?.paid_through) {
      document.getElementById('ownerBillingPaidThrough').value = new Date(override.paid_through).toISOString().slice(0, 10);
    }
    if (next) {
      document.getElementById('ownerBillingNextCharge').value = new Date(next).toISOString().slice(0, 10);
    }
  }

  function renderOverrideList() {
    const holder = document.getElementById('ownerOverrideList');
    if (!holder) return;
    const records = [];
    for (const account of ownerData) {
      for (const override of account.billing_overrides || []) {
        const row = activeRow(account, override.location_slug);
        records.push({ account, override, row });
      }
    }

    if (!records.length) {
      holder.innerHTML = '<div class="empty" style="padding:18px">No custom prices or offline billing migrations yet.</div>';
      return;
    }

    holder.innerHTML = records.map(({ account, override, row }) => {
      const location = locationBySlug(override.location_slug) || {};
      const current = override.custom_price_active
        ? override.custom_price_cents
        : row?.billed_price_cents ?? override.standard_price_cents;
      return `<div class="owner-override-row">
        <div><strong>${esc(account.full_name || 'Customer')}</strong><div class="owner-mini">${esc(account.email || '')}</div></div>
        <div><strong>${esc(location.name || override.location_slug)}</strong><div class="owner-mini">${esc(String(override.plan || '').toUpperCase())}</div></div>
        <div><strong>${money(current)}/mo</strong><div class="owner-mini">${override.custom_price_active ? 'Custom rate' : 'Standard rate'}</div></div>
        <div><strong>${esc(String(override.billing_source || 'stripe').toUpperCase())}</strong><div class="owner-mini">${esc(deriveMigrationStatus(account, override.location_slug, override, row))}</div></div>
        <div><strong>${dateText(override.next_charge_at || row?.current_period_end)}</strong><div class="owner-mini">Next charge</div></div>
      </div>`;
    }).join('');
  }

  async function refreshOwnerData() {
    const data = await ownerRequest('GET');
    ownerData = data.accounts || [];
    populateCustomers();
    populateLocations();
    updateSummary();
    renderOverrideList();
  }

  function selectedPayload() {
    const userId = document.getElementById('ownerBillingCustomer')?.value || '';
    const locationSlug = document.getElementById('ownerBillingLocation')?.value || '';
    const plan = document.getElementById('ownerBillingPlan')?.value || 'gold';
    const priceText = document.getElementById('ownerBillingPrice')?.value.trim() || '';
    const customPriceCents = priceText === '' ? null : Math.round(Number(priceText) * 100);
    const billingSource = document.getElementById('ownerBillingSource')?.value || 'stripe';
    const paidThrough = document.getElementById('ownerBillingPaidThrough')?.value || null;
    const nextDate = document.getElementById('ownerBillingNextCharge')?.value || '';
    const nextChargeAt = nextDate ? `${nextDate}T12:00:00` : null;
    const ownerNote = document.getElementById('ownerBillingNote')?.value || '';
    return { userId, locationSlug, plan, customPriceCents, billingSource, paidThrough, nextChargeAt, ownerNote };
  }

  function bindOwnerControls() {
    const customer = document.getElementById('ownerBillingCustomer');
    const location = document.getElementById('ownerBillingLocation');
    const plan = document.getElementById('ownerBillingPlan');
    if (!customer || !location || !plan) return;

    customer.addEventListener('change', updateSummary);
    location.addEventListener('change', updateSummary);
    plan.addEventListener('change', updateSummary);

    document.getElementById('ownerSetCustomPrice').addEventListener('click', async event => {
      const button = event.currentTarget;
      const payload = selectedPayload();
      if (!payload.customPriceCents || payload.customPriceCents < 100) {
        toast('Enter the custom monthly price first.');
        return;
      }
      try {
        button.disabled = true;
        await ownerRequest('PATCH', {
          action: 'set_custom_price',
          userId: payload.userId,
          locationSlug: payload.locationSlug,
          customPriceCents: payload.customPriceCents,
          ownerNote: payload.ownerNote
        });
        toast('Custom price saved for the next billing cycle.');
        await refreshOwnerData();
        await applyCustomerOverrides();
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    });

    document.getElementById('ownerRestorePrice').addEventListener('click', async event => {
      const button = event.currentTarget;
      const payload = selectedPayload();
      if (!confirm('Restore this customer to the normal BeSeen plan price?')) return;
      try {
        button.disabled = true;
        await ownerRequest('PATCH', {
          action: 'restore_standard_price',
          userId: payload.userId,
          locationSlug: payload.locationSlug,
          ownerNote: payload.ownerNote
        });
        toast('Standard price restored for the next billing cycle.');
        await refreshOwnerData();
        await applyCustomerOverrides();
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    });

    document.getElementById('ownerCreateSwitchLink').addEventListener('click', async event => {
      const button = event.currentTarget;
      const payload = selectedPayload();
      if (payload.billingSource === 'stripe') {
        toast('Choose Zelle, cash, check or other for an offline migration.');
        return;
      }
      if (!payload.nextChargeAt) {
        toast('Choose the first Stripe charge date.');
        return;
      }
      try {
        button.disabled = true;
        const data = await ownerRequest('PATCH', {
          action: 'create_offline_migration',
          ...payload
        });
        lastSwitchUrl = data.url || '';
        const box = document.getElementById('ownerSwitchBox');
        document.getElementById('ownerSwitchUrl').textContent = lastSwitchUrl;
        document.getElementById('ownerOpenSwitchLink').href = lastSwitchUrl;
        box.classList.toggle('show', !!lastSwitchUrl);
        toast('Stripe switch link created.');
        await refreshOwnerData();
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    });

    document.getElementById('ownerCopySwitchLink').addEventListener('click', () => copy(lastSwitchUrl, 'Switch link copied'));
  }

  async function applyCustomerOverrides() {
    if (!billingClient || !billingSession) return;

    const [{ data: overrides }, { data: subs }] = await Promise.all([
      billingClient
        .from('billing_overrides')
        .select('location_slug,plan,standard_price_cents,custom_price_cents,custom_price_active,billing_source,paid_through,next_charge_at,migration_status')
        .eq('user_id', billingSession.user.id),
      billingClient
        .from('subscription_locations')
        .select('id,location_slug')
        .eq('user_id', billingSession.user.id)
    ]);

    const bySlug = new Map((overrides || []).map(row => [row.location_slug, row]));
    const subMap = new Map((subs || []).map(row => [row.id, row.location_slug]));

    document.querySelectorAll('#locationCards article[data-row]').forEach(card => {
      const slug = subMap.get(card.dataset.row);
      const override = bySlug.get(slug);
      if (!override) return;

      const pills = card.querySelector('.pills');
      if (override.custom_price_active && pills && !card.querySelector('[data-custom-rate-pill]')) {
        const pill = document.createElement('span');
        pill.className = 'pill blue';
        pill.dataset.customRatePill = '1';
        pill.textContent = 'Custom Rate';
        pills.appendChild(pill);
      }

      if (override.custom_price_active) {
        const price = card.querySelector('.price');
        if (price) price.innerHTML = `${money(override.custom_price_cents)} <span>/ month</span>`;
      }

      const stats = card.querySelectorAll('.grid2 .stat');
      if (override.next_charge_at && stats[0]) {
        const strong = stats[0].querySelector('strong');
        if (strong) strong.textContent = dateText(override.next_charge_at);
      }

      if (!card.querySelector('[data-custom-rate-note]') && (override.custom_price_active || override.billing_source !== 'stripe')) {
        const note = document.createElement('div');
        note.className = 'custom-rate-note';
        note.dataset.customRateNote = '1';
        const source = override.billing_source && override.billing_source !== 'stripe'
          ? ` • Migrated from ${String(override.billing_source).toUpperCase()}`
          : '';
        note.textContent = `${override.custom_price_active ? `Owner custom rate: ${money(override.custom_price_cents)}/month` : 'Special billing setup'}${source}`;
        const price = card.querySelector('.price');
        if (price) price.insertAdjacentElement('afterend', note);
      }
    });
  }

  function watchCustomerCards() {
    const holder = document.getElementById('locationCards');
    if (!holder) return;
    const observer = new MutationObserver(() => {
      clearTimeout(patchTimer);
      patchTimer = setTimeout(() => applyCustomerOverrides().catch(() => {}), 80);
    });
    observer.observe(holder, { childList: true, subtree: true });
  }

  async function init() {
    try {
      addStyles();

      const cfg = await fetch('/api/config', { cache: 'no-store' }).then(response => response.json());
      if (!cfg.supabaseUrl || !cfg.supabasePublishableKey || !window.supabase) return;

      billingClient = window.supabase.createClient(
        cfg.supabaseUrl,
        cfg.supabasePublishableKey,
        {
          auth: {
            persistSession: true,
            storage: storageAdapter(),
            autoRefreshToken: true,
            detectSessionInUrl: true
          }
        }
      );

      const sessionResult = await billingClient.auth.getSession();
      billingSession = sessionResult.data.session;
      if (!billingSession) return;

      const { data: ownProfile } = await billingClient
        .from('profiles')
        .select('id,email,full_name,role')
        .eq('id', billingSession.user.id)
        .single();

      billingProfile = ownProfile || null;
      watchCustomerCards();
      await applyCustomerOverrides();

      if (billingProfile?.role !== 'owner') return;

      injectOwnerSection();
      await loadPublicLocations();
      await refreshOwnerData();
      bindOwnerControls();
    } catch (error) {
      console.error('BeSeen owner billing UI error', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
