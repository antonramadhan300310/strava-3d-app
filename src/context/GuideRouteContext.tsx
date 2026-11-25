'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { GuideRoute } from '@/lib/guideRoute';

type GuideRouteContextValue = {
  activeGuideRoute: GuideRoute | null;
  setGuideRoute: (route: GuideRoute) => void;
  clearGuideRoute: () => void;
};

const GuideRouteContext = createContext<GuideRouteContextValue | null>(null);

/**
 * Holds the saved route the Record tab follows. Mounted per account (keyed in
 * AuthGate) so a session never leaks across logins.
 */
export function GuideRouteProvider({ children }: { children: ReactNode }) {
  const [activeGuideRoute, setActiveGuideRoute] = useState<GuideRoute | null>(null);

  const setGuideRoute = useCallback((route: GuideRoute) => setActiveGuideRoute(route), []);
  const clearGuideRoute = useCallback(() => setActiveGuideRoute(null), []);

  const value = useMemo(
    () => ({ activeGuideRoute, setGuideRoute, clearGuideRoute }),
    [activeGuideRoute, setGuideRoute, clearGuideRoute],
  );

  return <GuideRouteContext.Provider value={value}>{children}</GuideRouteContext.Provider>;
}

export function useGuideRoute(): GuideRouteContextValue {
  const value = useContext(GuideRouteContext);
  if (!value) throw new Error('useGuideRoute must be used inside GuideRouteProvider');
  return value;
}
