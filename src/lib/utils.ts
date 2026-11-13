// tailwind-variants (部品の tv) と同じ寄せ方で寄せる。tailwind-merge を別に入れると、寄せる仕組みが2つになり、規則の違いで結果がずれうる
import { clsx, twMerge } from 'tailwind-variants';

// tailwind-variants が書き出す ClassValue は文字列だけの型なので、clsx が受け取る型を使う
type ClassValue = Parameters<typeof clsx>[number];

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
