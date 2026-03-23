const form = document.querySelector('#product-form');
const titleInput = document.querySelector('#title-input');
const rewardMessageInput = document.querySelector('#reward-message-input');
const artTemplateSelect = document.querySelector('#art-template-select');
const qrDarkColorInput = document.querySelector('#qr-dark-color-input');
const qrDarkColorValue = document.querySelector('#qr-dark-color-value');
const productImageInput = document.querySelector('#product-image-input');
const resetFormButton = document.querySelector('#reset-form-button');
const formStatus = document.querySelector('#form-status');
const draftBadge = document.querySelector('#draft-badge');
const productPreviewImage = document.querySelector('#product-preview-image');
const productPreviewEmpty = document.querySelector('#product-preview-empty');
const productPreviewTitle = document.querySelector('#product-preview-title');
const productPreviewMessage = document.querySelector('#product-preview-message');
const productPreviewTemplate = document.querySelector('#product-preview-template');
const productPreviewQrColor = document.querySelector('#product-preview-qr-color');
const productPreviewQrColorSwatch = document.querySelector('#product-preview-qr-color-swatch');
const productList = document.querySelector('#product-list');
const productSearchInput = document.querySelector('#product-search-input');
const listCount = document.querySelector('#list-count');
const emptyList = document.querySelector('#empty-list');

let currentProductImageDataUrl = '';
let artTemplates = [];
let products = [];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setFormStatus(text, variant = '') {
  formStatus.textContent = text;
  formStatus.className = 'helper-text';
  if (variant) {
    formStatus.classList.add(variant);
  }
}

function setDraftBadge(text, variant = '') {
  draftBadge.textContent = text;
  draftBadge.className = 'status-badge';
  if (variant) {
    draftBadge.classList.add(variant);
  }
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Nao foi possivel ler a imagem.'));
    reader.readAsDataURL(file);
  });
}

async function optimizeImage(file, maxSide = 1600) {
  const dataUrl = await fileToDataUrl(file);

  if (file.size <= 1.5 * 1024 * 1024) {
    return dataUrl;
  }

  const image = new Image();
  image.src = dataUrl;

  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Nao foi possivel preparar a imagem.'));
  });

  const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * ratio));
  canvas.height = Math.max(1, Math.round(image.height * ratio));

  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return canvas.toDataURL(outputType, 0.9);
}

function updatePreview() {
  productPreviewTitle.textContent = titleInput.value.trim() || 'Seu produto aparece aqui';
  productPreviewMessage.textContent = rewardMessageInput.value.trim() || 'Parabens, voce ganhou um smoothie gratis.';
  const selectedTemplate = artTemplates.find((item) => item.id === artTemplateSelect.value);
  productPreviewTemplate.textContent = selectedTemplate?.name || 'Selecione uma arte';
  const qrDarkColor = qrDarkColorInput.value || '#18181b';
  qrDarkColorValue.textContent = qrDarkColor;
  productPreviewQrColor.textContent = qrDarkColor;
  productPreviewQrColorSwatch.style.setProperty('--qr-color', qrDarkColor);

  if (currentProductImageDataUrl) {
    productPreviewImage.hidden = false;
    productPreviewImage.src = currentProductImageDataUrl;
    productPreviewEmpty.hidden = true;
  } else {
    productPreviewImage.hidden = true;
    productPreviewImage.removeAttribute('src');
    productPreviewEmpty.hidden = false;
  }
}

