import 'dotenv/config';

const required = ['MONGO_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'JWT_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

// HEADLESS env var: 'false' / '0' → run fetch with a visible browser
// (useful for sites that detect headless). Anything else → headless.
const headlessEnv = (process.env.HEADLESS ?? 'true').toLowerCase();
const headless = !['false', '0', 'no'].includes(headlessEnv);

export const config = {
  mongoUrl: process.env.MONGO_URL,
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  adminUsername: process.env.ADMIN_USERNAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  jwtSecret: process.env.JWT_SECRET,
  isProd: process.env.NODE_ENV === 'production',
  headless,
  // Telegram bot token from @BotFather. Optional — when unset, the bot is
  // simply not started. The access allowlist is managed in the dashboard.
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
};
