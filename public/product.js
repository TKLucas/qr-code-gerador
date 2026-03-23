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
  document.title = 'Produto indisponivel';
}

async function loadProduct() {
  const slug = getSlugFromPath();

  if (!slug) {
    showError('Produto nao encontrado.');
    return;
  }

  try {
    const response = await fetch(`/api/products/${encodeURIComponent(slug)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Produto nao encontrado.');
    }

    document.title = `${data.title} | Produto`;
    productPageImage.src = data.productImagePath;
    productPageTitle.textContent = data.title;
    productPageMessage.textContent = data.rewardMessage || 'Voce ganhou este produto.';
    productPageSubtitle.textContent = 'Voce ganhou um premio exclusivo.';

    loadingState.hidden = true;
    errorState.hidden = true;
    productCard.hidden = false;
  } catch (error) {
    showError(error.message || 'Nao foi possivel abrir esta pagina.');
  }
}

loadProduct();
