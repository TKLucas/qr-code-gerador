const raffleForm = document.querySelector('#raffle-form');
const raffleNameInput = document.querySelector('#raffle-name-input');
const raffleSubmitButton = document.querySelector('#raffle-submit-button');
const raffleConfirmCreateButton = document.querySelector('#raffle-confirm-create-button');
const raffleFormStatus = document.querySelector('#raffle-form-status');
const raffleFormBadge = document.querySelector('#raffle-form-badge');
const raffleSelectionSummary = document.querySelector('#raffle-selection-summary');
const raffleSelectionStatus = document.querySelector('#raffle-selection-status');
const raffleSelectionList = document.querySelector('#raffle-product-selection');
const raffleSelectionEmpty = document.querySelector('#raffle-selection-empty');
const raffleSelectionModal = document.querySelector('#raffle-selection-modal');
const rafflePreviewBadge = document.querySelector('#raffle-preview-badge');
const rafflePreviewEmpty = document.querySelector('#raffle-preview-empty');
const rafflePreviewCard = document.querySelector('#raffle-preview-card');
const rafflePreviewImage = document.querySelector('#raffle-preview-image');
const rafflePreviewName = document.querySelector('#raffle-preview-name');
const rafflePreviewLink = document.querySelector('#raffle-preview-link');
const rafflePreviewOpenLink = document.querySelector('#raffle-preview-open-link');
const rafflePreviewDownloadLink = document.querySelector('#raffle-preview-download-link');
const rafflePreviewDeleteButton = document.querySelector('#raffle-preview-delete-button');
const rafflePreviewTotal = document.querySelector('#raffle-preview-total');
const rafflePreviewRemaining = document.querySelector('#raffle-preview-remaining');
const rafflePreviewProducts = document.querySelector('#raffle-preview-products');
const rafflePreviewProductChips = document.querySelector('#raffle-preview-product-chips');
const raffleList = document.querySelector('#raffle-list');
const raffleEmptyList = document.querySelector('#raffle-empty-list');
const raffleListCount = document.querySelector('#raffle-list-count');
const raffleListStatus = document.querySelector('#raffle-list-status');
const apiFetch = window.adminSession?.fetch?.bind(window.adminSession) || window.fetch.bind(window);

let raffles = [];
let availableProducts = [];
let selectedProductIds = new Set();
let hasInitializedSelection = false;
let createInFlight = false;

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setRaffleFormStatus(text, variant = '') {
  raffleFormStatus.textContent = text;
  raffleFormStatus.className = 'helper-text';
  raffleFormBadge.textContent = variant === 'is-loading' ? 'Criando' : variant === 'is-error' ? 'Erro' : 'Pronto';
  raffleFormBadge.className = 'status-badge';

  if (variant) {
    raffleFormStatus.classList.add(variant);
    raffleFormBadge.classList.add(variant);
  }
}

function setRaffleListStatus(text, variant = '') {
  raffleListStatus.textContent = text;
  raffleListStatus.className = 'helper-text';

  if (variant) {
    raffleListStatus.classList.add(variant);
  }
}

function getSelectedProductSummaries(products = []) {
  return Array.isArray(products)
    ? products.filter((item) => item?.id && item?.title)
    : [];
}

function getCurrentPreviewRaffleId() {
  return rafflePreviewCard.dataset.raffleId || '';
}

function getProductGroupMarkup(title, items, emptyText, raffleId, mode) {
  const hasItems = items.length > 0;
  const content = hasItems
    ? items.map((item) => {
      if (mode !== 'drawn') {
        return `<span class="raffle-selected-chip">${escapeHtml(item.title)}</span>`;
      }

      return `
        <button
          type="button"
          class="raffle-return-item"
          data-action="restore-product"
          data-raffle-id="${escapeHtml(raffleId)}"
          data-product-id="${escapeHtml(item.id)}"
          title="Devolver ${escapeHtml(item.title)} ao sorteio"
        >
          <span class="raffle-return-name">${escapeHtml(item.title)}</span>
          <span class="raffle-return-action">Devolver ao sorteio</span>
        </button>
      `;
    }).join('')
    : `<span class="raffle-selected-chip is-empty">${escapeHtml(emptyText)}</span>`;

  return `
    <div class="raffle-product-group">
      <span class="product-link-label">${title}</span>
      <div class="raffle-selected-chips ${mode === 'drawn' ? 'is-drawn-group' : ''}">
        ${content}
      </div>
    </div>
  `;
}

