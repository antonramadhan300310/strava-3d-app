'use client';

import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import ProPaywallSheet from './ProPaywallSheet';
import SessionKickedModal from './SessionKickedModal';
import TrialExpiredModal from './TrialExpiredModal';

/**
 * Account-level popups that live above the auth gate, so they still render
 * while the app is transitioning back to the login screen.
 */
export default function AccountGuardModals() {
  const {
    trialExpiredNotice,
    dismissTrialExpiredNotice,
    sessionKicked,
    dismissSessionKicked,
  } = useAuth();
  const [paywallOpen, setPaywallOpen] = useState(false);

  const openPaywall = () => {
    dismissTrialExpiredNotice();
    setPaywallOpen(true);
  };

  return (
    <>
      <TrialExpiredModal
        open={trialExpiredNotice && !paywallOpen}
        onContinue={dismissTrialExpiredNotice}
        onUpgrade={openPaywall}
      />
      <ProPaywallSheet
        open={paywallOpen}
        reason="Masa trial 14 hari sudah berakhir. Aktifkan Pro untuk membuka semua fitur."
        onClose={() => setPaywallOpen(false)}
      />
      <SessionKickedModal open={sessionKicked} onReenter={dismissSessionKicked} />
    </>
  );
}
