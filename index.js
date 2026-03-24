import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import PDFDocument from 'pdfkit';
import {
  ADMIN_SESSION_COOKIE,
  SESSION_DURATION_MS,
  createSessionModel,
  createSessionToken,
  createUserModel,
  getInitialAdminConfig,
  hashSessionToken,
  normalizeIdentifier,
  normalizePassword,
  upsertAdminUser,
  verifyPassword,
} from './auth.js';
import { generateQrCode } from './qr-generator.js';

process.loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/qrcode';
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const DATA_DIR = path.join(process.cwd(), 'data');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const ART_TEMPLATES = await findArtTemplates();

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
};

const IMAGE_EXTENSIONS = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const PUBLIC_STATIC_PATHS = new Set([
  '/styles.css',
  '/product.js',
  '/login.js',
  '/login.html',
]);

await ensureStorage();
await connectDatabase();
const Product = createProductModel();
const User = createUserModel();
const AdminSession = createSessionModel();
const UploadAsset = createUploadAssetModel();
const RaffleCampaign = createRaffleCampaignModel();
const RaffleDraw = createRaffleDrawModel();
await migrateLegacyProducts();
await ensureInitialAdmin();
await syncExistingUploadsToDatabase();

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

function createSlug(input = '') {
  return sanitizeFilename(input).slice(0, 42) || crypto.randomUUID().slice(0, 8);
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

function getQrRenderOptions(searchParams) {
  return {
    margin: clampNumber(searchParams.get('margin'), 2, 0, 8),
    size: clampNumber(searchParams.get('width'), 360, 160, 1200),
    darkColor: normalizeColorParam(searchParams.get('darkColor'), '#18181b'),
    lightColor: normalizeColorParam(searchParams.get('lightColor'), '#ffffff'),
    rounded: searchParams.get('rounded') === '1',
    backgroundTransparent: searchParams.get('backgroundTransparent') === '1',
  };
}

function normalizeColorParam(value, fallback) {
  const normalized = typeof value === 'string' ? value.trim() : '';

  if (!normalized) {
    return fallback;
  }

  if (/^#([0-9a-f]{3,8})$/i.test(normalized)) {
    return normalized;
  }

  if (/^rgba?\(/i.test(normalized)) {
    return normalized;
  }

  if (normalized === 'transparent') {
    return normalized;
  }

  return fallback;
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
    {
      'Content-Type': MIME_TYPES['.json'],
      'Cache-Control': 'no-store',
    },
    method
  );
}

function getBaseUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = typeof forwardedProto === 'string' && forwardedProto
    ? forwardedProto.split(',')[0].trim()
    : 'http';
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${hostHeader}`;
}

function toAbsoluteUrl(req, pathname) {
  return new URL(pathname, getBaseUrl(req)).toString();
}

function getStartupUrls(host, port) {
  const urls = [`http://localhost:${port}`];

  if (!['0.0.0.0', '::'].includes(host)) {
    urls.push(`http://${host}:${port}`);
    return Array.from(new Set(urls));
  }

  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }

  return Array.from(new Set(urls));
}

function normalizeTextField(value, maxLength, label, { required = true } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';

  if (required && !normalized) {
    throw new Error(`Informe ${label}.`);
  }

  if (!required && !normalized) {
    return '';
  }

  if (normalized.length > maxLength) {
    throw new Error(`${label} excede o limite de ${maxLength} caracteres.`);
  }

  return normalized;
}

function normalizeHttpUrl(value, label) {
  const normalized = normalizeTextField(value, 500, label);

  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error(`${label} precisa ser uma URL http ou https válida.`);
  }
}

async function ensureStorage() {
  await mkdir(UPLOADS_DIR, { recursive: true });
}

async function syncExistingUploadsToDatabase() {
  const filenames = await readdir(UPLOADS_DIR).catch(() => []);

  for (const filename of filenames) {
    const publicPath = `/uploads/${filename}`;
    const existingAsset = await UploadAsset.exists({ path: publicPath });

    if (existingAsset) {
      continue;
    }

    const absolutePath = path.join(UPLOADS_DIR, filename);
    const extension = path.extname(filename).toLowerCase();
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';
    const buffer = await readFile(absolutePath).catch(() => null);

    if (!buffer) {
      continue;
    }

    await UploadAsset.create({
      path: publicPath,
      contentType,
      data: buffer,
      size: buffer.length,
    });
  }
}

async function findArtTemplates() {
  const entries = await readdir(process.cwd(), { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'pt-BR', { numeric: true }));

  const preferred = files.filter((name) => /^prancheta\s+\d+/i.test(name));
  const candidates = preferred.length ? preferred : files;

  return candidates.map((name) => ({
    id: sanitizeFilename(path.parse(name).name),
    name: path.parse(name).name,
    filename: name,
    absolutePath: path.join(process.cwd(), name),
    qrSlot: {
      x: 0.303,
      y: 0.635,
      size: 0.404,
      padding: 0.021,
    },
  }));
}

function getArtTemplateById(templateId) {
  return ART_TEMPLATES.find((template) => template.id === templateId) || ART_TEMPLATES[0] || null;
}

async function readProducts() {
  const products = await Product.find({}).sort({ createdAt: -1 }).lean();
  return products.map(normalizeProductRecord);
}

function normalizeProductRecord(product) {
  return {
    id: String(product._id),
    slug: product.slug,
    title: product.title,
    rewardMessage: product.rewardMessage,
    artTemplateId: product.artTemplateId,
    qrDarkColor: product.qrDarkColor || '#18181b',
    productImagePath: product.productImagePath,
    createdAt: product.createdAt instanceof Date ? product.createdAt.toISOString() : product.createdAt,
    updatedAt: product.updatedAt instanceof Date ? product.updatedAt.toISOString() : product.updatedAt,
  };
}

function normalizeRaffleCampaignRecord(raffle) {
  return {
    id: String(raffle._id),
    slug: raffle.slug,
    name: raffle.name,
    eligibleProductIds: Array.isArray(raffle.eligibleProductIds)
      ? raffle.eligibleProductIds.map((item) => String(item))
      : [],
    selectedProducts: Array.isArray(raffle.selectedProducts)
      ? raffle.selectedProducts
        .map((item) => ({
          id: String(item.id || item._id || ''),
          slug: item.slug || '',
          title: item.title || '',
          productImagePath: item.productImagePath || '',
        }))
        .filter((item) => item.id && item.title)
      : [],
    totalProducts: Number(raffle.totalProducts) || 0,
    createdAt: raffle.createdAt instanceof Date ? raffle.createdAt.toISOString() : raffle.createdAt,
    updatedAt: raffle.updatedAt instanceof Date ? raffle.updatedAt.toISOString() : raffle.updatedAt,
  };
}

