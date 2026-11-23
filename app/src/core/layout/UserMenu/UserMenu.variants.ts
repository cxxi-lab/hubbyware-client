import { tv } from 'tailwind-variants'

export const styles = {
	/**
	 * A header menu's dropdown on a phone: the whole width under the header (the header, relative, its
	 * anchor: the dropdown and its list static there), square, no side borders.
	 */
	phoneWide: tv({ base: 'max-sm:static max-sm:[&>div:last-child]:inset-x-0 max-sm:[&>div:last-child]:top-full max-sm:[&>div:last-child]:w-auto max-sm:[&>div:last-child]:rounded-none max-sm:[&>div:last-child]:border-x-0 max-sm:[&>div:last-child]:border-t-0' }),
	container: tv({ base: 'flex items-center gap-3' }),
	menu: tv({ base: 'flex flex-col w-[200px] max-sm:w-full [&>*:not(:first-child)]:border-t [&>*:not(:first-child)]:border-steel-700' }),
	section: tv({ base: 'flex flex-col py-2' }),
	item: tv({
		base: [
			'block w-full text-left flex-1 px-6 py-2 text-sm',
			'cursor-pointer hover:text-primary-500',
			'bg-transparent border-0'
		]
	}),
	empty: tv({ base: 'px-5 py-4 text-sm text-steel-300 text-center' })
}
