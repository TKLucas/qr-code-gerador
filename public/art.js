const artLoading = document.querySelector('#art-loading');
const artError = document.querySelector('#art-error');
const artCard = document.querySelector('#art-card');
const artCanvas = document.querySelector('#art-canvas');
const artTitle = document.querySelector('#art-title');
const artFinalLink = document.querySelector('#art-final-link');
const artRewardMessage = document.querySelector('#art-reward-message');
const downloadArtButton = document.querySelector('#download-art-button');
const downloadTransparentQrButton = document.querySelector('#download-transparent-qr-button');
const copyFinalLinkButton = document.querySelector('#copy-final-link-button');
const openFinalLinkButton = document.querySelector('#open-final-link-button');
const apiFetch = window.adminSession?.fetch?.bind(window.adminSession) || window.fetch.bind(window);

let currentProduct = null;

function getSlugFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts.at(-1) || '';
}

function showError(message) {
  artLoading.hidden = true;
  artCard.hidden = true;
  artError.hidden = false;
  artError.querySelector('p').textContent = message;
  document.title = 'Arte indisponível';
}

async function loadArtPage() {
  const slug = getSlugFromPath();

  if (!slug) {
    showError('Produto não encontrado.');
    return;
  }

  try {
    const response = await apiFetch(`/api/products/${encodeURIComponent(slug)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Produto não encontrado.');
    }

    currentProduct = data;
    document.title = `${data.title} | Arte`;
    artTitle.textContent = data.title;
    artFinalLink.textContent = data.finalUrl;
    artRewardMessage.textContent = data.rewardMessage || 'Você ganhou este produto.';
    openFinalLinkButton.href = data.finalUrl;
    downloadTransparentQrButton.href = data.qrCode.transparentPng;

    await window.artwork.renderArtwork(artCanvas, {
      baseArtUrl: data.artTemplate?.imageUrl,
      qrImageUrl: data.qrCode.art,
      qrSlot: data.artTemplate?.qrSlot,
    });

    artLoading.hidden = true;
    artError.hidden = true;
    artCard.hidden = false;
  } catch (error) {
    showError(error.message || 'Não foi possível gerar esta arte.');
  }
}

downloadArtButton.addEventListener('click', () => {
  if (!currentProduct) {
    return;
  }

  const link = document.createElement('a');
  link.href = artCanvas.toDataURL('image/png');
  link.download = `${currentProduct.slug}-arte.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
});

copyFinalLinkButton.addEventListener('click', async () => {
  if (!currentProduct) {
    return;
  }

  try {
    await navigator.clipboard.writeText(currentProduct.finalUrl);
    copyFinalLinkButton.textContent = 'Link copiado';
    window.setTimeout(() => {
      copyFinalLinkButton.textContent = 'Copiar link final';
    }, 1200);
  } catch {
    showError('Não foi possível copiar o link final.');
  }
});

loadArtPage();