function parseBase64Image(value, fieldName) {
  if (!value) {
    return null;
  }

  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(value);

  if (!match) {
    throw new Error(`${fieldName} precisa ser uma imagem PNG, JPG, WEBP ou GIF.`);
  }

  return {
    mimeType: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], 'base64'),
  };
}

async function saveImageFromDataUrl(dataUrl, label, slug, suffix) {
  const parsed = parseBase64Image(dataUrl, label);

  if (!parsed) {
    return '';
  }

  const extension = IMAGE_EXTENSIONS[parsed.mimeType];
  const filename = `${slug}-${suffix}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
  const absolutePath = path.join(UPLOADS_DIR, filename);
  const publicPath = `/uploads/${filename}`;

  await writeFile(absolutePath, parsed.buffer);
  await UploadAsset.findOneAndUpdate(
    { path: publicPath },
    {
      path: publicPath,
      contentType: parsed.mimeType,
      data: parsed.buffer,
      size: parsed.buffer.length,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );

  return publicPath;
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }

      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        tooLarge = true;
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('Payload excede 10 MB.'));
        return;
      }

      try {
        const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '{}';
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON invalido.'));
      }
    });

    req.on('error', reject);
  });
}

function isSecureRequest(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];

  if (typeof forwardedProto === 'string' && forwardedProto) {
    return forwardedProto.split(',')[0].trim() === 'https';
  }

  return false;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';

  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');

      if (separatorIndex < 0) {
        return cookies;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge / 1000))}`);
  }

  if (options.expires instanceof Date) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  parts.push(`Path=${options.path || '/'}`);

  if (options.httpOnly) {
    parts.push('HttpOnly');
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function appendSetCookieHeader(res, cookieValue) {
  const current = res.getHeader('Set-Cookie');

  if (!current) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }

  const values = Array.isArray(current) ? current.concat(cookieValue) : [current, cookieValue];
  res.setHeader('Set-Cookie', values);
}

function setSessionCookie(req, res, token) {
  appendSetCookieHeader(
    res,
    serializeCookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      maxAge: SESSION_DURATION_MS,
      path: '/',
      sameSite: 'Lax',
      secure: isSecureRequest(req),
    })
  );
}

function clearSessionCookie(req, res) {
  appendSetCookieHeader(
    res,
    serializeCookie(ADMIN_SESSION_COOKIE, '', {
      httpOnly: true,
      maxAge: 0,
      expires: new Date(0),
      path: '/',
      sameSite: 'Lax',
      secure: isSecureRequest(req),
    })
  );
}

function sanitizeUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    login: user.login,
    role: user.role,
  };
}

async function destroySessionByToken(token) {
  if (!token) {
    return;
  }

  await AdminSession.deleteOne({ tokenHash: hashSessionToken(token) });
}

async function createSessionForUser(user) {
  const token = await createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await AdminSession.create({
    userId: user._id,
    tokenHash: hashSessionToken(token),
    expiresAt,
    lastSeenAt: new Date(),
  });

  return token;
}

async function getAuthenticatedUser(req) {
  const cookies = parseCookies(req);
  const sessionToken = cookies[ADMIN_SESSION_COOKIE];

  if (!sessionToken) {
    return null;
  }

  const session = await AdminSession.findOne({ tokenHash: hashSessionToken(sessionToken) }).lean();

  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await AdminSession.deleteOne({ _id: session._id });
    return null;
  }

  const user = await User.findById(session.userId).lean();

  if (!user) {
    await AdminSession.deleteOne({ _id: session._id });
    return null;
  }

  return {
    sessionId: String(session._id),
    sessionToken,
    user: sanitizeUser(user),
  };
}

function normalizeReturnTo(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';

  if (!normalized || !normalized.startsWith('/') || normalized.startsWith('//') || normalized.startsWith('/login')) {
    return '/';
  }

  return normalized;
}

function sendRedirect(res, location, method, statusCode = 302) {
  res.writeHead(statusCode, {
    Location: location,
    'Cache-Control': 'no-store',
  });

  if (method === 'HEAD') {
    res.end();
    return;
  }

  res.end();
}

function buildLoginRedirect(reqUrl) {
  const returnTo = normalizeReturnTo(`${reqUrl.pathname}${reqUrl.search}`);
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

async function requireAuthenticatedRequest(req, res, method) {
  const auth = await getAuthenticatedUser(req);

  if (!auth) {
    sendJson(res, 401, { error: 'Sua sessão expirou. Faça login novamente.' }, method);
    return null;
  }

  return auth;
}

async function requireAuthenticatedPage(req, res, reqUrl, method) {
  const auth = await getAuthenticatedUser(req);

  if (!auth) {
    sendRedirect(res, buildLoginRedirect(reqUrl), method);
    return null;
  }

  return auth;
}

async function handleSessionRequest(req, res, method) {
  const auth = await getAuthenticatedUser(req);

  if (!auth) {
    sendJson(res, 401, { error: 'Sua sessão expirou. Faça login novamente.' }, method);
    return;
  }

  sendJson(res, 200, { authenticated: true, user: auth.user }, method);
}

async function handleLogin(req, res, reqUrl) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Não foi possível ler o corpo da requisição.' }, req.method);
    return;
  }

  try {
    const identifier = normalizeIdentifier(body.identifier);
    const password = normalizePassword(body.password);
    const user = await User.findOne({
      $or: [
        { emailNormalized: identifier },
        { loginNormalized: identifier },
      ],
    });

    if (!user) {
      sendJson(res, 401, { error: 'Login ou senha inválidos.' }, req.method);
      return;
    }

    const passwordMatches = await verifyPassword(password, user.passwordHash);

    if (!passwordMatches) {
      sendJson(res, 401, { error: 'Login ou senha inválidos.' }, req.method);
      return;
    }

    await AdminSession.deleteMany({ userId: user._id, expiresAt: { $lte: new Date() } });
    const sessionToken = await createSessionForUser(user);
    setSessionCookie(req, res, sessionToken);

    sendJson(res, 200, {
      user: sanitizeUser(user),
      redirectTo: normalizeReturnTo(reqUrl.searchParams.get('returnTo') || '/'),
    }, req.method);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Não foi possível fazer login.' }, req.method);
  }
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);

  await destroySessionByToken(cookies[ADMIN_SESSION_COOKIE]);
  clearSessionCookie(req, res);
  sendJson(res, 200, { success: true }, req.method);
}