function getSelectedProductsPanel(data = {}, raffleId = '') {
  const items = getSelectedProductSummaries(data.selectedProducts);
  const drawnItems = getSelectedProductSummaries(
    Array.isArray(data.drawnProductsList) ? data.drawnProductsList : []
  );
  const availableItems = getSelectedProductSummaries(
    Array.isArray(data.availableProducts) ? data.availableProducts : []
  );

  if (!drawnItems.length && !availableItems.length) {
    const fallbackDrawn = items.filter((item) => item.isDrawn);
    const fallbackAvailable = items.filter((item) => !item.isDrawn);

    return [
      getProductGroupMarkup('Já sorteados', fallbackDrawn, 'Nenhum produto distribuído ainda', raffleId, 'drawn'),
      getProductGroupMarkup('Disponíveis', fallbackAvailable, 'Nenhum produto disponível', raffleId, 'available'),
    ].join('');
  }

  return [
    getProductGroupMarkup('Já sorteados', drawnItems, 'Nenhum produto distribuído ainda', raffleId, 'drawn'),
    getProductGroupMarkup('Disponíveis', availableItems, 'Nenhum produto disponível', raffleId, 'available'),
  ].join('');
}

function refreshSelectionSummary() {
  if (!availableProducts.length) {
    raffleSelectionSummary.textContent = 'Cadastre produtos antes de criar um sorteio.';
    raffleSelectionSummary.className = 'helper-text is-error';
    return;
  }

  raffleSelectionSummary.textContent = `${selectedProductIds.size} produto(s) pré-selecionado(s) para o próximo sorteio.`;
  raffleSelectionSummary.className = selectedProductIds.size ? 'helper-text is-ready' : 'helper-text';
}

function updateSelectionStatus() {
  if (!availableProducts.length) {
    raffleSelectionStatus.textContent = 'Cadastre produtos para montar um sorteio.';
    raffleSelectionStatus.className = 'helper-text is-error';
    raffleSubmitButton.disabled = true;
    raffleConfirmCreateButton.disabled = true;
    refreshSelectionSummary();
    return;
  }

  const selectedCount = selectedProductIds.size;
  raffleSelectionStatus.textContent = `${selectedCount} de ${availableProducts.length} produtos selecionados.`;
  raffleSelectionStatus.className = selectedCount ? 'helper-text is-ready' : 'helper-text';
  raffleSubmitButton.disabled = false;
  raffleConfirmCreateButton.disabled = selectedCount === 0 || createInFlight;
  refreshSelectionSummary();
}

function renderProductSelection() {
  if (!availableProducts.length) {
    raffleSelectionList.innerHTML = '';
    raffleSelectionEmpty.hidden = false;
    updateSelectionStatus();
    return;
  }

  raffleSelectionEmpty.hidden = true;

  if (!hasInitializedSelection) {
    selectedProductIds = new Set(availableProducts.map((item) => item.id));
    hasInitializedSelection = true;
  }

  raffleSelectionList.innerHTML = availableProducts.map((item) => `
    <label class="raffle-selection-card">
      <input
        class="raffle-selection-checkbox"
        type="checkbox"
        name="raffle-product-id"
        value="${escapeHtml(item.id)}"
        ${selectedProductIds.has(item.id) ? 'checked' : ''}
      />
      <div class="raffle-selection-content">
        <div class="raffle-selection-image-shell">
          ${item.productImagePath
            ? `<img class="raffle-selection-image" src="${escapeHtml(item.productImagePath)}" alt="${escapeHtml(item.title)}" />`
            : '<div class="empty-art raffle-selection-empty-image">Sem foto</div>'}
        </div>
        <div class="raffle-selection-copy">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.slug)}</span>
        </div>
      </div>
    </label>
  `).join('');

  updateSelectionStatus();
}

