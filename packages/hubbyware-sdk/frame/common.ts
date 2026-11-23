// @cxxi-lab/hubbyware-sdk inside a hubby's frame: the SDK's common API (docs/plan-isolation.md § 2,
// "isolation first"), the same names a hubby has in the app. Everything goes to the host by
// message: the frame has no token, no cookie, no access to the app. What the app's SDK has and this
// one doesn't (`platform`, the app's components, webviews…) is left out on purpose: a hubby using
// it can't run isolated yet.
import { createElement, useEffect, useState, type ReactNode } from 'react'
import { call, currentInit, useAppState, watchCollection } from './sdk'

export { ai, api, apiStream, ApiError, errorMessage, hubbies, nav, notifications, oauth, settings, tasks, useAppState, useInit, useNavReselect, usePath, type AgentCallResult, type AgentDevice, type AiImageRequest, type AiImageResult, type AiImportedFile, type AiImportKind, type AiSpeechRequest, type AiSpeechResult, type AgentEngine, type AgentRunOptions, type AgentRunRequest, type AgentRunResult, type AgentTool, type AiChatOptions, type AiChatRequest, type AiChatResult, type AiMessage, type AiRepoModel, type AiTool, type AiToolCall, type AiUserModel, type ApiHandler, type NavEntry, type HubbyAnswer, type TimelineEntry, type OAuthConnection, type Task, type TaskState } from './sdk'
export { defineHubby, start, type HubbyDefinition, type HubbyPageDefinition } from './hubby'
export { BottomBar, type BottomBarEntry, type BottomBarTab } from './BottomBar'
export { platform, storage, type Capabilities, type FramePlatform } from './platform'
export type {
	HubbyManifest, HubbyNavItem, HubbyRoute, ListResponse, NativeIcon, NativePlayerAction, NativePlayerApi, NativePlayerOptions,
	NativePlayerPanel, PaginatedResponse, SingleResponse, TimelineItem, Unsubscribe
} from './types'
export { WebSurface, type WebSurfaceElement, type WebSurfaceProps } from './WebSurface'
export { useBackHandler, useMediaQuery } from '@cxxi-lab/hubbyware-ui'
// the design system's components, as the app's SDK hands them too
export {
	Button, IconButton, Checkbox, ChoiceSwitch, Form, InputField, Switch, Dropdown, ConfirmationModal, Modal,
	Table, TableCell, TableHead, TableHeadGroup, TableRow, TableRowGroup, Markdown, type MarkdownProps, type FormData
} from '@cxxi-lab/hubbyware-ui'

// --- its collections ---

/** What the platform adds to every document. */
export interface HubbyDocument {
	id: string
	_createdAt: string
	_updatedAt: string
	_version: number
}

/** A filter's value: equality, or operators (`in` takes a list). Fields: indexed ones only. */
export type FilterValue = string | number | boolean | null
	| { eq?: FilterValue, ne?: FilterValue, in?: FilterValue[], gt?: FilterValue, gte?: FilterValue, lt?: FilterValue, lte?: FilterValue, exists?: boolean, prefix?: string }

export interface CollectionQuery {
	filter?: Record<string, FilterValue>
	/** fields along an index, `-` for descending (e.g. '-_updatedAt'); default '-_updatedAt' */
	sort?: string
	/** 1–200, default 50 */
	limit?: number
	cursor?: string
}

export interface CollectionPage<T> {
	data: T[]
	next: string | null
}

export type BatchOperation<T> =
	| { op: 'create', data: Partial<T> }
	| { op: 'update', id: string, data: Partial<T>, version?: number }
	| { op: 'delete', id: string }

/**
 * One of the hubby's collections, kept on the device and synced (the host holds them, seals their
 * encrypted fields: the frame never sees the key). `collection(hubby, name)` (the form of the
 * hubbies from before isolation) is accepted, the hubby being always this one.
 */
export function collection<T extends object>(hubbyOrName: string, maybeName?: string) {
	const name = maybeName ?? hubbyOrName
	type D = T & HubbyDocument
	const c = <R>(method: string, ...args: unknown[]) => call<R>(`collections.${method}`, name, ...args)
	return {
		find: (q: CollectionQuery = {}) => c<CollectionPage<D>>('find', q),
		findAll: (q: Omit<CollectionQuery, 'cursor' | 'limit'> = {}) => c<D[]>('findAll', q),
		get: (id: string) => c<D>('get', id),
		create: (data: Partial<T>) => c<D>('create', data),
		createWithId: (id: string, data: Partial<T>) => c<D>('createWithId', id, data),
		update: (id: string, data: Partial<T>, version?: number) => c<D>('update', id, data, version),
		replace: (id: string, data: T) => c<D>('replace', id, data),
		remove: (id: string) => c<void>('remove', id),
		batch: (operations: BatchOperation<T>[]) => c<Array<D | null>>('batch', operations),
		/** Called with a document's id each time one changes (here, in another window, another device). */
		onChange: (listener: (id: string) => void) => watchCollection(name, listener)
	}
}