async function ensureInitialAdmin() {
  const usersCount = await User.countDocuments();

  if (usersCount > 0) {
    return;
  }

  const config = getInitialAdminConfig(process.env);
  await upsertAdminUser(User, config);
  const configuredEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();

  const usingDefaultPassword = !process.env.ADMIN_PASSWORD;
  console.warn('[auth] Usuário admin inicial criado.');
  console.warn(`[auth] Login: ${config.login} | E-mail: ${config.email}`);

  if (configuredEmail && configuredEmail !== config.email) {
    console.warn('[auth] ADMIN_EMAIL inválido no ambiente. Foi aplicado um e-mail fallback para concluir o bootstrap.');
  }

  if (usingDefaultPassword) {
    console.warn('[auth] A senha padrão está ativa. Defina ADMIN_PASSWORD ou rode npm run admin:create.');
  } else {
    console.warn('[auth] A senha inicial foi carregada das variáveis de ambiente.');
  }
}

function buildProductResponse(req, product) {
  const finalPath = `/produto/${product.slug}`;
  const finalUrl = toAbsoluteUrl(req, finalPath);
  const artPath = `/arte/${product.slug}`;
  const artUrl = toAbsoluteUrl(req, artPath);
  const artTemplate = getArtTemplateById(product.artTemplateId);
  const qrDarkColor = normalizeColorParam(product.qrDarkColor, '#18181b');
  const encodedQrDarkColor = encodeURIComponent(qrDarkColor);
  const encodedStandardQrDarkColor = encodeURIComponent('#000000');
  const downloadFilename = sanitizeFilename(product.title || product.slug);

  return {
    ...product,
    rewardMessage: product.rewardMessage || 'Você ganhou este produto.',
    qrDarkColor,
    artTemplate: artTemplate
      ? {
          id: artTemplate.id,
          name: artTemplate.name,
          imageUrl: `/api/art-templates/${encodeURIComponent(artTemplate.id)}/image`,
          qrSlot: artTemplate.qrSlot,
        }
      : null,
    finalPath,
    finalUrl,
    artPath,
    artUrl,
    qrCode: {
      preview: `/api/qrcode?text=${encodeURIComponent(finalUrl)}&width=240&margin=2&filename=${downloadFilename}&rounded=1&darkColor=${encodedQrDarkColor}&lightColor=%23ffffff`,
      png: `/api/qrcode?text=${encodeURIComponent(finalUrl)}&width=540&margin=2&filename=${downloadFilename}&download=1&darkColor=${encodedStandardQrDarkColor}&lightColor=%23ffffff`,
      transparentPng: `/api/qrcode?text=${encodeURIComponent(finalUrl)}&width=540&margin=1&filename=${downloadFilename}-transparente&download=1&darkColor=${encodedStandardQrDarkColor}&backgroundTransparent=1`,
      svg: `/api/qrcode?text=${encodeURIComponent(finalUrl)}&format=svg&width=540&margin=2&filename=${downloadFilename}&download=1&rounded=1&darkColor=${encodedQrDarkColor}&lightColor=%23ffffff`,
      pdf: `/api/qrcode?text=${encodeURIComponent(finalUrl)}&format=pdf&width=540&margin=2&filename=${downloadFilename}&download=1&rounded=1&darkColor=${encodedQrDarkColor}&lightColor=%23ffffff`,
      art: `/api/qrcode?text=${encodeURIComponent(finalUrl)}&width=360&margin=1&filename=${downloadFilename}&darkColor=${encodedStandardQrDarkColor}&backgroundTransparent=1`,
    },
  };
}

function buildPublicProductResponse(product) {
  const artTemplate = getArtTemplateById(product.artTemplateId);

  return {
    slug: product.slug,
    title: product.title,
    rewardMessage: product.rewardMessage || 'Você ganhou este produto.',
    productImagePath: product.productImagePath,
    artTemplate: artTemplate
      ? {
          id: artTemplate.id,
          name: artTemplate.name,
          imageUrl: `/api/public/art-templates/${encodeURIComponent(artTemplate.id)}/image`,
          qrSlot: artTemplate.qrSlot,
        }
      : null,
  };
}

function buildRaffleResponse(req, raffle, drawCount = 0) {
  const publicPath = `/sorteio/${raffle.slug}`;
  const publicUrl = toAbsoluteUrl(req, publicPath);
  const safeName = sanitizeFilename(raffle.name || raffle.slug || 'sorteio');
  const totalProducts = Number(raffle.totalProducts) || 0;
  const drawnProducts = Math.max(0, Number(drawCount) || 0);
  const remainingProducts = Math.max(0, totalProducts - drawnProducts);

  return {
    ...raffle,
    selectedProducts: Array.isArray(raffle.selectedProducts) ? raffle.selectedProducts : [],
    publicPath,
    publicUrl,
    drawnProducts,
    remainingProducts,
    exhausted: remainingProducts === 0,
    qrCode: {
      preview: `/api/qrcode?text=${encodeURIComponent(publicUrl)}&width=240&margin=1&filename=${safeName}-sorteio&darkColor=%23000000&backgroundTransparent=1`,
      png: `/api/qrcode?text=${encodeURIComponent(publicUrl)}&width=540&margin=1&filename=${safeName}-sorteio&download=1&darkColor=%23000000&backgroundTransparent=1`,
      svg: `/api/qrcode?text=${encodeURIComponent(publicUrl)}&format=svg&width=540&margin=2&filename=${safeName}-sorteio&download=1&rounded=1&darkColor=%23e72636&lightColor=%23ffffff`,
    },
  };
}

