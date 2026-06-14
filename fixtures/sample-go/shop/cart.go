package shop

type Cart struct {
	Items []Product
}

func NewCart() *Cart {
	return &Cart{Items: []Product{}}
}

func (c *Cart) Add(p Product) {
	c.Items = append(c.Items, p)
}

func (c *Cart) Total() float64 {
	var sum float64
	for _, item := range c.Items {
		sum += item.Price
	}
	return sum
}
