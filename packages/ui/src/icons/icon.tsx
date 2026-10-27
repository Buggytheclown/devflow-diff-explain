import sprite from './sprite.svg?raw';
import './icons.css';

export type IconName =
    | 'search'
    | 'chev-down'
    | 'chev-right'
    | 'thumb'
    | 'pencil'
    | 'check'
    | 'cross'
    | 'swap'
    | 'arrow-up'
    | 'arrow-down'
    | 'updown'
    | 'reply'
    | 'bold'
    | 'italic'
    | 'link'
    | 'code'
    | 'codeblock'
    | 'list'
    | 'trash'
    /** Настройки. */
    | 'sliders'
    /** Круглая метка. */
    | 'dot';

export type IconSize = 9 | 11 | 13 | 14 | 15;

export interface IconProps {
    readonly name: IconName;
    readonly size: IconSize;
    readonly className?: string;
}

/** Иконка из встроенного SVG-спрайта. Размер задаётся и атрибутами, и несжимаемым flex-элементом. */
export function Icon({ name, size, className }: IconProps) {
    return (
        <svg
            className={`icon${className === undefined ? '' : ` ${className}`}`}
            width={size}
            height={size}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            data-icon={name}
        >
            <use href={`#ic-${name}`} />
        </svg>
    );
}

/** Один встроенный спрайт на документ; Icon ссылается на его символы по id. */
export function IconSprite() {
    return <div className="icon-sprite" aria-hidden="true" dangerouslySetInnerHTML={{ __html: sprite }} />;
}
