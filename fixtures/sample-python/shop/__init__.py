"""A tiny Python package the test fixture imports cross-file."""

from .cart import Cart
from .product import Product


def make_demo_cart() -> Cart:
    c = Cart()
    c.add(Product(sku="abc", price=10.0))
    return c
