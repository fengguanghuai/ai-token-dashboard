import { useEffect } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';

// Animate display only. Calculations, exports and accessible text use the final value.
export function AnimatedNumber({ value, format }) {
  const reduceMotion = useReducedMotion();
  const current = useMotionValue(value);
  const text = useTransform(current, latest => format(latest));

  useEffect(() => {
    if (reduceMotion) {
      current.set(value);
      return;
    }
    const playback = animate(current, value, { duration: 0.55, ease: [0.22, 1, 0.36, 1] });
    return () => playback.stop();
  }, [current, value, reduceMotion]);

  return <span>
    <span className="visually-hidden">{format(value)}</span>
    <motion.span aria-hidden="true">{text}</motion.span>
  </span>;
}
