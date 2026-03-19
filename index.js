import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(process.cwd(), 'public');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

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

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function getQrOptions(searchParams) {
  return {
    errorCorrectionLevel: 'M',
    margin: clampNumber(searchParams.get('margin'), 2, 0, 8),
    width: clampNumber(searchParams.get('width'), 360, 160, 960),
    color: {
      dark: '#0f172a',
      light: '#f8fafc',
    },
  };
}

function sendBuffer(res, statusCode, buffer, headers = {}, method = 'GET') {
  res.writeHead(statusCode, headers);

  if (method === 'HEAD') {
    res.end();
    return;
  }

  res.end(buffer);
}

function sendJson(res, statusCode, payload, method = 'GET') {
  sendBuffer(
    res,
    statusCode,
    Buffer.from(JSON.stringify(payload)),
    { 'Content-Type': MIME_TYPES['.json'] },
    method
  );
}

async function createPdfBuffer(imageBuffer, encodedText, qrWidth) {
  return new Promise((resolve, reject) => {
    const pageWidth = Math.max(430, qrWidth + 120);
    const pageHeight = Math.max(560, qrWidth + 280);
    const doc = new PDFDocument({
      size: [pageWidth, pageHeight],
      margin: 40,
    });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, pageWidth, pageHeight).fill('#ffffff');

    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(24).text('QR Code', 40, 44);
    doc.fillColor('#475569').font('Helvetica').fontSize(11).text('Gerado localmente no navegador e servidor Node.', 40, 74);

    const imageX = (pageWidth - qrWidth) / 2;
    const imageY = 122;
    doc.image(imageBuffer, imageX, imageY, { width: qrWidth });

    const infoY = imageY + qrWidth + 28;
    doc.roundedRect(40, infoY, pageWidth - 80, 110, 18).fill('#f8fafc');
    doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(10).text('Conteudo codificado', 58, infoY + 18);
    doc.fillColor('#0f172a').font('Helvetica').fontSize(12).text(encodedText, 58, infoY + 40, {
      width: pageWidth - 116,
      height: 54,
      ellipsis: true,
    });

    doc.end();
  });
}

async function serveStaticFile(reqPath, res, method) {
  const cleanPath = reqPath === '/' ? '/index.html' : reqPath;
  const absolutePath = path.join(PUBLIC_DIR, cleanPath);

  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Acesso negado.' }, method);
    return;
  }

  try {
    const file = await readFile(absolutePath);
    const extension = path.extname(absolutePath);
    sendBuffer(res, 200, file, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    }, method);
  } catch {
    sendJson(res, 404, { error: 'Arquivo nao encontrado.' }, method);
  }
}

async function handleQrRequest(reqUrl, res, method) {
  const rawText = reqUrl.searchParams.get('text') || '';
  const text = normalizeQrText(rawText);
  const format = (reqUrl.searchParams.get('format') || 'png').toLowerCase();

  if (!text) {
    sendJson(res, 400, { error: 'Informe um texto ou URL para gerar o QR Code.' }, method);
    return;
  }

  if (!['png', 'svg', 'pdf'].includes(format)) {
    sendJson(res, 400, { error: 'Formato invalido.' }, method);
    return;
  }

  const qrOptions = getQrOptions(reqUrl.searchParams);
  const baseFilename = sanitizeFilename(reqUrl.searchParams.get('filename') || deriveFilename(text));
  const shouldDownload = reqUrl.searchParams.get('download') === '1';
  const downloadHeader = shouldDownload
    ? { 'Content-Disposition': `attachment; filename="${baseFilename}.${format}"` }
    : {};

  try {
    if (format === 'svg') {
      const svg = await QRCode.toString(text, { ...qrOptions, type: 'svg' });
      sendBuffer(res, 200, Buffer.from(svg), {
        'Content-Type': MIME_TYPES['.svg'],
        ...downloadHeader,
      }, method);
      return;
    }

    const pngBuffer = await QRCode.toBuffer(text, { ...qrOptions, type: 'png' });

    if (format === 'png') {
      sendBuffer(res, 200, pngBuffer, {
        'Content-Type': 'image/png',
        ...downloadHeader,
      }, method);
      return;
    }

    const pdfBuffer = await createPdfBuffer(pngBuffer, text, qrOptions.width);
    sendBuffer(res, 200, pdfBuffer, {
      'Content-Type': 'application/pdf',
      ...downloadHeader,
    }, method);
  } catch (error) {
    console.error('Erro ao gerar QR Code:', error);
    sendJson(res, 500, { error: 'Nao foi possivel gerar o QR Code.' }, method);
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);

  if (!['GET', 'HEAD'].includes(req.method || '')) {
    sendJson(res, 405, { error: 'Metodo nao permitido.' }, req.method);
    return;
  }

  if (reqUrl.pathname === '/api/qrcode') {
    await handleQrRequest(reqUrl, res, req.method);
    return;
  }

  if (reqUrl.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' }, req.method);
    return;
  }

  await serveStaticFile(reqUrl.pathname, res, req.method);
});

server.listen(PORT, HOST, () => {
  console.log(`QR Code app pronta em http://localhost:${PORT}`);
});