function renderPreview(item = null) {
  if (!item) {
    rafflePreviewEmpty.hidden = false;
    rafflePreviewCard.hidden = true;
    rafflePreviewCard.dataset.raffleId = '';
    rafflePreviewBadge.textContent = 'Aguardando';
    rafflePreviewBadge.className = 'status-badge';
    rafflePreviewProducts.hidden = true;
    rafflePreviewProductChips.innerHTML = '';
    rafflePreviewDeleteButton.dataset.raffleId = '';
    rafflePreviewDeleteButton.dataset.raffleName = '';
    return;
  }

  rafflePreviewEmpty.hidden = true;
  rafflePreviewCard.hidden = false;
  rafflePreviewCard.dataset.raffleId = item.id || '';
  rafflePreviewBadge.textContent = item.exhausted ? 'Encerrado' : 'Ativo';
  rafflePreviewBadge.className = 'status-badge';
  rafflePreviewBadge.classList.add(item.exhausted ? 'is-error' : 'is-ready');
  rafflePreviewImage.src = item.qrCode.preview;
  rafflePreviewName.textContent = item.name;
  rafflePreviewLink.textContent = item.publicUrl;
  rafflePreviewLink.href = item.publicUrl;
  rafflePreviewOpenLink.href = item.publicUrl;
  rafflePreviewDownloadLink.href = item.qrCode.png;
  rafflePreviewTotal.textContent = `${item.totalProducts} produtos`;
  rafflePreviewRemaining.textContent = `${item.remainingProducts} restantes`;
  rafflePreviewProductChips.innerHTML = getSelectedProductsPanel({
    selectedProducts: item.selectedProducts,
    drawnProductsList: item.drawnProductsList,
    availableProducts: item.availableProducts,
  }, item.id);
  rafflePreviewProducts.hidden = false;
  rafflePreviewDeleteButton.dataset.raffleId = item.id || '';
  rafflePreviewDeleteButton.dataset.raffleName = item.name || '';
}

function getRaffleCardTemplate(item) {
  return `
    <article class="raffle-list-card">
      <div class="raffle-list-card-head">
        <div>
          <span class="product-date">${new Date(item.createdAt).toLocaleString('pt-BR')}</span>
          <h3>${escapeHtml(item.name)}</h3>
        </div>
        <span class="status-badge ${item.exhausted ? 'is-error' : 'is-ready'}">${item.exhausted ? 'Encerrado' : 'Ativo'}</span>
      </div>

      <div class="product-link-panel">
        <span class="product-link-label">Link do sorteio</span>
        <a class="product-link-anchor" href="${item.publicUrl}" target="_blank" rel="noreferrer">${item.publicUrl}</a>
      </div>

      <dl class="meta-list compact">
        <div>
          <dt>Total</dt>
          <dd>${item.totalProducts} produtos</dd>
        </div>
        <div>
          <dt>Distribuídos</dt>
          <dd>${item.drawnProducts}</dd>
        </div>
        <div>
          <dt>Restantes</dt>
          <dd>${item.remainingProducts}</dd>
        </div>
      </dl>

      <div class="raffle-selected-products">
        <span class="product-link-label">Produtos deste sorteio</span>
        <div class="raffle-products-panel">${getSelectedProductsPanel({
          selectedProducts: item.selectedProducts,
          drawnProductsList: item.drawnProductsList,
          availableProducts: item.availableProducts,
        }, item.id)}</div>
      </div>

      <div class="product-card-actions">
        <button type="button" class="secondary-button" data-action="copy-link" data-url="${item.publicUrl}">Copiar link</button>
        <a class="secondary-button button-link" href="${item.publicUrl}" target="_blank" rel="noreferrer">Abrir sorteio</a>
        <a class="secondary-button button-link" href="${item.qrCode.png}">Baixar QR</a>
        <button type="button" class="ghost-button" data-action="delete-raffle" data-raffle-id="${item.id}" data-raffle-name="${escapeHtml(item.name)}">Excluir sorteio</button>
      </div>
    </article>
  `;
}