// --- the app's state, for this hubby ---

/** Whether the hubby is shown (its Privacy). Only its own: `id` is accepted for the app's form. */
export function useHubbyVisible(_id?: string): boolean {
	return useAppState().visible
}

/** Whether the app is in private mode (its hidden hubbies revealed). */
export function usePrivateMode(): boolean {
	return useAppState().privateMode
}

/** Whether the hubby's amounts are blurred (its Privacy). */
export function useAmountsBlurred(_id?: string): boolean {
	return useAppState().amountsBlurred
}

/** For a hubby going out through the VPN: whether its tunnel is up. */
export function useTunnelReady(): boolean {
	return useAppState().tunnelReady
}

/**
 * An amount of the hubby (money, a balance…): blurred when its Privacy asks for it, a click shows
 * that one until it is clicked again or the app hides them all again (as in the app).
 */
export function Amount({ children, className = '' }: { hubby?: string, children: ReactNode, className?: string }) {
	const { amountsBlurred, blurEpoch } = useAppState()
	const [shown, setShown] = useState(false)
	useEffect(() => setShown(false), [blurEpoch])
	if (!amountsBlurred) return createElement('span', { className }, children)
	return createElement('span', {
		role: 'button',
		tabIndex: 0,
		title: shown ? 'Hide the amount' : 'Show the amount',
		onClick: (e: { stopPropagation(): void }) => { e.stopPropagation(); setShown(v => !v) },
		onKeyDown: (e: { key: string, preventDefault(): void }) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShown(v => !v) } },
		className: `${className} cursor-pointer transition-[filter] ${shown ? '' : 'blur-[6px] select-none'}`
	}, children)
}

// --- what other hubbies contribute ---

const NO_CONTRIBUTIONS: never[] = []

/**
 * What the other hubbies contribute to a point (Planner's calendar…): none in a frame. A
 * contribution was a function and a component another hubby ran in the app; between isolated
 * hubbies it will be their APIs (docs/plan-isolation.md, D2: another chantier). Until then the
 * link is cut, and a hubby reading contributions gets none (the same list each render).
 */
export function useContributions(_point: string): never[] {
	return NO_CONTRIBUTIONS
}

/**
 * The server's base URL (its origin is the one the frame may show media from: signed assets,
 * proxied images). Not to call it: the frame can't reach the network, `api()` goes through the
 * host. Empty until the host's `init`.
 */
export function getApiBaseUrl(_path?: string): string {
	return currentInit()?.apiBase ?? ''
}

// --- the web socle (the host applies it to the surfaces it shows) ---

/** A site's integration (cookies, referer rules) before it loads: the host does it for the surfaces. */
export async function ensureIntegrationForUrl(url: string): Promise<void> {
	await call('web.integration', url)
}

/** Whether a site's integration is known already: in a frame, always (the host checks each load). */
export function isIntegrationKnownSync(_url: string): boolean {
	return true
}

export interface PlayerConfig {
	host: string
	scripts: { page: string | null, embed: string | null, pause: string | null }
}

const playerConfigs = new Map<string, Promise<PlayerConfig | null>>()

/** The player's scripts for a site (null: none), the web capability's; once per domain (a failure is asked again). */
export function getPlayerConfig(domain: string): Promise<PlayerConfig | null> {
	const key = domain.toLowerCase()
	const cached = playerConfigs.get(key)
	if (cached) return cached
	const pending = call<{ data: PlayerConfig }>('api', `/api/cap/web/players/${key}`, {}).then(r => r.data, err => {
		// none for this site (404): kept; another failure: asked again next time
		if ((err as { status?: number }).status === 404) return null
		playerConfigs.delete(key)
		console.warn('[player] scripts lookup failed for', key, err)
		return null
	})
	playerConfigs.set(key, pending)
	return pending
}

/** The shell's player blocklist: the host keeps it for the surfaces it shows. */
export async function syncPlayerBlocklist(): Promise<void> {}

/** The partition of the hubby's webviews: the host's choice (accepted for the webview's form). */
export const webviewPartition = ''

// --- helpers (as in the app) ---

export function formatDuration(seconds: number | null): string {
	if (seconds === null) return '—'
	const h = Math.floor(seconds / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	const s = seconds % 60
	const pad = (n: number) => String(n).padStart(2, '0')
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatDate(iso: string | null): string {
	if (!iso) return '—'
	return new Date(iso).toLocaleDateString()
}

/** What a hubby.json says of the hubby, for its definition (as in the app; the host reads the rest). */
export function describe(info: { label: string, description?: string }): { label: string, description?: string } {
	return { label: info.label, description: info.description }
}
