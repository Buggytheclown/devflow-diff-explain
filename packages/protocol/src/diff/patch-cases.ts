/** Независимые ожидания для общего парсера и его потребителей; только тестовый корпус. */
export const PATCH_CASES: readonly {
    name: string;
    patch: string;
    rows: readonly (readonly [string, number | null, number | null])[];
    malformed: boolean;
}[] = [
    { name: 'короткий заголовок', patch: '@@ -5 +8 @@ scope\n-old\n+new\n',
        rows: [['-old', 5, null], ['+new', null, 8]], malformed: false },
    { name: 'нулевая старая сторона', patch: '@@ -0,0 +1,2 @@\n+a\n+b\n',
        rows: [['+a', null, 1], ['+b', null, 2]], malformed: false },
    { name: 'нулевая новая сторона', patch: '@@ -1,2 +0,0 @@\n-a\n-b',
        rows: [['-a', 1, null], ['-b', 2, null]], malformed: false },
    { name: 'префиксы заголовков внутри кода', patch: '@@ -1,2 +1,2 @@\n---- old\n++++ new\n @@ code\n',
        rows: [['---- old', 1, null], ['++++ new', null, 1], [' @@ code', 2, 2]], malformed: false },
    { name: 'пустой контекст, табы, Unicode и CRLF', patch: '@@ -3,3 +7,3 @@\n\n-\tстарое\r\n+\tновое\r\n tail\r\n',
        rows: [['', 3, 7], ['-\tстарое\r', 4, null], ['+\tновое\r', null, 8], [' tail\r', 5, 9]], malformed: false },
    { name: 'настоящая пустая строка перед конечным разделителем', patch: '@@ -1,2 +1,2 @@\n same\n\n',
        rows: [[' same', 1, 1], ['', 2, 2]], malformed: false },
    { name: 'пустая внеханковая строка', patch: 'diff --git a/x b/x\n\n', rows: [], malformed: false },
    { name: 'неизвестный префикс сохраняет текст', patch: '@@ -1,2 +1,2 @@\n?unknown\n same\n',
        rows: [['?unknown', 1, 1], [' same', 2, 2]], malformed: true },
    { name: 'EOF-маркеры обеих сторон', patch: '@@ -1 +1 @@\n-old\n\\ Нет перевода строки\n+new\n\\ No newline at end of file\n',
        rows: [['-old', 1, null], ['+new', null, 1]], malformed: false },
    { name: 'усечённый ханк без финального разделителя', patch: '@@ -1,4 +1,4 @@\n one\n-old',
        rows: [[' one', 1, 1], ['-old', 2, null]], malformed: true },
    { name: 'финальный разделитель не завершает усечённый ханк', patch: '@@ -1,2 +1,2 @@\n one\n',
        rows: [[' one', 1, 1]], malformed: true },
    { name: 'следующий ханк обрывает недобранный', patch: '@@ -1,9 +1,9 @@\n one\n@@ -20 +30 @@\n-old\n+new\n',
        rows: [[' one', 1, 1], ['-old', 20, null], ['+new', null, 30]], malformed: true },
    { name: 'следующий файл обрывает недобранный', patch: '@@ -1,9 +1,9 @@\n one\ndiff --git a/x b/x\n@@ -20 +30 @@\n-old\n+new\n',
        rows: [[' one', 1, 1], ['-old', 20, null], ['+new', null, 30]], malformed: true },
    { name: 'лишний хвост вне ханка не получает координат', patch: '@@ -1 +1 @@\n-old\n+new\n+лишний хвост\n',
        rows: [['-old', 1, null], ['+new', null, 1]], malformed: false },
];
