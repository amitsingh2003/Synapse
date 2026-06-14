export interface Product {
  id: string;
  name: string;
  priceCents: number;
}

export function formatPrice(p: Product): string {
  return `$${(p.priceCents / 100).toFixed(2)}`;
}
