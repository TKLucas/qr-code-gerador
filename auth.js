import crypto from 'node:crypto';
import { promisify } from 'node:util';
import mongoose from 'mongoose';

const scryptAsync = promisify(crypto.scrypt);

export const ADMIN_SESSION_COOKIE = 'qr_admin_session';
export const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7;
export const DEFAULT_ADMIN_NAME = 'Administrador';
export const DEFAULT_ADMIN_LOGIN = 'admin';
export const DEFAULT_ADMIN_EMAIL = 'admin@example.local';
export const DEFAULT_ADMIN_PASSWORD = 'admin123456';

function normalizeWhitespace(value = '') {
  return String(value).trim().replace(/\s+/g, ' ');
}

export function normalizeDisplayName(value = '') {
  const normalized = normalizeWhitespace(value);

  if (!normalized) {
    throw new Error('Informe o nome do administrador.');
  }

  if (normalized.length > 80) {
    throw new Error('O nome do administrador excede o limite de 80 caracteres.');
  }

  return normalized;
}

export function normalizeEmail(value = '') {
  const normalized = String(value).trim().toLowerCase();

  if (!normalized) {
    throw new Error('Informe o e-mail do administrador.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(normalized)) {
    throw new Error('Informe um e-mail de administrador válido.');
  }

  return normalized;
}

export function normalizeLogin(value = '') {
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  if (!normalized) {
    throw new Error('Informe o login do administrador.');
  }

  return normalized;
}

export function deriveLoginFromEmail(email = '') {
  const localPart = String(email).split('@')[0] || DEFAULT_ADMIN_LOGIN;
  return normalizeLogin(localPart);
}

export function normalizePassword(value = '') {
  const normalized = String(value);

  if (!normalized.trim()) {
    throw new Error('Informe a senha do administrador.');
  }

  if (normalized.length < 8) {
    throw new Error('A senha do administrador precisa ter ao menos 8 caracteres.');
  }

  if (normalized.length > 128) {
    throw new Error('A senha do administrador excede o limite de 128 caracteres.');
  }

  return normalized;
}

export function normalizeIdentifier(value = '') {
  const normalized = String(value).trim().toLowerCase();

  if (!normalized) {
    throw new Error('Informe seu e-mail ou login.');
  }

  return normalized;
}

export async function createPasswordHash(password) {
  const normalizedPassword = normalizePassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scryptAsync(normalizedPassword, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derivedKey).toString('hex')}`;
}

export async function verifyPassword(password, storedHash = '') {
  const [algorithm, salt, hash] = String(storedHash).split(':');

  if (algorithm !== 'scrypt' || !salt || !hash) {
    return false;
  }

  const derivedKey = await scryptAsync(String(password), salt, 64);
  const incomingHash = Buffer.from(derivedKey).toString('hex');
  const expectedBuffer = Buffer.from(hash, 'hex');
  const actualBuffer = Buffer.from(incomingHash, 'hex');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

export function buildAdminCredentials(input = {}) {
  const email = normalizeEmail(input.email || DEFAULT_ADMIN_EMAIL);
  const login = normalizeLogin(input.login || deriveLoginFromEmail(email));
  const name = normalizeDisplayName(input.name || DEFAULT_ADMIN_NAME);
  const password = normalizePassword(input.password || DEFAULT_ADMIN_PASSWORD);

  return {
    name,
    email,
    emailNormalized: email,
    login,
    loginNormalized: login,
    password,
  };
}

export function getInitialAdminConfig(env = process.env) {
  const email = env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
  const login = env.ADMIN_LOGIN || deriveLoginFromEmail(email);
  const password = env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  const name = env.ADMIN_NAME || DEFAULT_ADMIN_NAME;

  return buildAdminCredentials({ name, email, login, password });
}

export function createUserModel() {
  const userSchema = new mongoose.Schema(
    {
      name: {
        type: String,
        required: true,
        trim: true,
      },
      email: {
        type: String,
        required: true,
        trim: true,
      },
      emailNormalized: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },
      login: {
        type: String,
        required: true,
        trim: true,
      },
      loginNormalized: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },
      passwordHash: {
        type: String,
        required: true,
      },
      role: {
        type: String,
        required: true,
        default: 'admin',
      },
    },
    {
      timestamps: true,
      versionKey: false,
    }
  );

  return mongoose.models.AdminUser || mongoose.model('AdminUser', userSchema);
}

export function createSessionModel() {
  const sessionSchema = new mongoose.Schema(
    {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AdminUser',
        required: true,
        index: true,
      },
      tokenHash: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },
      expiresAt: {
        type: Date,
        required: true,
        index: true,
        expires: 0,
      },
      lastSeenAt: {
        type: Date,
        default: Date.now,
      },
    },
    {
      timestamps: true,
      versionKey: false,
    }
  );

  return mongoose.models.AdminSession || mongoose.model('AdminSession', sessionSchema);
}

export async function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export async function upsertAdminUser(User, input = {}) {
  const credentials = buildAdminCredentials(input);
  const passwordHash = await createPasswordHash(credentials.password);
  const existingUser = await User.findOne({
    $or: [
      { emailNormalized: credentials.emailNormalized },
      { loginNormalized: credentials.loginNormalized },
    ],
  });

  if (existingUser) {
    existingUser.name = credentials.name;
    existingUser.email = credentials.email;
    existingUser.emailNormalized = credentials.emailNormalized;
    existingUser.login = credentials.login;
    existingUser.loginNormalized = credentials.loginNormalized;
    existingUser.passwordHash = passwordHash;
    await existingUser.save();

    return {
      created: false,
      updated: true,
      user: existingUser,
      credentials,
    };
  }

  const user = await User.create({
    name: credentials.name,
    email: credentials.email,
    emailNormalized: credentials.emailNormalized,
    login: credentials.login,
    loginNormalized: credentials.loginNormalized,
    passwordHash,
  });

  return {
    created: true,
    updated: false,
    user,
    credentials,
  };
}
