const loadingState = document.querySelector('#product-loading');
const errorState = document.querySelector('#product-error');
const productCard = document.querySelector('#product-card');
const productPageImage = document.querySelector('#product-page-image');
const productPageTitle = document.querySelector('#product-page-title');
const productPageMessage = document.querySelector('#product-page-message');
const productPageSubtitle = document.querySelector('#product-page-subtitle');

function getSlugFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts.at(-1) || '';
}

function showError(message) {
  loadingState.hidden = true;
  productCard.hidden = true;
  errorState.hidden = false;
  errorState.querySelector('p').textContent = message;
  document.title = 'Produto indisponível';
}

async function loadProduct() {
  const slug = getSlugFromPath();

  if (!slug) {
    showError('Produto não encontrado.');
    return;
  }

  try {
    const response = await fetch(`/api/public/products/${encodeURIComponent(slug)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Produto não encontrado.');
    }

    document.title = `${data.title} | Produto`;
    productPageImage.src = data.productImagePath;
    productPageImage.alt = data.title ? `Foto do produto ${data.title}` : 'Foto do produto';
    productPageTitle.textContent = data.title;
    productPageMessage.textContent = data.rewardMessage || 'Você ganhou este produto.';
    productPageSubtitle.textContent = 'Você ganhou um prêmio exclusivo.';

    loadingState.hidden = true;
    errorState.hidden = true;
    productCard.hidden = false;
  } catch (error) {
    showError(error.message || 'Não foi possível abrir esta página.');
  }
}

loadProduct();