async function attachSelectedProductsToRaffles(raffles = []) {
  if (!raffles.length) {
    return [];
  }

  const raffleIds = raffles.map((item) => item.id).filter(Boolean);
  const productIds = [...new Set(
    raffles.flatMap((item) => Array.isArray(item.eligibleProductIds) ? item.eligibleProductIds : [])
  )].filter(Boolean);

  if (!productIds.length) {
    return raffles.map((item) => ({ ...item, selectedProducts: [] }));
  }

  const objectIds = productIds.map((id) => new mongoose.Types.ObjectId(id));
  const productRecords = await Product.find(
    { _id: { $in: objectIds } },
    { _id: 1, slug: 1, title: 1, productImagePath: 1 }
  ).lean();

  const productMap = new Map(
    productRecords.map((item) => [
      String(item._id),
      {
        id: String(item._id),
        slug: item.slug,
        title: item.title,
        productImagePath: item.productImagePath || '',
      },
    ])
  );

  const drawRecords = raffleIds.length
    ? await RaffleDraw.find(
      {
        raffleId: {
          $in: raffleIds.map((id) => new mongoose.Types.ObjectId(id)),
        },
      },
      { _id: 1, raffleId: 1, productId: 1, createdAt: 1 }
    ).lean()
    : [];

  const drawnByRaffle = new Map();

  drawRecords.forEach((item) => {
    const raffleId = String(item.raffleId);
    const productId = String(item.productId);
    const product = productMap.get(productId);
    const entry = {
      id: productId,
      slug: product?.slug || '',
      title: product?.title || 'Produto distribuído',
      productImagePath: product?.productImagePath || '',
      drawId: String(item._id),
      drawnAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      isDrawn: true,
    };

    const existing = drawnByRaffle.get(raffleId) || [];
    existing.push(entry);
    drawnByRaffle.set(raffleId, existing);
  });

  return raffles.map((item) => {
    const drawnProductsList = (drawnByRaffle.get(item.id) || []).sort((left, right) =>
      String(right.drawnAt || '').localeCompare(String(left.drawnAt || ''))
    );
    const drawnIdSet = new Set(drawnProductsList.map((product) => product.id));
    const availableProducts = item.eligibleProductIds
      .map((productId) => productMap.get(String(productId)))
      .filter(Boolean)
      .filter((product) => !drawnIdSet.has(product.id))
      .map((product) => ({
        ...product,
        drawId: '',
        drawnAt: '',
        isDrawn: false,
      }));

    return {
      ...item,
      selectedProducts: [...drawnProductsList, ...availableProducts],
      drawnProductsList,
      availableProducts,
    };
  });
}

async function getRaffleDrawCountMap(raffleIds = []) {
  if (!raffleIds.length) {
    return new Map();
  }

  const objectIds = raffleIds.map((id) => new mongoose.Types.ObjectId(id));
  const counts = await RaffleDraw.aggregate([
    {
      $match: {
        raffleId: { $in: objectIds },
      },
    },
    {
      $group: {
        _id: '$raffleId',
        count: { $sum: 1 },
      },
    },
  ]);

  return new Map(counts.map((item) => [String(item._id), item.count]));
}

async function listRaffles(req, res, method) {
  const raffles = await RaffleCampaign.find({}).sort({ createdAt: -1 }).lean();
  const normalized = await attachSelectedProductsToRaffles(raffles.map(normalizeRaffleCampaignRecord));
  const drawCountMap = await getRaffleDrawCountMap(normalized.map((item) => item.id));

  sendJson(res, 200, {
    items: normalized.map((item) => buildRaffleResponse(req, item, drawCountMap.get(item.id) || 0)),
  }, method);
}

async function createRaffle(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Não foi possível ler o corpo da requisição.' }, req.method);
    return;
  }

  try {
    const name = normalizeTextField(body.name, 90, 'o nome do sorteio');
    const productIds = Array.isArray(body.productIds)
      ? [...new Set(body.productIds.map((item) => String(item || '').trim()).filter(Boolean))]
      : [];

    if (!productIds.length) {
      throw new Error('Selecione ao menos um produto para este sorteio.');
    }

    const hasInvalidId = productIds.some((item) => !mongoose.isValidObjectId(item));

    if (hasInvalidId) {
      throw new Error('A seleção de produtos deste sorteio é inválida.');
    }

    const objectIds = productIds.map((item) => new mongoose.Types.ObjectId(item));
    const productRecords = await Product.find(
      { _id: { $in: objectIds } },
      { _id: 1, slug: 1, title: 1, productImagePath: 1 }
    ).lean();

    if (!productRecords.length) {
      throw new Error('Cadastre ao menos um produto antes de criar um sorteio.');
    }

    const productMap = new Map(productRecords.map((item) => [String(item._id), item]));
    const selectedProducts = productIds
      .map((item) => productMap.get(item))
      .filter(Boolean)
      .map((item) => ({
        id: String(item._id),
        slug: item.slug,
        title: item.title,
        productImagePath: item.productImagePath || '',
      }));

    if (selectedProducts.length !== productIds.length) {
      throw new Error('Um ou mais produtos selecionados não foram encontrados.');
    }

    const slug = await generateUniqueRaffleSlug(name);
    const raffleRecord = await RaffleCampaign.create({
      slug,
      name,
      eligibleProductIds: selectedProducts.map((item) => new mongoose.Types.ObjectId(item.id)),
      totalProducts: selectedProducts.length,
    });

    const raffle = normalizeRaffleCampaignRecord({
      ...raffleRecord.toObject(),
      selectedProducts,
    });
    sendJson(res, 201, buildRaffleResponse(req, raffle, 0), req.method);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Não foi possível criar o sorteio.' }, req.method);
  }
}

async function restoreDrawnProductToRaffle(req, res, raffleId, productId) {
  if (!mongoose.isValidObjectId(raffleId) || !mongoose.isValidObjectId(productId)) {
    sendJson(res, 400, { error: 'Os identificadores do sorteio ou do produto são inválidos.' }, req.method);
    return;
  }

  const raffleRecord = await RaffleCampaign.findById(raffleId).lean();

  if (!raffleRecord) {
    sendJson(res, 404, { error: 'Sorteio não encontrado.' }, req.method);
    return;
  }

  const eligibleProductIds = Array.isArray(raffleRecord.eligibleProductIds)
    ? raffleRecord.eligibleProductIds.map((item) => String(item))
    : [];

  if (!eligibleProductIds.includes(productId)) {
    sendJson(res, 404, { error: 'Este produto não está vinculado a este sorteio.' }, req.method);
    return;
  }

  const raffleObjectId = new mongoose.Types.ObjectId(raffleId);
  const productObjectId = new mongoose.Types.ObjectId(productId);
  const drawRecord = await RaffleDraw.findOne({
    raffleId: raffleObjectId,
    productId: productObjectId,
  }).lean();

  if (!drawRecord) {
    sendJson(res, 409, { error: 'Este produto ainda não foi sorteado nesta campanha.' }, req.method);
    return;
  }

  await RaffleDraw.deleteOne({ _id: drawRecord._id });

  const updatedRecord = await RaffleCampaign.findById(raffleObjectId).lean();
  const [raffle] = await attachSelectedProductsToRaffles([
    normalizeRaffleCampaignRecord(updatedRecord),
  ]);
  const drawCountMap = await getRaffleDrawCountMap([raffle.id]);

  sendJson(res, 200, buildRaffleResponse(req, raffle, drawCountMap.get(raffle.id) || 0), req.method);
}

