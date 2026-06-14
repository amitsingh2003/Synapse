package main

import (
	"fmt"

	"example.com/sample/shop"
)

func main() {
	c := shop.NewCart()
	c.Add(shop.Product{SKU: "abc", Price: 10.0})
	fmt.Println(c.Total())
}
