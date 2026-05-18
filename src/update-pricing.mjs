import { resolve } from 'node:path';
import { loadPricing } from './pricing.mjs';

process.env.PRICING_REFRESH = '1';

const pricingCachePath = resolve(process.cwd(), 'data', 'pricing-litellm.json');
await loadPricing(pricingCachePath);
