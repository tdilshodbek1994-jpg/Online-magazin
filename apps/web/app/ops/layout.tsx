'use client';
import { useEffect, useState } from 'react';
import { api, getToken } from '@/lib/api';
import { tgAppName } from '@/lib/telegram';

/** Inside the operator Telegram mini app a missing/expired session goes back to the bot entry screen (link + login). */
export default function OpsLayout({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = useState(true);
  useEffect(() => {
    if (tgAppName() !== 'operator') return;
    const back = () => { setOk(false); location.replace('/tg/operator'); };
    if (!getToken()) { back(); return; }
    api('/me').catch((e) => { if (e?.status === 401) back(); });
  }, []);
  return ok ? <>{children}</> : null;
}
