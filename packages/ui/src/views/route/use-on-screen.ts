import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

/**
 * Побывал ли элемент на экране. Один раз `true` — навсегда `true`: по этому флагу остановка
 * заказывает разбор своих файлов и дорисовывает карточки сверх первых пяти (docs/design/SPEC-elements.md §2.9),
 * и отматывать это назад бессмысленно.
 *
 * Нет `IntersectionObserver` (тесты, старый рантайм) — считаем, что видно всё: деградация
 * в сторону полного рендера, а не пустоты.
 */
export function useOnScreen(ref: RefObject<HTMLElement | null>, rootMargin = '800px'): boolean {
    const [seen, setSeen] = useState(false);

    useEffect(() => {
        if (seen) {
            return;
        }
        const element = ref.current;
        if (element === null || typeof IntersectionObserver === 'undefined') {
            setSeen(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setSeen(true);
                    observer.disconnect();
                }
            },
            { rootMargin },
        );
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [ref, rootMargin, seen]);

    return seen;
}

/**
 * Рядом ли элемент со вьюпортом — в отличие от `useOnScreen`, флаг двусторонний: по нему
 * остановка снимает свою колонку диффа с DOM, когда ревьюер уехал далеко, и возвращает её,
 * когда подъезжает обратно.
 *
 * Гистерезис обязателен: монтируем по ближней границе, размонтируем по дальней. С одной
 * границей карточки мигали бы на каждом кадре, когда край остановки стоит ровно на ней.
 *
 * Нет `IntersectionObserver` (тесты, SSR, старый рантайм) — «рядом» всегда: деградация
 * в сторону полного рендера, а не пустоты, как и у `useOnScreen`.
 */
export function useNearViewport(
    ref: RefObject<HTMLElement | null>,
    options: { readonly mountMargin: number; readonly unmountMargin: number },
): boolean {
    const { mountMargin, unmountMargin } = options;
    const [near, setNear] = useState(true);

    useEffect(() => {
        const element = ref.current;
        if (element === null || typeof IntersectionObserver === 'undefined') {
            setNear(true);
            return;
        }
        const mount = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setNear(true);
                }
            },
            { rootMargin: `${String(mountMargin)}px` },
        );
        const unmount = new IntersectionObserver(
            (entries) => {
                if (entries.every((entry) => !entry.isIntersecting)) {
                    setNear(false);
                }
            },
            { rootMargin: `${String(unmountMargin)}px` },
        );
        mount.observe(element);
        unmount.observe(element);
        return () => {
            mount.disconnect();
            unmount.disconnect();
        };
    }, [mountMargin, ref, unmountMargin]);

    return near;
}
