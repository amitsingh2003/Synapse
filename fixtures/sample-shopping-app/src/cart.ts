import type { Product } from './product.js';

export interface CartLine {
  product: Product;
  quantity: number;
}

/** Shopping cart used by the fixture repo. */
export class Cart {
  private readonly lines = new Map<string, CartLine>();

  addItem(item: Product): void {
    const existing = this.lines.get(item.id);
    if (existing) {
      existing.quantity += 1;
      return;
    }
    this.lines.set(item.id, { product: item, quantity: 1 });
  }

  removeItem(productId: string): void {
    this.lines.delete(productId);
  }

  totalCents(): number {
    let total = 0;
    for (const line of this.lines.values()) {
      total += line.product.priceCents * line.quantity;
    }
    return total;
  }

  items(): CartLine[] {
    return Array.from(this.lines.values());
  }
}
