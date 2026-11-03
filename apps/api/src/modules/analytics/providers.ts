import type { AppConfig } from '../../config.js';
import { type Db, maybeOne, one, type Tx, withTx } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { decrypt } from '../../platform/mfa.js';
import { decToScaled, fxFor, toUzsMinor } from './money.js';

/**
 * Meta Marketing API (Insights) spend adapter — READ ONLY (spec §11). It never creates ads or changes budgets.
 * Field names follow the official Business SDK AdsInsights object (spend, account_currency, date_start,
 * publisher_platform breakdown). Exact API version and required permissions (e.g. ads_read) must be confirmed against
 * Meta's documentation when a real account is connected — this adapter has not been run against a live account.
 *
 * Data grain: one row per ad × platform × day, keyed `${account}|${ad_id}|${platform}|${date}`. Only level=ad is read,
 * so campaign/adset/account totals are never added on top of ad rows (T25). Re-reading a day updates the same key
 * as a new version instead of adding (T24). Days stay in the provider's own timezone (no hour-splitting, T31).
 */
export interface MetaRow { ad_id: string; date_start: string; spend: string; account_currency: string; publisher_platform?: string | null }

export async function ingestMetaRows(db: Db, partnerId: string, accountId: string, rows: MetaRow[], providerTz: string | null, runId: string | null = null) {
  let changed = 0;
  await withTx(db, async (tx) => {
    for (const r of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date_start) || !/^\d+(\.\d{1,2})?$/.test(r.spend) || !/^[A-Z]{3}$/.test(r.account_currency)) continue;
      if (decToScaled(r.spend, 2) === 0n) continue;
      const platform = r.publisher_platform ?? null;
      // Facebook + Instagram together is never called "Instagram": only the instagram breakdown is Instagram target.
      const channel = platform === 'instagram' ? 'instagram_target' : platform ? 'other' : 'meta_mixed';
      const key = `${accountId}|${r.ad_id}|${platform ?? 'mixed'}|${r.date_start}`;
      const fx = await fxFor(tx, r.account_currency, r.date_start);
      const uzs = fx ? toUzsMinor(decToScaled(r.spend, 2), fx.rate, fx.nominal).toString() : null;
      const ex = await maybeOne<{ id: string; amt: string }>(tx, `SELECT id, amount_original::text AS amt FROM ad_expenses WHERE partner_id=$1 AND source='meta' AND external_key=$2 FOR UPDATE`, [partnerId, key]);
      if (ex) {
        if (decToScaled(ex.amt, 2) === decToScaled(r.spend, 2)) continue;
        await tx.query(`UPDATE ad_expenses SET amount_original=$2, amount_uzs_minor=$3, fx_rate=$4, fx_nominal=$5, fx_date=$6, fx_source=$7, fx_status=$8, version=version+1, updated_at=now() WHERE id=$1`,
          [ex.id, r.spend, uzs, fx?.rate ?? null, fx?.nominal ?? null, fx?.date ?? null, fx?.source ?? null, fx ? 'ok' : 'pending']);
        await versionRow(tx, ex.id, 'provider correction');
        changed++;
        continue;
      }
      // A manual expense for the same channel/day is a second proof of the same spend → reconciliation queue, not a sum (T23).
      const manual = await maybeOne<{ id: string }>(tx, `SELECT id FROM ad_expenses WHERE partner_id=$1 AND source IN ('manual','csv','legacy_p2') AND status='active' AND kind='actual'
          AND channel IN ('instagram_target','meta_mixed') AND $2::date BETWEEN service_from AND service_to LIMIT 1`, [partnerId, r.date_start]);
      const e = await one<{ id: string }>(tx, `INSERT INTO ad_expenses (partner_id, channel, placement_name, amount_original, currency, fx_rate, fx_nominal, fx_date, fx_source, amount_uzs_minor, fx_status, service_from, service_to, payer, kind, status, source, external_key, note, reconciles_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,'partner','actual',$13,'meta',$14,$15,$16) RETURNING id`,
        [partnerId, channel, `Meta ad ${r.ad_id}${platform ? ` · ${platform}` : ' · aralash joylashuvlar'}`, r.spend, r.account_currency, fx?.rate ?? null, fx?.nominal ?? null, fx?.date ?? null, fx?.source ?? null, uzs, fx ? 'ok' : 'pending',
          r.date_start, manual ? 'needs_reconcile' : 'active', key, providerTz ? `provider timezone: ${providerTz}` : null, manual?.id ?? null]);
      await versionRow(tx, e.id, 'provider import');
      changed++;
    }
    if (runId) await tx.query(`UPDATE provider_sync_runs SET rows_seen=$2, rows_changed=$3 WHERE id=$1`, [runId, rows.length, changed]);
  });
  return { seen: rows.length, changed };
}
async function versionRow(tx: Tx, id: string, reason: string) {
  const e = await one<Record<string, unknown> & { version: number }>(tx, `SELECT * FROM ad_expenses WHERE id=$1`, [id]);
  await tx.query(`INSERT INTO ad_expense_versions (expense_id, version, snapshot, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [id, e.version, JSON.stringify(e), reason]);
}

/** Live sync (only with a connected account, enabled flag and a real token). Errors are recorded, never hidden. */
export async function syncMeta(db: Db, cfg: AppConfig, partnerId: string, from: string, to: string) {
  const conn = await maybeOne<{ id: string; account_id: string; token_ciphertext: string | null }>(db, `SELECT id, account_id, token_ciphertext FROM provider_connections WHERE partner_id=$1 AND provider='meta' AND status='active' LIMIT 1`, [partnerId]);
  if (!conn?.token_ciphertext) throw new AppError(409, 'PROVIDER_NOT_CONNECTED');
  const run = await one<{ id: string }>(db, `INSERT INTO provider_sync_runs (connection_id, partner_id, provider, period_from, period_to, status) VALUES ($1,$2,'meta',$3,$4,'running') RETURNING id`, [conn.id, partnerId, from, to]);
  const version = process.env.META_GRAPH_VERSION ?? 'v21.0';
  const acct = conn.account_id.startsWith('act_') ? conn.account_id : `act_${conn.account_id}`;
  try {
    const token = decrypt(conn.token_ciphertext, cfg.mfaKey);
    const tzRes = await fetch(`https://graph.facebook.com/${version}/${acct}?fields=timezone_name&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15_000) });
    const tz = tzRes.ok ? ((await tzRes.json()) as { timezone_name?: string }).timezone_name ?? null : null;
    const params = new URLSearchParams({ level: 'ad', fields: 'ad_id,spend,account_currency,date_start', breakdowns: 'publisher_platform', time_increment: '1', time_range: JSON.stringify({ since: from, until: to }), limit: '500', access_token: token });
    let url: string | null = `https://graph.facebook.com/${version}/${acct}/insights?${params}`;
    const rows: MetaRow[] = [];
    while (url) {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); // body may echo request params — never logged
      const j = (await r.json()) as { data: MetaRow[]; paging?: { next?: string } };
      rows.push(...j.data);
      url = j.paging?.next ?? null;
    }
    const res = await ingestMetaRows(db, partnerId, conn.account_id, rows, tz, run.id);
    await db.query(`UPDATE provider_sync_runs SET status='ok', provider_timezone=$2, finished_at=now() WHERE id=$1`, [run.id, tz]);
    await db.query(`UPDATE provider_connections SET last_success_at=now(), last_error=NULL WHERE id=$1`, [conn.id]);
    return { ok: true, ...res, provider_timezone: tz };
  } catch (e) {
    const msg = String((e as Error).message).replace(/access_token=[^&\s]+/g, 'access_token=***').slice(0, 300);
    await db.query(`UPDATE provider_sync_runs SET status='error', error=$2, finished_at=now() WHERE id=$1`, [run.id, msg]);
    await db.query(`UPDATE provider_connections SET last_error=$2 WHERE id=$1`, [conn.id, msg]);
    throw new AppError(502, 'PROVIDER_SYNC_FAILED', { error: msg });
  }
}