async function deleteRaffle(req, res, raffleId) {
  if (!mongoose.isValidObjectId(raffleId)) {
    sendJson(res, 400, { error: 'O identificador do sorteio é inválido.' }, req.method);
    return;
  }

  const raffleObjectId = new mongoose.Types.ObjectId(raffleId);
  const raffleRecord = await RaffleCampaign.findById(raffleObjectId).lean();

  if (!raffleRecord) {
    sendJson(res, 404, { error: 'Sorteio não encontrado.' }, req.method);
    return;
  }

  await RaffleDraw.deleteMany({ raffleId: raffleObjectId });
  await RaffleCampaign.deleteOne({ _id: raffleObjectId });

  sendJson(res, 200, {
    success: true,
    id: String(raffleRecord._id),
  }, req.method);
}

async function getPublicRaffleBySlug(req, res, method, slug) {
  const raffleRecord = await RaffleCampaign.findOne({ slug }).lean();

  if (!raffleRecord) {
    sendJson(res, 404, { error: 'Sorteio não encontrado.' }, method);
    return;
  }

  const raffle = normalizeRaffleCampaignRecord(raffleRecord);
  const drawCountMap = await getRaffleDrawCountMap([raffle.id]);
  const payload = buildRaffleResponse(req, raffle, drawCountMap.get(raffle.id) || 0);

  sendJson(res, 200, {
    slug: payload.slug,
    name: payload.name,
    publicPath: payload.publicPath,
    publicUrl: payload.publicUrl,
    totalProducts: payload.totalProducts,
    drawnProducts: payload.drawnProducts,
    remainingProducts: payload.remainingProducts,
    exhausted: payload.exhausted,
  }, method);
}

async function claimRaffleProductBySlug(slug) {
  const raffleRecord = await RaffleCampaign.findOne({ slug }).lean();

  if (!raffleRecord) {
    return {
      status: 404,
      exhausted: false,
      error: 'Sorteio não encontrado.',
      product: null,
    };
  }

  const raffleId = raffleRecord._id;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const drawRecords = await RaffleDraw.find({ raffleId }, { productId: 1, _id: 0 }).lean();
    const drawnProductIds = drawRecords.map((item) => item.productId);
    const drawnCount = drawnProductIds.length;

    if (drawnCount >= raffleRecord.totalProducts) {
      return {
        status: 409,
        error: 'Todos os produtos deste sorteio já foram distribuídos.',
        exhausted: true,
        product: null,
      };
    }

    const availableProducts = await Product.aggregate([
      {
        $match: {
          _id: {
            $in: raffleRecord.eligibleProductIds,
            $nin: drawnProductIds,
          },
        },
      },
      {
        $sample: {
          size: 1,
        },
      },
      {
        $project: {
          _id: 1,
          slug: 1,
          title: 1,
          rewardMessage: 1,
          productImagePath: 1,
        },
      },
    ]);

    const selectedProduct = availableProducts[0];

    if (!selectedProduct) {
      return {
        status: 409,
        error: 'Todos os produtos deste sorteio já foram distribuídos.',
        exhausted: true,
        product: null,
      };
    }

    try {
      await RaffleDraw.create({
        raffleId,
        productId: selectedProduct._id,
      });

      return {
        status: 200,
        exhausted: false,
        product: {
          slug: selectedProduct.slug,
          title: selectedProduct.title,
          rewardMessage: selectedProduct.rewardMessage || 'Você ganhou este produto.',
          productImagePath: selectedProduct.productImagePath || '',
          path: `/produto/${selectedProduct.slug}`,
        },
        error: '',
      };
    } catch (error) {
      if (error?.code === 11000) {
        continue;
      }

      throw error;
    }
  }

  return {
    status: 409,
    error: 'Não foi possível concluir o sorteio agora. Tente novamente.',
    exhausted: false,
    product: null,
  };
}

async function drawRaffleProduct(req, res, slug) {
  const result = await claimRaffleProductBySlug(slug);
  sendJson(res, result.status, {
    exhausted: result.exhausted,
    error: result.error,
    product: result.product,
  }, req.method);
}

function sendPublicRaffleError(res, method, title, message, statusCode = 409) {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: "Trebuchet MS", "Avenir Next", "Segoe UI", sans-serif; background: #fff9f3; color: #331018; }
      main { width: min(520px, calc(100% - 24px)); padding: 24px; border-radius: 28px; background: rgba(255, 251, 247, 0.96); border: 1px solid rgba(91, 24, 33, 0.08); box-shadow: 0 28px 70px rgba(88, 15, 28, 0.14); }
      h1 { margin: 0 0 12px; font-size: 2rem; }
      p { margin: 0; line-height: 1.5; color: #7d4953; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;

  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  if (method === 'HEAD') {
    res.end();
    return;
  }

  res.end(html);
}

async function redirectPublicRaffleToProduct(req, res, method, slug) {
  const result = await claimRaffleProductBySlug(slug);

  if (result.status === 200 && result.product?.path) {
    sendRedirect(res, result.product.path, method, 302);
    return;
  }

  if (result.exhausted) {
    sendPublicRaffleError(res, method, 'Sorteio encerrado', result.error || 'Todos os produtos desta campanha já foram distribuídos.', 409);
    return;
  }

  sendPublicRaffleError(res, method, 'Sorteio indisponível', result.error || 'Não foi possível concluir o sorteio.', result.status || 500);
}

async function listProducts(req, res, method) {
  const products = await readProducts();
  const ordered = products.map((product) => buildProductResponse(req, product));

  sendJson(res, 200, { items: ordered }, method);
}

async function listArtTemplates(res, method) {
  sendJson(res, 200, {
    items: ART_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      imageUrl: `/api/art-templates/${encodeURIComponent(template.id)}/image`,
      qrSlot: template.qrSlot,
    })),
  }, method);
}

async function getProductBySlug(req, res, method, slug) {
  const productRecord = await Product.findOne({ slug }).lean();
  const product = productRecord ? normalizeProductRecord(productRecord) : null;

  if (!product) {
    sendJson(res, 404, { error: 'Produto não encontrado.' }, method);
    return;
  }

  sendJson(res, 200, buildProductResponse(req, product), method);
}

async function getPublicProductBySlug(res, method, slug) {
  const productRecord = await Product.findOne({ slug }).lean();
  const product = productRecord ? normalizeProductRecord(productRecord) : null;

  if (!product) {
    sendJson(res, 404, { error: 'Produto não encontrado.' }, method);
    return;
  }

  sendJson(res, 200, buildPublicProductResponse(product), method);
}

