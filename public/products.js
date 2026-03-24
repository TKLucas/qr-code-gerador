const productList = document.querySelector('#product-list');
const productSearchInput = document.querySelector('#product-search-input');
const listCount = document.querySelector('#list-count');
const emptyList = document.querySelector('#empty-list');
const listStatus = document.querySelector('#list-status');
const apiFetch = window.adminSession?.fetch?.bind(window.adminSession) || window.fetch.bind(window);

let products = [];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setListStatus(text, variant = '') {
  listStatus.textContent = text;
  listStatus.className = 'helper-text';
  if (variant) {
    listStatus.classList.add(variant);
  }
}

function formatMessagePreview(value = '') {
  return escapeHtml(value).replaceAll('\n', '<br />');
}

function getCardTemplate(item) {
  return `
    <article class="product-card">
      <div class="product-card-image-shell">
        <img class="product-card-image" src="${item.productImagePath}" alt="Foto do produto ${escapeHtml(item.title)}" />
      </div>

      <div class="product-card-copy">
        <div class="product-card-header">
          <div class="product-card-heading">
            <span class="product-date">${new Date(item.createdAt).toLocaleString('pt-BR')}</span>
            <h3>${escapeHtml(item.title)}</h3>
            <p class="product-card-message">${formatMessagePreview(item.rewardMessage || 'Você ganhou este produto.')}</p>
          </div>
          <div class="product-card-chips">
            <span class="product-chip">${escapeHtml(item.artTemplate?.name || 'Sem arte')}</span>
            <span class="product-chip qr-color-meta">
              <span class="qr-color-swatch" style="--qr-color: ${escapeHtml(item.qrDarkColor || '#18181b')}"></span>
              <span>${escapeHtml(item.qrDarkColor || '#18181b')}</span>
            </span>
          </div>
        </div>

        <div class="product-link-panel">
          <span class="product-link-label">Link final</span>
          <a class="product-link-anchor" href="${item.finalUrl}" target="_blank" rel="noreferrer">${item.finalUrl}</a>
        </div>
      </div>

      <div class="product-card-actions">
        <a class="secondary-button button-link" href="/?edit=${encodeURIComponent(item.slug)}">Editar</a>
        <button type="button" class="secondary-button" data-action="copy-final-link" data-url="${item.finalUrl}">Copiar link</button>
        <a class="secondary-button button-link" href="${item.finalUrl}" target="_blank" rel="noreferrer">Abrir link</a>
        <a class="secondary-button button-link" href="${item.artUrl}" target="_blank" rel="noreferrer">Abrir arte</a>
        <a class="secondary-button button-link" href="${item.qrCode.transparentPng}">Baixar QR transparente</a>
      </div>
    </article>
  `;
}

function getFilteredProducts() {
  const query = productSearchInput.value.trim().toLowerCase();

  if (!query) {
    return products;
  }

  return products.filter((item) => {
    const haystack = [
      item.title,
      item.rewardMessage,
      item.finalUrl,
      item.artTemplate?.name,
      item.slug,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  });
}

function renderProducts() {
  const filteredItems = getFilteredProducts();
  const hasQuery = productSearchInput.value.trim().length > 0;

  listCount.textContent = hasQuery
    ? `${filteredItems.length} de ${products.length} itens`
    : `${filteredItems.length} ${filteredItems.length === 1 ? 'item' : 'itens'}`;

  emptyList.hidden = filteredItems.length > 0;
  emptyList.textContent = hasQuery
    ? 'Nenhum produto encontrado para essa busca.'
    : 'Nenhum produto cadastrado ainda.';
  productList.innerHTML = filteredItems.map(getCardTemplate).join('');
}

async function loadProducts() {
  setListStatus('Carregando produtos salvos...');

  try {
    const response = await apiFetch('/api/products');
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Falha ao carregar os produtos.');
    }

    products = Array.isArray(payload.items) ? payload.items : [];
    renderProducts();
    setListStatus('A lista abaixo mostra os itens mais recentes primeiro.');
  } catch (error) {
    products = [];
    productList.innerHTML = '';
    emptyList.hidden = false;
    emptyList.textContent = error.message;
    setListStatus(error.message, 'is-error');
  }
}

productList.addEventListener('click', async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement) || target.dataset.action !== 'copy-final-link') {
    return;
  }

  try {
    await navigator.clipboard.writeText(target.dataset.url || '');
    target.textContent = 'Link copiado';
    window.setTimeout(() => {
      target.textContent = 'Copiar link';
    }, 1200);
  } catch {
    setListStatus('Não foi possível copiar o link.', 'is-error');
  }
});

productSearchInput.addEventListener('input', renderProducts);

loadProducts();
