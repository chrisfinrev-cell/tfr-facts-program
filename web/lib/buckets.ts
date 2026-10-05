import type { BucketSlug, BucketState } from './types';

export const DEFAULT_BUCKETS: BucketState[] = [
  { slug: 'necessities', name: 'Necessities', target_pct: 50, deposited_cents: 0, spent_cents: 0, remaining_cents: 0 },
  { slug: 'reserve', name: 'Reserve', target_pct: 10, deposited_cents: 0, spent_cents: 0, remaining_cents: 0 },
  { slug: 'velocity', name: 'Velocity', target_pct: 10, deposited_cents: 0, spent_cents: 0, remaining_cents: 0 },
  { slug: 'growth', name: 'Growth', target_pct: 10, deposited_cents: 0, spent_cents: 0, remaining_cents: 0 },
  { slug: 'lifestyle', name: 'Lifestyle', target_pct: 10, deposited_cents: 0, spent_cents: 0, remaining_cents: 0 },
  { slug: 'legacy', name: 'Legacy', target_pct: 10, deposited_cents: 0, spent_cents: 0, remaining_cents: 0 }
];

const NAMES: Record<BucketSlug, string> = {
  necessities: 'Necessities',
  reserve: 'Reserve',
  velocity: 'Velocity',
  growth: 'Growth',
  lifestyle: 'Lifestyle',
  legacy: 'Legacy'
};

export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format((cents || 0) / 100);
}

export function normalizeBuckets(payload: unknown): BucketState[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { buckets?: unknown[] } | null)?.buckets)
      ? (payload as { buckets: unknown[] }).buckets
      : [];

  if (rows.length === 0) return DEFAULT_BUCKETS;

  return DEFAULT_BUCKETS.map((fallback) => {
    const match = rows.find((row) => {
      const slug = String((row as { slug?: string; bucket_slug?: string }).slug
        || (row as { bucket_slug?: string }).bucket_slug
        || '').toLowerCase();
      return slug === fallback.slug;
    }) as Partial<BucketState> | undefined;

    return {
      ...fallback,
      name: match?.name || NAMES[fallback.slug],
      target_pct: Number(match?.target_pct ?? fallback.target_pct),
      deposited_cents: Number(match?.deposited_cents ?? 0),
      spent_cents: Number(match?.spent_cents ?? 0),
      remaining_cents: Number(match?.remaining_cents ?? 0)
    };
  });
}
