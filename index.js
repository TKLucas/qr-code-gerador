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
await migrateLegacyProducts();
await ensureInitialAdmin();

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

  await writeFile(absolutePath, parsed.buffer);

  return `/uploads/${filename}`;
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

  const usingDefaultPassword = !process.env.ADMIN_PASSWORD;
  console.warn('[auth] Usuário admin inicial criado.');
  console.warn(`[auth] Login: ${config.login} | E-mail: ${config.email}`);

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