async function createProduct(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Não foi possível ler o corpo da requisição.' }, req.method);
    return;
  }

  try {
    const title = normalizeTextField(body.title, 90, 'o nome do produto ou prêmio');
    const rewardMessage = normalizeTextField(body.rewardMessage, 600, 'a mensagem do prêmio');
    const productImage = normalizeTextField(body.productImage, 8_000_000, 'a foto do produto');
    const artTemplateId = normalizeTextField(body.artTemplateId, 80, 'a arte base selecionada');
    const qrDarkColor = normalizeColorParam(body.qrDarkColor, '#18181b');
    const artTemplate = getArtTemplateById(artTemplateId);

    if (!artTemplate) {
      throw new Error('Selecione uma arte base válida.');
    }

    const slug = await generateUniqueSlug(title);

    const productImagePath = await saveImageFromDataUrl(productImage, 'A foto do produto', slug, 'produto');
    const createdProduct = await Product.create({
      slug,
      title,
      rewardMessage,
      artTemplateId: artTemplate.id,
      qrDarkColor,
      productImagePath,
    });

    sendJson(res, 201, buildProductResponse(req, normalizeProductRecord(createdProduct.toObject())), req.method);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Não foi possível criar o produto.' }, req.method);
  }
}

async function updateProduct(req, res, slug) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Não foi possível ler o corpo da requisição.' }, req.method);
    return;
  }

  try {
    const existingRecord = await Product.findOne({ slug });

    if (!existingRecord) {
      sendJson(res, 404, { error: 'Produto não encontrado.' }, req.method);
      return;
    }

    const title = normalizeTextField(body.title, 90, 'o nome do produto ou prêmio');
    const rewardMessage = normalizeTextField(body.rewardMessage, 600, 'a mensagem do prêmio');
    const artTemplateId = normalizeTextField(body.artTemplateId, 80, 'a arte base selecionada');
    const qrDarkColor = normalizeColorParam(body.qrDarkColor, '#18181b');
    const artTemplate = getArtTemplateById(artTemplateId);

    if (!artTemplate) {
      throw new Error('Selecione uma arte base válida.');
    }

    let productImagePath = existingRecord.productImagePath;

    if (typeof body.productImage === 'string' && body.productImage.trim()) {
      const productImage = normalizeTextField(body.productImage, 8_000_000, 'a foto do produto');
      productImagePath = await saveImageFromDataUrl(productImage, 'A foto do produto', existingRecord.slug, 'produto');
    }

    existingRecord.title = title;
    existingRecord.rewardMessage = rewardMessage;
    existingRecord.artTemplateId = artTemplate.id;
    existingRecord.qrDarkColor = qrDarkColor;
    existingRecord.productImagePath = productImagePath;
    await existingRecord.save();

    sendJson(res, 200, buildProductResponse(req, normalizeProductRecord(existingRecord.toObject())), req.method);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Não foi possível atualizar o produto.' }, req.method);
  }
}

async function connectDatabase() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
  } catch (error) {
    console.error(`Não foi possível conectar ao Mongo em ${MONGO_URI}`);
    throw error;
  }
}

function createProductModel() {
  const productSchema = new mongoose.Schema(
    {
      slug: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },
      title: {
        type: String,
        required: true,
        trim: true,
      },
      rewardMessage: {
        type: String,
        required: true,
        trim: true,
      },
      artTemplateId: {
        type: String,
        required: true,
        trim: true,
      },
      qrDarkColor: {
        type: String,
        required: true,
        trim: true,
        default: '#18181b',
      },
      productImagePath: {
        type: String,
        required: true,
        trim: true,
      },
    },
    {
      timestamps: true,
      versionKey: false,
    }
  );

  return mongoose.models.Product || mongoose.model('Product', productSchema);
}

function createUploadAssetModel() {
  const uploadAssetSchema = new mongoose.Schema(
    {
      path: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },
      contentType: {
        type: String,
        required: true,
      },
      data: {
        type: Buffer,
        required: true,
      },
      size: {
        type: Number,
        required: true,
        min: 0,
      },
    },
    {
      timestamps: true,
      versionKey: false,
    }
  );

  return mongoose.models.UploadAsset || mongoose.model('UploadAsset', uploadAssetSchema);
}

function createRaffleCampaignModel() {
  const raffleCampaignSchema = new mongoose.Schema(
    {
      slug: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },
      name: {
        type: String,
        required: true,
        trim: true,
      },
      eligibleProductIds: {
        type: [mongoose.Schema.Types.ObjectId],
        required: true,
        default: [],
      },
      totalProducts: {
        type: Number,
        required: true,
        min: 0,
      },
    },
    {
      timestamps: true,
      versionKey: false,
    }
  );

  return mongoose.models.RaffleCampaign || mongoose.model('RaffleCampaign', raffleCampaignSchema);
}

function createRaffleDrawModel() {
  const raffleDrawSchema = new mongoose.Schema(
    {
      raffleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RaffleCampaign',
        required: true,
        index: true,
      },
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
      },
    },
    {
      timestamps: true,
      versionKey: false,
    }
  );

  raffleDrawSchema.index({ raffleId: 1, productId: 1 }, { unique: true });

  return mongoose.models.RaffleDraw || mongoose.model('RaffleDraw', raffleDrawSchema);
}

async function generateUniqueSlug(title) {
  const baseSlug = createSlug(title);
  let slug = baseSlug;
  let attempt = 0;

  while (await Product.exists({ slug })) {
    attempt += 1;
    slug = `${baseSlug}-${crypto.randomUUID().slice(0, 4 + Math.min(attempt, 2))}`;
  }

  return slug;
}

async function generateUniqueRaffleSlug(name) {
  const baseSlug = createSlug(name);
  let slug = baseSlug;
  let attempt = 0;

  while (await RaffleCampaign.exists({ slug })) {
    attempt += 1;
    slug = `${baseSlug}-${crypto.randomUUID().slice(0, 4 + Math.min(attempt, 2))}`;
  }

  return slug;
}

