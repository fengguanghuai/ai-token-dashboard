import NumberFlow from '@number-flow/react';
import { useReducedMotion } from 'motion/react';
import { numberFlowParts } from '../shared/number-flow.js';

// Animate display only. Calculations, exports and accessible text use the final value.
export function AnimatedNumber({ value, format }) {
  const reduceMotion = useReducedMotion();
  const text = format(value);
  const parts = numberFlowParts(text);

  return <span>
    <span className="visually-hidden">{text}</span>
    <span aria-hidden="true">{parts ? <NumberFlow {...parts} locales="en-US" animated={!reduceMotion} transformTiming={{duration:550}} /> : text}</span>
  </span>;
}
