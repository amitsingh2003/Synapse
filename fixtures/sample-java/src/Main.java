package com.example.shop;

public class Main {
    public static void main(String[] args) {
        Cart cart = new Cart();
        Product apple = new Product("Apple", 150);
        Product bread = new Product("Bread", 300);

        cart.addProduct(apple);
        cart.addProduct(bread);

        System.out.println("Total: " + cart.getTotal());
    }
}
