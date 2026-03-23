const form = document.querySelector('#product-form');
const titleInput = document.querySelector('#title-input');
const rewardMessageInput = document.querySelector('#reward-message-input');
const artTemplateSelect = document.querySelector('#art-template-select');
const qrDarkColorInput = document.querySelector('#qr-dark-color-input');
const qrDarkColorValue = document.querySelector('#qr-dark-color-value');
const productImageInput = document.querySelector('#product-image-input');
const submitFormButton = document.querySelector('#submit-form-button');
const resetFormButton = document.querySelector('#reset-form-button');
const formStatus = document.querySelector('#form-status');
const draftBadge = document.querySelector('#draft-badge');
const formTitle = document.querySelector('.form-panel .section-heading h2');
const productPreviewImage = document.querySelector('#product-preview-image');
const productPreviewEmpty = document.querySelector('#product-preview-empty');
const productPreviewTitle = document.querySelector('#product-preview-title');
const productPreviewMessage = document.querySelector('#product-preview-message');
const productPreviewTemplate = document.querySelector('#product-preview-template');
const productPreviewQrColor = document.querySelector('#product-preview-qr-color');
const productPreviewQrColorSwatch = document.querySelector('#product-preview-qr-color-swatch');

let currentProductImageDataUrl = '';
let currentProductPreviewSrc = '';
let artTemplates = [];
let editingSlug = '';

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
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
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
    image.onerror = () => reject(new Error('Não foi possível preparar a imagem.'));
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
  productPreviewMessage.textContent = rewardMessageInput.value.trim() || 'Parabéns, você ganhou um smoothie grátis.';
  const selectedTemplate = artTemplates.find((item) => item.id === artTemplateSelect.value);
  productPreviewTemplate.textContent = selectedTemplate?.name || 'Selecione uma arte';
  const qrDarkColor = qrDarkColorInput.value || '#18181b';
  qrDarkColorValue.textContent = qrDarkColor;
  productPreviewQrColor.textContent = qrDarkColor;
  productPreviewQrColorSwatch.style.setProperty('--qr-color', qrDarkColor);

  if (currentProductImageDataUrl) {
    productPreviewImage.hidden = false;
    productPreviewImage.src = currentProductPreviewSrc || currentProductImageDataUrl;
    productPreviewEmpty.hidden = true;
  } else if (currentProductPreviewSrc) {
    productPreviewImage.hidden = false;
    productPreviewImage.src = currentProductPreviewSrc;
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
  currentProductPreviewSrc = currentProductImageDataUrl;
  updatePreview();
}

function formatMessagePreview(value = '') {
  return escapeHtml(value).replaceAll('\n', '<br />');
}

function setFormMode(mode = 'create', item = null) {
  const isEditing = mode === 'edit' && item;
  editingSlug = isEditing ? item.slug : '';
  formTitle.textContent = isEditing ? 'Editar produto' : 'Cadastro';
  submitFormButton.textContent = isEditing ? 'Salvar alterações' : 'Salvar e gerar link';
  resetFormButton.textContent = isEditing ? 'Cancelar edição' : 'Limpar';
  setDraftBadge(isEditing ? 'Editando' : 'Rascunho', isEditing ? 'is-loading' : '');
}

function startEditProduct(item) {
  setFormMode('edit', item);
  titleInput.value = item.title || '';
  rewardMessageInput.value = item.rewardMessage || '';
  artTemplateSelect.value = item.artTemplate?.id || item.artTemplateId || artTemplates[0]?.id || '';
  qrDarkColorInput.value = item.qrDarkColor || '#18181b';
  productImageInput.value = '';
  currentProductImageDataUrl = '';
  currentProductPreviewSrc = item.productImagePath || '';
  updatePreview();
  setFormStatus('Edite os campos e salve para atualizar o produto.');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

async function loadProductForEdit(slug) {
  try {
    const response = await fetch(`/api/products/${encodeURIComponent(slug)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Produto não encontrado.');
    }

    startEditProduct(payload);
    setFormStatus('Produto carregado para edição.');
  } catch (error) {
    setDraftBadge('Erro', 'is-error');
    setFormStatus(error.message, 'is-error');
  }
}

function resetForm() {
  form.reset();
  currentProductImageDataUrl = '';
  currentProductPreviewSrc = '';
  if (artTemplates[0]) {
    artTemplateSelect.value = artTemplates[0].id;
  }
  setFormMode('create');
  updatePreview();
  setFormStatus('Formulario limpo.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!editingSlug && !productImageInput.files?.[0]) {
    setDraftBadge('Erro', 'is-error');
    setFormStatus('Envie a foto do produto antes de salvar.', 'is-error');
    return;
  }

  setDraftBadge('Salvando', 'is-loading');
  setFormStatus(editingSlug ? 'Atualizando produto...' : 'Salvando produto e gerando link final...');

  try {
    const payload = {
      title: titleInput.value.trim(),
      rewardMessage: rewardMessageInput.value.trim(),
      artTemplateId: artTemplateSelect.value,
      qrDarkColor: qrDarkColorInput.value || '#18181b',
    };

    if (currentProductImageDataUrl) {
      payload.productImage = currentProductImageDataUrl;
    } else if (!editingSlug && productImageInput.files?.[0]) {
      payload.productImage = await optimizeImage(productImageInput.files[0]);
    }

    const response = await fetch(editingSlug ? `/api/products/${encodeURIComponent(editingSlug)}` : '/api/products', {
      method: editingSlug ? 'PUT' : 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Não foi possível salvar o produto.');
    }

    if (editingSlug) {
      resetForm();
      setDraftBadge('Atualizado', 'is-ready');
      setFormStatus('Produto atualizado com sucesso.', 'is-ready');
      window.history.replaceState({}, '', '/');
      return;
    }

    window.location.href = data.artPath;
  } catch (error) {
    setDraftBadge('Erro', 'is-error');
    setFormStatus(error.message, 'is-error');
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

updatePreview();
loadArtTemplates().then(async () => {
  const editSlug = new URLSearchParams(window.location.search).get('edit');
  if (editSlug) {
    await loadProductForEdit(editSlug);
    return;
  }

  setFormStatus('Ao salvar, você será levado direto para a tela da arte e poderá baixar o QR transparente.');
});
