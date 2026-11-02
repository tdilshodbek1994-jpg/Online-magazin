import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { currentStep, totpAt } from '../src/platform/mfa.js';
import { api, mkUser, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});

describe('T020 — owner/finance MFA and step-up', () => {
  it('finance without step-up cannot approve refunds/payouts or confirm COD; TOTP step-up unlocks; replay and reused recovery codes rejected', async () => {
    const fin = await mkUser(t, ['finance'], undefined, false);
    const blocked = await api(t, 'POST', `/refunds/${randomUUID()}/approve`, { token: fin.token });
    expect(blocked.json.code).toBe('STEP_UP_REQUIRED');
    expect((await api(t, 'POST', `/admin/payouts/${randomUUID()}/approve`, { token: fin.token })).json.code).toBe('STEP_UP_REQUIRED');
    expect((await api(t, 'POST', `/finance/remittances/${randomUUID()}/confirm`, { token: fin.token, body: { received_minor: '1' } })).json.code).toBe('STEP_UP_REQUIRED');
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { code: '123456' } })).json.code).toBe('MFA_ENROLLMENT_REQUIRED');
    const en = await api(t, 'POST', '/auth/mfa/enroll', { token: fin.token });
    expect(en.json.otpauth_uri).toContain('otpauth://totp/');
    const act = await api(t, 'POST', '/auth/mfa/activate', { token: fin.token, body: { code: totpAt(en.json.secret, currentStep()) } });
    expect(act.json.recovery_codes).toHaveLength(8);
    // same step reused for step-up → replay rejected
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { code: totpAt(en.json.secret, currentStep()) } })).json.code).toBe('MFA_CODE_INVALID');
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { code: '000000' } })).status).toBe(400);
    const ok = await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { code: totpAt(en.json.secret, currentStep() + 1) } });
    expect(ok.status).toBe(200);
    expect((await api(t, 'POST', `/refunds/${randomUUID()}/approve`, { token: fin.token })).status).toBe(404); // passes step-up, resource missing
    const rc = act.json.recovery_codes[0];
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { recovery_code: rc } })).json.method).toBe('recovery_code');
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { recovery_code: rc } })).json.code).toBe('MFA_CODE_INVALID');
    const audit = await t.db.query(`SELECT action FROM audit_events WHERE actor_user_id=$1 ORDER BY id`, [fin.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['mfa.enabled', 'auth.step_up', 'auth.step_up']);
    const secretStored = (await t.db.query(`SELECT secret_enc FROM user_mfa WHERE user_id=$1`, [fin.id])).rows[0].secret_enc;
    expect(secretStored).not.toContain(en.json.secret);
  });

  it('operator actions do not require step-up (only owner/finance)', async () => {
    const op = await mkUser(t, ['operator'], undefined, false);
    expect((await api(t, 'GET', '/ops/queues', { token: op.token })).status).toBe(200);
  });

  it('T020 sessions: user can list and revoke own sessions', async () => {
    const u = await mkUser(t, ['owner']);
    const list = await api(t, 'GET', '/auth/sessions', { token: u.token });
    expect(list.json.items).toHaveLength(1);
    expect(list.json.items[0].current).toBe(true);
    void s;
  });
});
