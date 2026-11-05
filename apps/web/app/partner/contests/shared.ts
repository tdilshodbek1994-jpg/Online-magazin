import { som } from '@/lib/api';

export const METRIC_UZ: Record<string, string> = {
  settled_orders: 'Yetkazilgan va to‘lovi tasdiqlangan buyurtmalar soni',
  settled_units: 'Sotilgan (qaytarilmagan) dona',
  confirmed_commission: 'Tasdiqlangan komissiya',
  net_sales: 'Sof savdo (qaytarishlarsiz)',
};
export const STATUS_UZ: Record<string, [string, string]> = {
  draft: ['Qoralama', 'b-cancelled'], review: ['Ko‘rib chiqilmoqda', 'b-shipping'], approved: ['Tasdiqlangan', 'b-accepted'],
  scheduled: ['Tez orada', 'b-accepted'], active: ['Davom etmoqda', 'b-new'], calculating: ['Hisoblanmoqda', 'b-shipping'],
  provisional: ['Dastlabki natija', 'b-shipping'], appeal_window: ['E’tiroz muddati', 'b-shipping'], finalized: ['Yakunlandi', 'b-delivered'],
  awarded: ['Sovrinlar berildi', 'b-delivered'], archived: ['Arxiv', 'b-cancelled'], paused: ['To‘xtatilgan', 'b-returned'], canceled: ['Bekor qilingan', 'b-returned'], voided: ['Bekor', 'b-returned'],
};
export const isMoney = (m: string) => m === 'confirmed_commission' || m === 'net_sales';
export const fmtScore = (metric: string, v: string | number | null | undefined) => (v === null || v === undefined ? '—' : isMoney(metric) ? som(String(v)) : `${v} ${metric === 'settled_units' ? 'dona' : 'ta'}`);
export const dt = (t?: string | null) => (t ? new Date(t).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
