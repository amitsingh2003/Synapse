#include <iostream>
#include <vector>
#include <string>
#include <memory>

namespace shop {

struct Product {
    std::string name;
    int price_cents;

    Product(std::string n, int p) : name(std::move(n)), price_cents(p) {}

    std::string display() const {
        return name + " ($" + std::to_string(price_cents) + ")";
    }
};

class Cart {
private:
    std::vector<std::shared_ptr<Product>> items_;

public:
    void add_product(std::shared_ptr<Product> product) {
        items_.push_back(product);
    }

    void remove_product(const std::string& name) {
        items_.erase(
            std::remove_if(items_.begin(), items_.end(),
                [&name](const auto& p) { return p->name == name; }),
            items_.end()
        );
    }

    int get_total() const {
        int total = 0;
        for (const auto& item : items_) {
            total += item->price_cents;
        }
        return total;
    }

    const std::vector<std::shared_ptr<Product>>& get_items() const {
        return items_;
    }
};

} // namespace shop

int main() {
    auto apple = std::make_shared<shop::Product>("Apple", 150);
    auto bread = std::make_shared<shop::Product>("Bread", 300);

    shop::Cart cart;
    cart.add_product(apple);
    cart.add_product(bread);

    std::cout << "Total: " << cart.get_total() << std::endl;
    return 0;
}
