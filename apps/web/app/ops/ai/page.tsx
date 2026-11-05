'use client';
import { AiChat } from '@/components/AiChat';

export default function OpsAi() {
  return <div className="wrap ai-staff" style={{ maxWidth: 760 }}><AiChat defaultWorkspace="operator" /></div>;
}
