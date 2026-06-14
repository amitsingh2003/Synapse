using System;
using System.Collections.Generic;
using System.Linq;

namespace Shop
{
    /// <summary>
    /// Shopping cart that holds products.
    /// </summary>
    public class Cart
    {
        private readonly List<Product> _items = new();

        public void AddProduct(Product product)
        {
            _items.Add(product);
        }

        public void RemoveProduct(Product product)
        {
            _items.Remove(product);
        }

        public decimal GetTotal()
        {
            return _items.Sum(p => p.Price);
        }

        public IReadOnlyList<Product> Items => _items;
    }
}