function renderRaffles() {
  raffleListCount.textContent = `${raffles.length} ${raffles.length === 1 ? 'item' : 'itens'}`;
  raffleEmptyList.hidden = raffles.length > 0;
  raffleList.innerHTML = raffles.map(getRaffleCardTemplate).join('');
}

function updateRaffleInState(updatedRaffle) {
  raffles = raffles.map((item) => item.id === updatedRaffle.id ? updatedRaffle : item);
  renderRaffles();

  if (getCurrentPreviewRaffleId() === updatedRaffle.id) {
    renderPreview(updatedRaffle);
    return;
  }

  renderPreview(raffles[0] || null);
}

function removeRaffleFromState(raffleId) {
  raffles = raffles.filter((item) => item.id !== raffleId);
  renderRaffles();
  renderPreview(raffles[0] || null);
}

function openSelectionModal() {
  raffleSelectionModal.hidden = false;
  document.body.classList.add('modal-open');
  renderProductSelection();
}

function closeSelectionModal(force = false) {
  if (createInFlight && !force) {
    return;
  }

  raffleSelectionModal.hidden = true;
  document.body.classList.remove('modal-open');
}

async function loadProducts() {
  raffleSelectionStatus.textContent = 'Carregando produtos para seleção...';
  raffleSelectionStatus.className = 'helper-text';
  raffleSelectionSummary.textContent = 'Carregando produtos para o próximo sorteio...';
  raffleSelectionSummary.className = 'helper-text';

  try {
    const response = await apiFetch('/api/products');
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível carregar os produtos.');
    }

    availableProducts = Array.isArray(payload.items) ? payload.items : [];
    renderProductSelection();
  } catch (error) {
    availableProducts = [];
    selectedProductIds = new Set();
    raffleSelectionList.innerHTML = '';
    raffleSelectionEmpty.hidden = false;
    raffleSelectionEmpty.textContent = error.message;
    updateSelectionStatus();
  }
}

async function loadRaffles() {
  setRaffleListStatus('Carregando sorteios criados...');

  try {
    const response = await apiFetch('/api/raffles');
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível carregar os sorteios.');
    }

    raffles = Array.isArray(payload.items) ? payload.items : [];
    renderRaffles();
    renderPreview(raffles[0] || null);
    setRaffleListStatus('Cada campanha usa apenas os produtos escolhidos pelo admin e permite devolver ao sorteio os itens já distribuídos.');
  } catch (error) {
    raffles = [];
    raffleList.innerHTML = '';
    raffleEmptyList.hidden = false;
    raffleEmptyList.textContent = error.message;
    renderPreview(null);
    setRaffleListStatus(error.message, 'is-error');
  }
}

async function createRaffle() {
  const productIds = [...selectedProductIds];

  if (!productIds.length) {
    setRaffleFormStatus('Selecione ao menos um produto para criar o sorteio.', 'is-error');
    updateSelectionStatus();
    return;
  }

  createInFlight = true;
  raffleSubmitButton.disabled = true;
  raffleConfirmCreateButton.disabled = true;
  raffleConfirmCreateButton.textContent = 'Criando...';
  setRaffleFormStatus('Criando campanha e QR do sorteio...', 'is-loading');

  try {
    const response = await apiFetch('/api/raffles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: raffleNameInput.value.trim(),
        productIds,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível criar o sorteio.');
    }

    renderPreview(payload);
    raffleNameInput.value = '';
    setRaffleFormStatus('Sorteio criado com sucesso.', 'is-ready');
    closeSelectionModal(true);
    await loadRaffles();
  } catch (error) {
    setRaffleFormStatus(error.message, 'is-error');
  } finally {
    createInFlight = false;
    raffleSubmitButton.disabled = false;
    raffleConfirmCreateButton.textContent = 'Confirmar sorteio';
    updateSelectionStatus();
  }
}

