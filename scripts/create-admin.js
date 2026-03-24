import mongoose from 'mongoose';
import process from 'node:process';
import { createUserModel, getInitialAdminConfig, upsertAdminUser } from '../auth.js';

process.loadEnvFile();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/qrcode';

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split('=');
    const nextValue = inlineValue ?? argv[index + 1];
    const value = nextValue && !nextValue.startsWith('--') ? nextValue : '';
    args[rawKey] = value;

    if (inlineValue === undefined && value) {
      index += 1;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  try {
    const User = createUserModel();
    const initialConfig = getInitialAdminConfig(process.env);
    const result = await upsertAdminUser(User, {
      name: args.name || initialConfig.name,
      email: args.email || initialConfig.email,
      login: args.login || initialConfig.login,
      password: args.password || initialConfig.password,
    });

    console.log(result.created ? 'Usuário admin criado.' : 'Usuário admin atualizado.');
    console.log(`Nome: ${result.credentials.name}`);
    console.log(`Login: ${result.credentials.login}`);
    console.log(`E-mail: ${result.credentials.email}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
