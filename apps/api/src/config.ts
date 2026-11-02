/** Runtime configuration from environment. No secrets have defaults usable in production. */
export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  sessionTtlHours: number;
  otp: { ttlSeconds: number; resendIntervalSeconds: number; maxAttempts: number; devEcho: boolean };
  reservationTtlMinutes: number;
  quoteTtlMinutes: number;
  payments: {
    payme: { mode: 'disabled' | 'sandbox' | 'live'; merchantId: string; key: string; checkoutUrl: string };
    click: { mode: 'disabled' | 'sandbox' | 'live'; serviceId: string; merchantId: string; secretKey: string; checkoutUrl: string };
    mockEnabled: boolean;
  };
  publicWebUrl: string;
}

function num(v: string | undefined, d: number): number {
  const n = v === undefined ? d : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env: ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.NODE_ENV ?? 'development') as AppConfig['env'];
  const databaseUrl = env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/online_magazin';
  const cfg: AppConfig = {
    env: mode,
    port: num(env.PORT, 4000),
    databaseUrl,
    sessionTtlHours: num(env.SESSION_TTL_HOURS, 24 * 30),
    otp: {
      ttlSeconds: num(env.OTP_TTL_SECONDS, 300),
      resendIntervalSeconds: num(env.OTP_RESEND_SECONDS, 60),
      maxAttempts: num(env.OTP_MAX_ATTEMPTS, 5),
      // Dev/test only: return the code in the API response because no SMS provider is connected.
      devEcho: mode !== 'production' && env.OTP_DEV_ECHO !== 'false',
    },
    reservationTtlMinutes: num(env.RESERVATION_TTL_MINUTES, 15),
    quoteTtlMinutes: num(env.QUOTE_TTL_MINUTES, 15),
    payments: {
      payme: {
        mode: (env.PAYME_MODE as 'disabled' | 'sandbox' | 'live') ?? 'sandbox',
        merchantId: env.PAYME_MERCHANT_ID ?? 'test-merchant',
        key: env.PAYME_KEY ?? 'test-payme-key',
        checkoutUrl: env.PAYME_CHECKOUT_URL ?? 'https://checkout.test.paycom.uz',
      },
      click: {
        mode: (env.CLICK_MODE as 'disabled' | 'sandbox' | 'live') ?? 'sandbox',
        serviceId: env.CLICK_SERVICE_ID ?? '0',
        merchantId: env.CLICK_MERCHANT_ID ?? '0',
        secretKey: env.CLICK_SECRET_KEY ?? 'test-click-secret',
        checkoutUrl: env.CLICK_CHECKOUT_URL ?? 'https://my.click.uz/services/pay',
      },
      mockEnabled: mode !== 'production',
    },
    publicWebUrl: env.PUBLIC_WEB_URL ?? 'http://localhost:3000',
  };
  if (mode === 'production') {
    if (cfg.payments.payme.mode === 'live' && cfg.payments.payme.key.startsWith('test')) throw new Error('PAYME_KEY required');
    if (cfg.payments.click.mode === 'live' && cfg.payments.click.secretKey.startsWith('test')) throw new Error('CLICK_SECRET_KEY required');
  }
  return cfg;
}
