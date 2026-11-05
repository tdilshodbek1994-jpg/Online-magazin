'use client';
import { AiChat } from '@/components/AiChat';

/** AI yordamchi for staff: the server picks the workspace (owner → superadmin, finance/catalog/warehouse → admin). */
export default function AdminAi() {
  return <div className="wrap ai-staff" style={{ maxWidth: 760 }}><AiChat /></div>;
}
