from shop import make_demo_cart


def main() -> None:
    cart = make_demo_cart()
    print(cart.total())


if __name__ == "__main__":
    main()
