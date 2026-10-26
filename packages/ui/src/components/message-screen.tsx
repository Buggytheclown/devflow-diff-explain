import type { ReactNode } from 'react';
import './message-screen.css';

export function MessageScreen({ title, children }: { title: string; children: ReactNode }) {
    return <main className="message-screen"><h1 className="message-screen__title">{title}</h1>{children}</main>;
}
