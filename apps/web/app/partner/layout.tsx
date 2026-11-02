import { PartnerTabs } from './shared';

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="partner-area">
      <PartnerTabs />
      {children}
    </div>
  );
}
