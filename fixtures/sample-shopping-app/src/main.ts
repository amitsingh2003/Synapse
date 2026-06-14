import { CartService } from './cartService.js';
import type { Product } from './product.js';

const service = new CartService();

const apple: Product = { id: 'p-1', name: 'Apple', priceCents: 199 };
const bread: Product = { id: 'p-2', name: 'Bread', priceCents: 349 };

service.addProduct(apple);
service.addProduct(bread);
service.addProduct(apple);

console.log(`Total: ${service.checkout()} cents`);
