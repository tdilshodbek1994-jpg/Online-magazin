/**
 * Meta Marketing API adapter boundary (P1B). The real Graph implementation needs an owner-approved Meta app
 * (app id/secret, app review, pinned API version) which this project does not have yet — so the default adapter is
 * honest: authorize URL only when META_APP_ID is configured, everything else fails with NOT_CONNECTED. Nothing here
 * ever reports success that did not happen. Tests inject a fake adapter.
 */
export interface RemoteIds { campaign_id: string; adset_id: string; creative_id: string; ad_id: string }
export interface CreatePausedReq {
  client_ref: string; ad_account_id: string; page_id: string; dataset_id: string | null; objective: string;
  budget_type: 'daily' | 'lifetime'; budget_minor: string; currency: string; start_at: string; end_at: string | null;
  audience: Record<string, unknown>; placements: string[]; creative: Record<string, unknown>; destination_url: string;
}
export interface MetaAdsAdapter {
  name: string;
  authorizeUrl(state: string, redirectUri: string): string | null;
  exchangeCode(code: string, redirectUri: string): Promise<{ token: string; expires_at: string | null; scopes: string[]; business_id: string | null }>;
  verifyAssets(token: string, want: { ad_account_id?: string; page_id?: string; dataset_id?: string }): Promise<{ ad_account: { id: string; currency: string; timezone: string } | null; page: string | null; dataset: string | null }>;
  /** Creates campaign/adset/creative/ad with status PAUSED. Throws { code: 'TIMEOUT' } when the outcome is unknown. */
  createPaused(token: string, req: CreatePausedReq): Promise<RemoteIds>;
  /** Looks up objects previously created with this client reference (reconciliation after an unknown outcome). */
  findByClientRef(token: string, adAccountId: string, clientRef: string): Promise<RemoteIds | null>;
  activate(token: string, ids: RemoteIds): Promise<void>;
  pause(token: string, ids: RemoteIds): Promise<void>;
  status(token: string, ids: RemoteIds): Promise<{ configured: string; effective: string; review_feedback: string | null }>;
}

const notConnected = () => Promise.reject(Object.assign(new Error('meta adapter not connected'), { code: 'NOT_CONNECTED' }));

export const notConnectedAdapter: MetaAdsAdapter = {
  name: 'not_connected',
  authorizeUrl(state, redirectUri) {
    const appId = process.env.META_APP_ID;
    const version = process.env.META_GRAPH_VERSION;
    if (!appId || !version) return null; // never guess an app or an API version
    const scope = ['ads_read', 'ads_management', 'business_management', 'pages_show_list'].join(',');
    return `https://www.facebook.com/${version}/dialog/oauth?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${scope}`;
  },
  exchangeCode: notConnected, verifyAssets: notConnected, createPaused: notConnected, findByClientRef: notConnected,
  activate: notConnected, pause: notConnected, status: notConnected,
};

let current: MetaAdsAdapter = notConnectedAdapter;
export const metaAdapter = () => current;
/** Test/integration hook: swap the adapter (a real Graph adapter is plugged in here once the owner's Meta app exists). */
export function setMetaAdapter(a: MetaAdsAdapter | null) { current = a ?? notConnectedAdapter; }
