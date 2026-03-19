const form = document.querySelector('#generator-form');
const textInput = document.querySelector('#text-input');
const sizeInput = document.querySelector('#size-input');
const sizeValue = document.querySelector('#size-value');
const previewFrame = document.querySelector('#preview-frame');
const previewImage = document.querySelector('#preview-image');
const emptyState = document.querySelector('#empty-state');
const statusBadge = document.querySelector('#status-badge');
const normalizedOutput = document.querySelector('#normalized-output');
const filenameOutput = document.querySelector('#filename-output');
const clearButton = document.querySelector('#clear-button');
const copyButton = document.querySelector('#copy-button');
const downloadButtons = Array.from(document.querySelectorAll('.download-button'));

let renderTimer;
let lastEncodedText = '';
let lastFilename = 'qrcode';

function normalizeQrText(input = '') {
  const trimmed = input.trim();

  if (!trimmed) {
    return '';
  }

  if (/^[a-z][a-z\d+\-.]*:/i.test(trimmed)) {
    return trimmed;
  }

  const looksLikeDomain = /^[^\s]+\.[^\s]{2,}$/i.test(trimmed);
  if (/^www\./i.test(trimmed) || looksLikeDomain) {
    return `https://${trimmed}`;
  }

  return trimmed;
}

function sanitizeFilename(input = '') {
  const cleaned = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return cleaned || 'qrcode';
}

function deriveFilename(text) {
  try {
    const parsedUrl = new URL(text);
    const host = sanitizeFilename(parsedUrl.hostname.replace(/^www\./, ''));
    const pathname = sanitizeFilename(parsedUrl.pathname);
    return pathname && pathname !== 'qrcode' ? `${host}-${pathname}` : host;
  } catch {
    return sanitizeFilename(text);
  }
}

function getPreviewUrl(text, format = 'png', download = false) {
  const params = new URLSearchParams({
    text,
    format,
    width: sizeInput.value,
    margin: '2',
    filename: deriveFilename(text),
  });

  if (download) {
    params.set('download', '1');
  }

  return `/api/qrcode?${params.toString()}`;
}

function setButtonsEnabled(enabled) {
  copyButton.disabled = !enabled;
  for (const button of downloadButtons) {
    button.disabled = !enabled;
  }
}

function setStatus(text, variant = '') {
  statusBadge.textContent = text;
  statusBadge.className = 'status-badge';
  if (variant) {
    statusBadge.classList.add(variant);
  }
}

function updateMeta(text) {
  lastEncodedText = text;
  lastFilename = text ? deriveFilename(text) : 'qrcode';
  normalizedOutput.textContent = text || 'Nenhum item gerado ainda.';
  filenameOutput.textContent = lastFilename;
}

function resetPreview() {
  previewImage.hidden = true;
  previewImage.removeAttribute('src');
  previewFrame.classList.add('is-empty');
  previewFrame.classList.remove('is-ready');
  setStatus('Aguardando conteudo');
  updateMeta('');
  setButtonsEnabled(false);
}

async function renderPreview() {
  const normalizedText = normalizeQrText(textInput.value);

  if (!normalizedText) {
    resetPreview();
    return;
  }

  updateMeta(normalizedText);
  setButtonsEnabled(false);
  setStatus('Gerando preview', 'is-loading');

  const previewUrl = `${getPreviewUrl(normalizedText)}&ts=${Date.now()}`;

  try {
    await new Promise((resolve, reject) => {
      previewImage.onload = () => resolve();
      previewImage.onerror = () => reject(new Error('Falha ao carregar preview.'));
      previewImage.src = previewUrl;
    });

    previewImage.hidden = false;
    previewFrame.classList.remove('is-empty');
    previewFrame.classList.add('is-ready');
    setStatus('Pronto para baixar', 'is-ready');
    setButtonsEnabled(true);
  } catch (error) {
    console.error(error);
    previewImage.hidden = true;
    previewFrame.classList.add('is-empty');
    previewFrame.classList.remove('is-ready');
    setStatus('Erro ao gerar', 'is-error');
    setButtonsEnabled(false);
  }
}

function schedulePreview() {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderPreview, 220);
}

function triggerDownload(url, filename) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function downloadJpg() {
  const image = new Image();
  image.src = `${getPreviewUrl(lastEncodedText)}&jpg=${Date.now()}`;

  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Falha ao preparar JPG.'));
  });

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext('2d');
  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) {
    throw new Error('Falha ao gerar blob JPG.');
  }

  const url = URL.createObjectURL(blob);
  triggerDownload(url, `${lastFilename}.jpg`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyPngToClipboard() {
  const response = await fetch(getPreviewUrl(lastEncodedText));
  if (!response.ok) {
    throw new Error('Falha ao buscar PNG.');
  }

  const blob = await response.blob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await renderPreview();
});

textInput.addEventListener('input', schedulePreview);
sizeInput.addEventListener('input', () => {
  sizeValue.textContent = `${sizeInput.value} px`;
  if (textInput.value.trim()) {
    schedulePreview();
  }
});

clearButton.addEventListener('click', () => {
  textInput.value = '';
  sizeInput.value = '360';
  sizeValue.textContent = '360 px';
  resetPreview();
  textInput.focus();
});

copyButton.addEventListener('click', async () => {
  if (!lastEncodedText) {
    return;
  }

  try {
    await copyPngToClipboard();
    setStatus('PNG copiado', 'is-ready');
  } catch (error) {
    console.error(error);
    setStatus('Nao foi possivel copiar', 'is-error');
  }
});

for (const button of downloadButtons) {
  button.addEventListener('click', async () => {
    if (!lastEncodedText) {
      return;
    }

    const format = button.dataset.format;

    try {
      if (format === 'jpg') {
        await downloadJpg();
        return;
      }

      triggerDownload(
        getPreviewUrl(lastEncodedText, format, true),
        `${lastFilename}.${format}`
      );
    } catch (error) {
      console.error(error);
      setStatus('Falha no download', 'is-error');
    }
  });
}

resetPreview();