async function restoreDrawnProductToRaffle(raffleId, productId, trigger) {
  trigger.disabled = true;
  setRaffleListStatus('Devolvendo produto ao sorteio...', 'is-loading');

  try {
    const response = await apiFetch(`/api/raffles/${encodeURIComponent(raffleId)}/products/${encodeURIComponent(productId)}`, {
      method: 'DELETE',
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível devolver o produto ao sorteio.');
    }

    updateRaffleInState(payload);
    setRaffleListStatus('Produto devolvido ao sorteio.', 'is-ready');
  } catch (error) {
    trigger.disabled = false;
    setRaffleListStatus(error.message, 'is-error');
  }
}

async function deleteRaffleById(raffleId, raffleName, trigger) {
  const confirmed = window.confirm(`Excluir o sorteio "${raffleName || 'sem nome'}"?`);

  if (!confirmed) {
    return;
  }

  trigger.disabled = true;
  setRaffleListStatus('Excluindo sorteio...', 'is-loading');

  try {
    const response = await apiFetch(`/api/raffles/${encodeURIComponent(raffleId)}`, {
      method: 'DELETE',
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível excluir o sorteio.');
    }

    removeRaffleFromState(payload.id || raffleId);
    setRaffleListStatus('Sorteio excluído.', 'is-ready');
  } catch (error) {
    trigger.disabled = false;
    setRaffleListStatus(error.message, 'is-error');
  }
}

raffleForm.addEventListener('submit', (event) => {
  event.preventDefault();

  if (!raffleNameInput.reportValidity()) {
    return;
  }

  if (!availableProducts.length) {
    setRaffleFormStatus('Cadastre produtos antes de criar um sorteio.', 'is-error');
    return;
  }

  setRaffleFormStatus('Escolha os produtos da campanha no modal e confirme.', 'is-ready');
  openSelectionModal();
});

raffleConfirmCreateButton.addEventListener('click', () => {
  void createRaffle();
});

document.addEventListener('change', (event) => {
  const target = event.target;

  if (!(target instanceof HTMLInputElement) || target.name !== 'raffle-product-id') {
    return;
  }

  if (target.checked) {
    selectedProductIds.add(target.value);
  } else {
    selectedProductIds.delete(target.value);
  }

  updateSelectionStatus();
});

document.addEventListener('click', async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const clickable = target.closest('[data-modal-close], [data-selection-action], [data-action]');

  if (!(clickable instanceof HTMLElement)) {
    return;
  }

  const modalClose = clickable.dataset.modalClose;

  if (modalClose === 'selection') {
    closeSelectionModal();
    return;
  }

  const selectionAction = clickable.dataset.selectionAction;

  if (selectionAction) {
    if (selectionAction === 'select-all') {
      selectedProductIds = new Set(availableProducts.map((item) => item.id));
    }

    if (selectionAction === 'clear-all') {
      selectedProductIds = new Set();
    }

    renderProductSelection();
    return;
  }

  const action = clickable.dataset.action;

  if (!action) {
    return;
  }

  if (action === 'restore-product') {
    const raffleId = clickable.dataset.raffleId || '';
    const productId = clickable.dataset.productId || '';
    void restoreDrawnProductToRaffle(raffleId, productId, clickable);
    return;
  }

  if (action === 'delete-raffle') {
    const raffleId = clickable.dataset.raffleId || '';
    const raffleName = clickable.dataset.raffleName || '';
    void deleteRaffleById(raffleId, raffleName, clickable);
    return;
  }

  const url = action === 'copy-preview-link'
    ? rafflePreviewLink.href
    : clickable.dataset.url || '';

  try {
    await navigator.clipboard.writeText(url);
    clickable.textContent = 'Link copiado';
    window.setTimeout(() => {
      clickable.textContent = 'Copiar link';
    }, 1200);
  } catch {
    setRaffleListStatus('Não foi possível copiar o link do sorteio.', 'is-error');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !raffleSelectionModal.hidden) {
    closeSelectionModal();
  }
});

renderPreview();
void Promise.all([loadProducts(), loadRaffles()]);
