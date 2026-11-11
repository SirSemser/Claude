#!/bin/bash
# I1. Банковский счёт
balance=0
deposit() {
    balance=$((balance + $1))
    echo "Пополнение: $1. Баланс: $balance"
}
withdraw() {
    if [ $1 -gt $balance ]; then
        echo "Недостаточно средств. Баланс: $balance"
    else
        balance=$((balance - $1))
        echo "Снятие: $1. Баланс: $balance"
    fi
}
while read -r cmd amount; do
    case $cmd in
        deposit) deposit "$amount" ;;
        withdraw) withdraw "$amount" ;;
        balance) echo "Баланс: $balance" ;;
        exit) echo "До свидания!"; break ;;
        *) echo "Неизвестная команда: $cmd" ;;
    esac
done
