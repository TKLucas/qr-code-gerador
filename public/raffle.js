const raffleLoading = document.querySelector('#raffle-loading');
const raffleError = document.querySelector('#raffle-error');
const raffleCard = document.querySelector('#raffle-card');
const raffleTitle = document.querySelector('#raffle-title');
const raffleSubtitle = document.querySelector('#raffle-subtitle');
const raffleRemainingCount = document.querySelector('#raffle-remaining-count');
const raffleTotalCount = document.querySelector('#raffle-total-count');
const raffleResultTitle = document.querySelector('#raffle-result-title');
const raffleResultMessage = document.querySelector('#raffle-result-message');

function getSlugFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts.at(-1) || '';
}

function showError(message, title = 'Sorteio indisponível') {
  raffleLoading.hidden = true;
  raffleCard.hidden = false;
  raffleError.hidden = false;
  raffleError.querySelector('p').textContent = message;
  raffleTitle.textContent = title;
  raffleSubtitle.textContent = 'Não foi possível concluir o sorteio.';
  raffleRemainingCount.textContent = '0';
  raffleTotalCount.textContent = '0';
  raffleResultTitle.textContent = 'Não foi possível sortear';
  raffleResultMessage.textContent = message;
  document.title = title;
}

async function loadRaffleFallback(slug) {
  const response = await fetch(`/api/public/raffles/${encodeURIComponent(slug)}`);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Sorteio não encontrado.');
  }

  document.title = `${payload.name} | Sorteio`;
  raffleTitle.textContent = payload.name;
  raffleRemainingCount.textContent = String(payload.remainingProducts);
  raffleTotalCount.textContent = String(payload.totalProducts);

  if (payload.exhausted) {
    raffleSubtitle.textContent = 'Este sorteio já distribuiu todos os produtos desta campanha.';
    raffleResultTitle.textContent = 'Sorteio encerrado';
    raffleResultMessage.textContent = 'Todos os produtos desta campanha já foram distribuídos.';
    return;
  }

  raffleSubtitle.textContent = 'Não foi possível concluir o sorteio agora.';
  raffleResultTitle.textContent = 'Tente novamente';
  raffleResultMessage.textContent = 'Abra o link novamente para tentar um novo sorteio.';
}

async function startRaffle() {
  const slug = getSlugFromPath();

  if (!slug) {
    showError('Sorteio não encontrado.');
    return;
  }

  try {
    const response = await fetch(`/api/public/raffles/${encodeURIComponent(slug)}/draw`, {
      method: 'POST',
    });
    const payload = await response.json();

    if (!response.ok) {
      if (payload.exhausted) {
        await loadRaffleFallback(slug);
        raffleLoading.hidden = true;
        raffleCard.hidden = false;
        return;
      }

      throw new Error(payload.error || 'Não foi possível concluir o sorteio.');
    }

    const redirectPath = payload.product?.path || '/';
    window.location.replace(redirectPath);
  } catch (error) {
    try {
      await loadRaffleFallback(slug);
      raffleLoading.hidden = true;
      raffleCard.hidden = false;
      raffleResultMessage.textContent = error.message || raffleResultMessage.textContent;
    } catch {
      showError(error.message || 'Não foi possível concluir o sorteio.');
    }
  }
}

void startRaffle();