async function migrateLegacyProducts() {
  let raw = '[]';

  try {
    raw = await readFile(PRODUCTS_FILE, 'utf8');
  } catch {
    return;
  }

  let legacyProducts = [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      legacyProducts = parsed;
    }
  } catch {
    return;
  }

  if (!legacyProducts.length) {
    return;
  }

  const existingCount = await Product.countDocuments();
  if (existingCount > 0) {
    return;
  }

  const docs = legacyProducts
    .filter((item) => item?.slug && item?.title && item?.rewardMessage && item?.artTemplateId && item?.productImagePath)
    .map((item) => ({
      slug: item.slug,
      title: item.title,
      rewardMessage: item.rewardMessage,
      artTemplateId: item.artTemplateId,
      qrDarkColor: normalizeColorParam(item.qrDarkColor, '#18181b'),
      productImagePath: item.productImagePath,
      createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
      updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
    }));

  if (!docs.length) {
    return;
  }

  await Product.insertMany(docs, { ordered: false });
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

    doc.fillColor('#c81e1e').font('Helvetica-Bold').fontSize(24).text('QR do produto', 40, 44);
    doc.fillColor('#6b2130').font('Helvetica').fontSize(11).text('Use este arquivo para montar a arte final.', 40, 74);

    const imageX = (pageWidth - qrWidth) / 2;
    const imageY = 122;
    doc.image(imageBuffer, imageX, imageY, { width: qrWidth });

    const infoY = imageY + qrWidth + 28;
    doc.roundedRect(40, infoY, pageWidth - 80, 118, 18).fill('#fff5f5');
    doc.fillColor('#8a5160').font('Helvetica-Bold').fontSize(10).text('Link final do produto', 58, infoY + 18);
    doc.fillColor('#2b1018').font('Helvetica').fontSize(12).text(encodedText, 58, infoY + 40, {
      width: pageWidth - 116,
      height: 60,
      ellipsis: true,
    });

    doc.end();
  });
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

  const qrOptions = getQrRenderOptions(reqUrl.searchParams);
  const baseFilename = sanitizeFilename(reqUrl.searchParams.get('filename') || deriveFilename(text));
  const shouldDownload = reqUrl.searchParams.get('download') === '1';
  const downloadHeader = shouldDownload
    ? { 'Content-Disposition': `attachment; filename="${baseFilename}.${format}"` }
    : {};

  try {
    const qrPngResult = format === 'pdf'
      ? await generateQrCode({
          data: text,
          ...qrOptions,
          format: 'png',
        })
      : null;

    if (format === 'svg') {
      const qrResult = await generateQrCode({
        data: text,
        ...qrOptions,
        format: 'svg',
      });
      sendBuffer(res, 200, qrResult.buffer, {
        'Content-Type': qrResult.contentType,
        'Cache-Control': 'no-store',
        ...downloadHeader,
      }, method);
      return;
    }

    if (format === 'png') {
      const qrResult = await generateQrCode({
        data: text,
        ...qrOptions,
        format: 'png',
      });
      sendBuffer(res, 200, qrResult.buffer, {
        'Content-Type': qrResult.contentType,
        'Cache-Control': 'no-store',
        ...downloadHeader,
      }, method);
      return;
    }

    const pdfBuffer = await createPdfBuffer(qrPngResult.buffer, text, qrOptions.size);
    sendBuffer(res, 200, pdfBuffer, {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'no-store',
      ...downloadHeader,
    }, method);
  } catch (error) {
    console.error('Erro ao gerar QR Code:', error);
    sendJson(res, 500, { error: 'Não foi possível gerar o QR Code.' }, method);
  }
}

async function handleArtTemplateImageRequest(res, method, templateId) {
  const template = getArtTemplateById(templateId);

  if (!template) {
    sendJson(res, 404, { error: 'Arte base não encontrada.' }, method);
    return;
  }

  try {
    const file = await readFile(template.absolutePath);
    const extension = path.extname(template.absolutePath).toLowerCase();
    sendBuffer(res, 200, file, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }, method);
  } catch {
    sendJson(res, 500, { error: 'Não foi possível carregar a arte base.' }, method);
  }
}

async function serveUploadAssetFromDatabase(reqPath, res, method) {
  const asset = await UploadAsset.findOne({ path: reqPath }).lean();

  if (!asset?.data) {
    sendJson(res, 404, { error: 'Arquivo não encontrado.' }, method);
    return;
  }

  sendBuffer(res, 200, Buffer.from(asset.data), {
    'Content-Type': asset.contentType || 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600',
    'Content-Length': String(asset.size || Buffer.byteLength(asset.data)),
  }, method);
}

