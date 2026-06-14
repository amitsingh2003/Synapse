use std::fmt;

/// A product with a name and price in cents.
#[derive(Debug, Clone)]
pub struct Product {
    pub name: String,
    pub price_cents: u32,
}

impl Product {
    pub fn new(name: &str, price: u32) -> Self {
        Product {
            name: name.to_string(),
            price_cents: price,
        }
    }
}

impl fmt::Display for Product {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (${})", self.name, self.price_cents)
    }
}

/// Shopping cart holding products.
pub struct Cart {
    items: Vec<Product>,
}

impl Cart {
    pub fn new() -> Self {
        Cart { items: Vec::new() }
    }

    pub fn add_product(&mut self, product: Product) {
        self.items.push(product);
    }

    pub fn remove_product(&mut self, name: &str) {
        self.items.retain(|p| p.name != name);
    }

    pub fn get_total(&self) -> u32 {
        self.items.iter().map(|p| p.price_cents).sum()
    }

    pub fn get_items(&self) -> &[Product] {
        &self.items
    }
}

pub trait PaymentProcessor {
    fn process_payment(&self, amount: u32) -> bool;
}

fn main() {
    let mut cart = Cart::new();
    cart.add_product(Product::new("Apple", 150));
    cart.add_product(Product::new("Bread", 300));
    println!("Total: {}", cart.get_total());
}
