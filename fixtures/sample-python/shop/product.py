from dataclasses import dataclass


@dataclass
class Product:
    sku: str
    price: float

    def label(self) -> str:
        return f"{self.sku} @ {self.price:.2f}"