async function serveStaticFile(reqPath, res, method) {
  const cleanPath = reqPath === '/' ? '/index.html' : reqPath;
  const normalizedPath = path.normalize(cleanPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const absolutePath = path.join(PUBLIC_DIR, normalizedPath);

  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Acesso negado.' }, method);
    return;
  }

  try {
    const file = await readFile(absolutePath);
    const extension = path.extname(absolutePath);
    sendBuffer(res, 200, file, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.webp' || extension === '.gif'
        ? 'public, max-age=3600'
        : 'no-store',
    }, method);
  } catch {
    if (reqPath.startsWith('/uploads/')) {
      await serveUploadAssetFromDatabase(reqPath, res, method);
      return;
    }

    sendJson(res, 404, { error: 'Arquivo não encontrado.' }, method);
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', getBaseUrl(req));
  const method = req.method || 'GET';

  if (reqUrl.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' }, method);
    return;
  }

  if ((reqUrl.pathname === '/login' || reqUrl.pathname === '/login.html') && ['GET', 'HEAD'].includes(method)) {
    const auth = await getAuthenticatedUser(req);

    if (auth) {
      sendRedirect(res, normalizeReturnTo(reqUrl.searchParams.get('returnTo') || '/'), method);
      return;
    }

    await serveStaticFile('/login.html', res, method);
    return;
  }

  if (reqUrl.pathname === '/api/auth/login' && method === 'POST') {
    await handleLogin(req, res, reqUrl);
    return;
  }

  if (reqUrl.pathname === '/api/auth/logout' && method === 'POST') {
    await handleLogout(req, res);
    return;
  }

  if (reqUrl.pathname === '/api/auth/session' && ['GET', 'HEAD'].includes(method)) {
    await handleSessionRequest(req, res, method);
    return;
  }

  if (reqUrl.pathname.startsWith('/api/public/raffles/') && reqUrl.pathname.endsWith('/draw') && method === 'POST') {
    const slug = decodeURIComponent(reqUrl.pathname.replace('/api/public/raffles/', '').replace('/draw', '').replace(/\/$/, ''));

    try {
      await drawRaffleProduct(req, res, slug);
    } catch (error) {
      console.error('Erro ao sortear produto:', error);
      sendJson(res, 500, { error: 'Não foi possível concluir o sorteio.' }, method);
    }

    return;
  }

  if (reqUrl.pathname.startsWith('/api/public/raffles/') && ['GET', 'HEAD'].includes(method)) {
    const slug = decodeURIComponent(reqUrl.pathname.replace('/api/public/raffles/', '').replace(/\/$/, ''));
    await getPublicRaffleBySlug(req, res, method, slug);
    return;
  }

  if (reqUrl.pathname.startsWith('/api/public/products/') && ['GET', 'HEAD'].includes(method)) {
    const slug = decodeURIComponent(reqUrl.pathname.replace('/api/public/products/', '').trim());
    await getPublicProductBySlug(res, method, slug);
    return;
  }

  if (reqUrl.pathname.startsWith('/api/public/art-templates/') && reqUrl.pathname.endsWith('/image') && ['GET', 'HEAD'].includes(method)) {
    const templateId = decodeURIComponent(reqUrl.pathname.replace('/api/public/art-templates/', '').replace('/image', '').replace(/\/$/, ''));
    await handleArtTemplateImageRequest(res, method, templateId);
    return;
  }

  if (reqUrl.pathname.startsWith('/produto/')) {
    await serveStaticFile('/product.html', res, method);
    return;
  }

  if (reqUrl.pathname.startsWith('/sorteio/') && ['GET', 'HEAD'].includes(method)) {
    const slug = decodeURIComponent(reqUrl.pathname.replace('/sorteio/', '').replace(/\/$/, ''));
    await redirectPublicRaffleToProduct(req, res, method, slug);
    return;
  }

  if (reqUrl.pathname === '/api/qrcode' && ['GET', 'HEAD'].includes(method)) {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    await handleQrRequest(reqUrl, res, method);
    return;
  }

  if (reqUrl.pathname === '/api/art-templates' && ['GET', 'HEAD'].includes(method)) {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    await listArtTemplates(res, method);
    return;
  }

  if (reqUrl.pathname.startsWith('/api/art-templates/') && reqUrl.pathname.endsWith('/image') && ['GET', 'HEAD'].includes(method)) {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    const templateId = decodeURIComponent(reqUrl.pathname.replace('/api/art-templates/', '').replace('/image', '').replace(/\/$/, ''));
    await handleArtTemplateImageRequest(res, method, templateId);
    return;
  }

  if (reqUrl.pathname === '/api/products' && ['GET', 'HEAD'].includes(method)) {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    await listProducts(req, res, method);
    return;
  }

  if (reqUrl.pathname === '/api/raffles' && ['GET', 'HEAD'].includes(method)) {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    await listRaffles(req, res, method);
    return;
  }

  if (reqUrl.pathname.startsWith('/api/raffles/') && method === 'DELETE' && !reqUrl.pathname.includes('/products/')) {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    const raffleId = reqUrl.pathname.split('/').filter(Boolean)[2] || '';
    await deleteRaffle(req, res, raffleId);
    return;
  }

  if (reqUrl.pathname.startsWith('/api/raffles/') && reqUrl.pathname.includes('/products/') && method === 'DELETE') {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    const segments = reqUrl.pathname.split('/').filter(Boolean);
    const raffleId = segments[2] || '';
    const productId = segments[4] || '';
    await restoreDrawnProductToRaffle(req, res, raffleId, productId);
    return;
  }

  if (reqUrl.pathname === '/api/raffles' && method === 'POST') {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    await createRaffle(req, res);
    return;
  }

  if (reqUrl.pathname === '/api/products' && method === 'POST') {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    await createProduct(req, res);
    return;
  }

  if (reqUrl.pathname.startsWith('/api/products/') && ['GET', 'HEAD'].includes(method)) {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    const slug = decodeURIComponent(reqUrl.pathname.replace('/api/products/', '').trim());
    await getProductBySlug(req, res, method, slug);
    return;
  }

  if (reqUrl.pathname.startsWith('/api/products/') && method === 'PUT') {
    const auth = await requireAuthenticatedRequest(req, res, method);

    if (!auth) {
      return;
    }

    const slug = decodeURIComponent(reqUrl.pathname.replace('/api/products/', '').trim());
    await updateProduct(req, res, slug);
    return;
  }

  if (reqUrl.pathname.startsWith('/arte/')) {
    const auth = await requireAuthenticatedPage(req, res, reqUrl, method);

    if (!auth) {
      return;
    }

    await serveStaticFile('/art.html', res, method);
    return;
  }

  if (['/', '/index.html'].includes(reqUrl.pathname)) {
    const auth = await requireAuthenticatedPage(req, res, reqUrl, method);

    if (!auth) {
      return;
    }

    await serveStaticFile('/index.html', res, method);
    return;
  }

  if (['/produtos', '/products.html'].includes(reqUrl.pathname)) {
    const auth = await requireAuthenticatedPage(req, res, reqUrl, method);

    if (!auth) {
      return;
    }

    await serveStaticFile('/products.html', res, method);
    return;
  }

  if (['/sorteios', '/raffles.html'].includes(reqUrl.pathname)) {
    const auth = await requireAuthenticatedPage(req, res, reqUrl, method);

    if (!auth) {
      return;
    }

    await serveStaticFile('/raffles.html', res, method);
    return;
  }

  if (reqUrl.pathname === '/art.html' && ['GET', 'HEAD'].includes(method)) {
    const auth = await requireAuthenticatedPage(req, res, reqUrl, method);

    if (!auth) {
      return;
    }

    await serveStaticFile('/art.html', res, method);
    return;
  }

  if (reqUrl.pathname === '/product.html' && ['GET', 'HEAD'].includes(method)) {
    sendJson(res, 404, { error: 'Página não encontrada.' }, method);
    return;
  }

  if (reqUrl.pathname === '/raffle.html' && ['GET', 'HEAD'].includes(method)) {
    sendJson(res, 404, { error: 'Página não encontrada.' }, method);
    return;
  }

  if (!['GET', 'HEAD'].includes(method)) {
    sendJson(res, 405, { error: 'Método não permitido.' }, method);
    return;
  }

  if (reqUrl.pathname.endsWith('.html') && !PUBLIC_STATIC_PATHS.has(reqUrl.pathname)) {
    sendJson(res, 404, { error: 'Página não encontrada.' }, method);
    return;
  }

  await serveStaticFile(reqUrl.pathname, res, method);
});

server.listen(PORT, HOST, () => {
  const urls = getStartupUrls(HOST, PORT);
  console.log('QR Code app pronta em:');
  for (const url of urls) {
    console.log(`- ${url}`);
  }
});
