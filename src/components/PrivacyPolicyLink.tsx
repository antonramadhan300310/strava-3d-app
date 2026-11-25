'use client';

import { Capacitor } from '@capacitor/core';
import { ShieldCheck } from 'lucide-react';
import { PRIVACY_POLICY_URL, openPrivacyPolicy } from '@/lib/privacy';

type Props = {
  className?: string;
};

/**
 * Renders a real anchor so web users keep normal browser behaviour, but hands
 * the native WebView over to a Custom Tab instead of navigating the app away.
 */
export default function PrivacyPolicyLink({ className }: Props) {
  return (
    <a
      href={PRIVACY_POLICY_URL}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!Capacitor.isNativePlatform()) return;
        event.preventDefault();
        void openPrivacyPolicy();
      }}
      className={className}
    >
      <span className="inline-flex items-center justify-center gap-1.5">
        <ShieldCheck size={12} aria-hidden="true" />
        Kebijakan Privasi
      </span>
    </a>
  );
}
