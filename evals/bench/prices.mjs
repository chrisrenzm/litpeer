// DeepSeek prices in USD per 1M tokens. `deepseek-chat` is now served by DeepSeek-V4.1-Flash
// (the API reports model "deepseek-flash"). Off-peak and peak rates as published in 2026;
// check https://api-docs.deepseek.com/quick_start/pricing before a big run and edit here.
export const PRICES = {
  "flash-offpeak": { miss: 0.15, hit: 0.015, out: 0.6 },
  "flash-peak": { miss: 0.3, hit: 0.03, out: 1.2 },
};
export function cost(u, p) {
  return ((u.cache_miss_tokens || 0) * p.miss + (u.cache_hit_tokens || 0) * p.hit + (u.completion_tokens || 0) * p.out) / 1e6;
}
