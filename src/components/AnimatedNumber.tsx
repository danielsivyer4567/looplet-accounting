import { useEffect, useState } from 'react';

export function AnimatedNumber({
  value,
  formatter = (v: number) => v.toLocaleString(),
  duration = 800,
}: {
  value: number;
  formatter?: ((val: number) => string) | undefined;
  duration?: number;
}) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    let startTimestamp: number | null = null;
    const startValue = 0;
    const endValue = value;

    if (endValue === 0) {
      setDisplayValue(0);
      return;
    }

    let animationFrameId: number;

    const step = (timestamp: number) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);

      // Easing: easeOutQuad
      const easeProgress = progress * (2 - progress);
      const current = startValue + easeProgress * (endValue - startValue);

      // Counts and cents are integers — never surface fractional frames
      setDisplayValue(Math.round(current));

      if (progress < 1) {
        animationFrameId = requestAnimationFrame(step);
      } else {
        setDisplayValue(endValue);
      }
    };

    animationFrameId = requestAnimationFrame(step);
    // rAF pauses in background tabs, which would freeze a mid-animation value;
    // snap to the final value once the duration has elapsed regardless.
    const snapTimerId = setTimeout(() => setDisplayValue(endValue), duration + 100);
    return () => {
      cancelAnimationFrame(animationFrameId);
      clearTimeout(snapTimerId);
    };
  }, [value, duration]);

  return <>{formatter(displayValue)}</>;
}
