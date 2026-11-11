#!/bin/bash
# F2. Тип файла по расширению
f=$1
ext=${f##*.}
ext=${ext,,}
case $ext in
    jpg|jpeg|png|gif) type="Изображение" ;;
    txt|doc|docx|pdf) type="Документ" ;;
    zip|tar|gz|rar) type="Архив" ;;
    sh) type="Скрипт" ;;
    *) type="Неизвестный тип" ;;
esac
echo "$f: $type"
