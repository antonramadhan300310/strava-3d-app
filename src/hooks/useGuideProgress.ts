'use client';

import { useEffect, useRef, useState } from 'react';
import { computeGuideProgress, type GuideProgress, type GuideRoute } from '@/lib/guideRoute';
import { announceRouteEvent, resetRouteVoiceSession } from '@/lib/routeVoice';

export const OFF_ROUTE_ENTER_METERS = 45;
export const OFF_ROUTE_EXIT_METERS = 35;
export const ARRIVAL_RADIUS_METERS = 30;

export type GuideProgressState = GuideProgress & { offRoute: boolean };

/**
 * Tracks the rider against the guide polyline. Off-route uses hysteresis
 * (enter at 45 m, leave at 35 m) so the pill does not flicker on GPS noise.
 */
export function useGuideProgress(
  route: GuideRoute | null,
  position: { lat: number; lng: number } | null,
  active: boolean,
  voiceEnabled: boolean,
): GuideProgressState | null {
  const [state, setState] = useState<GuideProgressState | null>(null);
  const offRouteRef = useRef(false);
  const arrivedRef = useRef(false);

  useEffect(() => {
    offRouteRef.current = false;
    arrivedRef.current = false;
    setState(null);
    resetRouteVoiceSession();
  }, [route?.id, active]);

  useEffect(() => {
    if (!route || !position || !active) {
      setState(null);
      return;
    }

    const progress = computeGuideProgress(route, position);
    if (!progress) return;

    const wasOff = offRouteRef.current;
    let offRoute = wasOff;
    if (!wasOff && progress.distanceToRouteMeters > OFF_ROUTE_ENTER_METERS) offRoute = true;
    else if (wasOff && progress.distanceToRouteMeters <= OFF_ROUTE_EXIT_METERS) offRoute = false;
    offRouteRef.current = offRoute;

    if (voiceEnabled) {
      if (!wasOff && offRoute) announceRouteEvent('off-route');
      else if (wasOff && !offRoute) announceRouteEvent('back-on-route');
    }

    if (
      !arrivedRef.current &&
      progress.progress > 0.05 &&
      progress.distanceToFinishMeters <= ARRIVAL_RADIUS_METERS
    ) {
      arrivedRef.current = true;
      if (voiceEnabled) announceRouteEvent('arrived');
    }

    setState({ ...progress, offRoute });
  }, [route, position, active, voiceEnabled]);

  return state;
}
