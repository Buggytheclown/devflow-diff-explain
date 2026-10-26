/** Команда, которой новая сессия харнеса подключается к текущему PR. */
export function reconnectCommand(prKey: string): string {
    return `/sherpa ${prKey}`;
}