async function updateProductImagePreview() {
  const file = productImageInput.files?.[0];
  currentProductImageDataUrl = file ? await optimizeImage(file) : '';
  updatePreview();
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
            <p class="product-card-message">${escapeHtml(item.rewardMessage || 'Voce ganhou este produto.')}</p>
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
        <button type="button" class="secondary-button" data-action="copy-final-link" data-url="${item.finalUrl}">Copiar link final</button>
        <a class="secondary-button button-link" href="${item.finalUrl}" target="_blank" rel="noreferrer">Abrir link final</a>
        <a class="secondary-button button-link" href="${item.artUrl}" target="_blank" rel="noreferrer">Abrir arte</a>
        <a class="secondary-button button-link" href="${item.qrCode.png}">Baixar QR PNG</a>
        <a class="secondary-button button-link" href="${item.qrCode.transparentPng}">QR transparente</a>
      </div>

      <aside class="product-card-qr-shell">
        <span class="preview-label">QR rapido</span>
        <img class="product-card-qr-image" src="${item.qrCode.preview}" alt="Preview do QR de ${escapeHtml(item.title)}" />
      </aside>
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

async function loadArtTemplates() {
  const response = await fetch('/api/art-templates');
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Falha ao carregar as artes base.');
  }

  artTemplates = Array.isArray(payload.items) ? payload.items : [];
  artTemplateSelect.innerHTML = artTemplates.length
    ? artTemplates.map((item, index) => `<option value="${item.id}" ${index === 0 ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')
    : '<option value="">Nenhuma arte encontrada</option>';
  updatePreview();
}

async function loadProducts() {
  setFormStatus('Carregando produtos salvos...');

  try {
    await loadArtTemplates();
    const response = await fetch('/api/products');
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Falha ao carregar os produtos.');
    }

    products = Array.isArray(payload.items) ? payload.items : [];
    renderProducts();
    setFormStatus('Ao salvar, voce sera levado direto para a tela da arte e podera baixar o QR transparente.');
  } catch (error) {
    products = [];
    productList.innerHTML = '';
    emptyList.hidden = false;
    emptyList.textContent = error.message;
    setFormStatus(error.message, 'is-error');
  }
}

function resetForm() {
  form.reset();
  currentProductImageDataUrl = '';
  if (artTemplates[0]) {
    artTemplateSelect.value = artTemplates[0].id;
  }
  updatePreview();
  setDraftBadge('Rascunho');
  setFormStatus('Formulario limpo.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!productImageInput.files?.[0]) {
    setDraftBadge('Erro', 'is-error');
    setFormStatus('Envie a foto do produto antes de salvar.', 'is-error');
    return;
  }

  setDraftBadge('Salvando', 'is-loading');
  setFormStatus('Salvando produto e gerando link final...');

  try {
    const payload = {
      title: titleInput.value.trim(),
      rewardMessage: rewardMessageInput.value.trim(),
      artTemplateId: artTemplateSelect.value,
      qrDarkColor: qrDarkColorInput.value || '#18181b',
      productImage: currentProductImageDataUrl || await optimizeImage(productImageInput.files[0]),
    };

    const response = await fetch('/api/products', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Nao foi possivel salvar o produto.');
    }

    window.location.href = data.artPath;
  } catch (error) {
    setDraftBadge('Erro', 'is-error');
    setFormStatus(error.message, 'is-error');
  }
});

productList.addEventListener('click', async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.dataset.action !== 'copy-final-link') {
    return;
  }

  try {
    await navigator.clipboard.writeText(target.dataset.url || '');
    target.textContent = 'Link copiado';
    window.setTimeout(() => {
      target.textContent = 'Copiar link final';
    }, 1200);
  } catch {
    setFormStatus('Nao foi possivel copiar o link.', 'is-error');
  }
});

for (const input of [titleInput, rewardMessageInput, artTemplateSelect, qrDarkColorInput]) {
  input.addEventListener('input', updatePreview);
}

artTemplateSelect.addEventListener('change', updatePreview);

productImageInput.addEventListener('change', async () => {
  try {
    await updateProductImagePreview();
  } catch (error) {
    currentProductImageDataUrl = '';
    updatePreview();
    setFormStatus(error.message, 'is-error');
  }
});

resetFormButton.addEventListener('click', resetForm);
productSearchInput.addEventListener('input', renderProducts);

updatePreview();
loadProducts();
