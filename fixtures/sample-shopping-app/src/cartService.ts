import { Cart } from './cart.js';
import type { Product } from './product.js';

/** Thin wrapper that the rest of the app calls into. */
export class CartService {
  private readonly cart = new Cart();

  addProduct(product: Product): void {
    this.cart.addItem(product);
  }

  checkout(): number {
    return this.cart.totalCents();
  }
}
