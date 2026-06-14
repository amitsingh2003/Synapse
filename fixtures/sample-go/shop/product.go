package shop

type Product struct {
	SKU   string
	Price float64
}

func (p Product) Label() string {
	return p.SKU
}
