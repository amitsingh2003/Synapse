from typing import List

from .product import Product


class Cart:
    def __init__(self) -> None:
        self.items: List[Product] = []

    def add(self, p: Product) -> None:
        self.items.append(p)

    def total(self) -> float:
        return sum(item.price for item in self.items)
