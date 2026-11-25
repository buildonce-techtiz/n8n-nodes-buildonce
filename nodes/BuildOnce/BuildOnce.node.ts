import {
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodeProperties,
	type INodePropertyCollection,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
} from 'n8n-workflow';

import { buildOnceApiRequest } from './GenericFunctions';

/** The API caps `limit` at 100 per page. */
const PAGE_SIZE = 100;

/**
 * Fetch a paginated list (`{ items, total, page, limit }`) page by page, so
 * results past the first 100 aren't silently dropped. Stops at `max` items
 * when given, otherwise at the last page.
 *
 * The page size stays the same on every request: the API offsets by
 * `(page - 1) * limit`, so shrinking `limit` for a last partial page would
 * re-read items already returned. Overshoot is trimmed instead.
 */
async function buildOnceApiRequestAllItems(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	endpoint: string,
	qs: JsonObject = {},
	max?: number,
): Promise<JsonObject[]> {
	const limit = max === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, max);
	const results: JsonObject[] = [];
	for (let page = 1; ; page++) {
		const response = await buildOnceApiRequest.call(
			this,
			'GET',
			endpoint,
			{},
			{ ...qs, page, limit },
		);
		const items = (response.items ?? []) as JsonObject[];
		results.push(...items);
		const total = response.total as number | undefined;
		if (
			items.length < limit ||
			(max !== undefined && results.length >= max) ||
			(total !== undefined && results.length >= total)
		) {
			return max === undefined ? results : results.slice(0, max);
		}
	}
}

const VIDEO_FORMATS = ['mp4', 'webm', 'gif'];

/** How often a queued render is checked while waiting for it. */
const POLL_INTERVAL_MS = 3000;

/**
 * A render request (`{ renderId, files, … }`, from Get Render or Re-render)
 * with `url` set to its first file, so it reads like a template render's
 * response downstream. One still running has no files and is left as is.
 */
function withFileUrl(render: JsonObject): JsonObject {
	const files = render.files as JsonObject[] | undefined;
	if (!Array.isArray(files) || render.url !== undefined) return render;
	return { ...render, url: files[0]?.url ?? null };
}

/**
 * `GET /v1/me` reports credits as `used` and `limit` (the plan's included
 * credits); add `remaining` so a workflow can check it directly. A negative
 * limit means unlimited, so there is no number to report.
 */
function withRemainingCredits(account: JsonObject): JsonObject {
	const plan = account.plan as JsonObject | undefined;
	const credits = plan?.credits as { used?: number; limit?: number } | undefined;
	if (!plan || !credits || typeof credits.used !== 'number' || typeof credits.limit !== 'number') {
		return account;
	}
	const remaining = credits.limit < 0 ? null : Math.max(credits.limit - credits.used, 0);
	return { ...account, plan: { ...plan, credits: { ...credits, remaining } } };
}

/** `GET /v1/renders/:renderId`. */
async function getRender(this: IExecuteFunctions, renderId: string): Promise<JsonObject> {
	return withFileUrl(await buildOnceApiRequest.call(this, 'GET', `/v1/renders/${renderId}`));
}

/**
 * Allowed values for per-render animation (`animation` on Template → Render),
 * as validated by the API (the editor's timeline vocabulary). Anything else
 * is a 400 INVALID_ANIMATION listing the allowed values.
 */
const toOptions = (values: Array<[string, string]>) =>
	values.map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name));
const MOTION_KINDS = toOptions([
	['Blur', 'blur'],
	['Fade', 'fade'],
	['Flip X', 'flip-x'],
	['Flip Y', 'flip-y'],
	['None', 'none'],
	['Rotate', 'rotate'],
	['Scale', 'scale'],
	['Scale Down', 'scale-down'],
	['Scale Up', 'scale-up'],
	['Slide Down', 'slide-down'],
	['Slide Left', 'slide-left'],
	['Slide Right', 'slide-right'],
	['Slide Up', 'slide-up'],
	['Zoom', 'zoom'],
]);

/** What `buildAnimation` reads from the Animation field. */
interface AnimationInput {
	pages?: Array<{
		page?: string;
		duration?: number;
		transition?: string;
		transitionDuration?: number;
	}>;
	layers?: Array<{ layer?: string; settings?: JsonObject }>;
	raw?: Array<{ json?: string | JsonObject }>;
}

const ANIMATION_OPTIONS: INodePropertyCollection[] = [
	{
		name: 'pages',
		displayName: 'Page Timing',
		values: [
			{
				displayName: 'Page',
				name: 'page',
				type: 'string',
				default: 'page1',
				placeholder: 'page1',
				description: '`page1`, `page2`, … or a page ID',
			},
			{
				displayName: 'Duration (Seconds)',
				name: 'duration',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 60, numberPrecision: 2 },
				default: 0,
				description: 'How long the page shows, 0.5–60 s. 0 keeps the template’s timing.',
			},
			{
				displayName: 'Transition',
				name: 'transition',
				type: 'options',
				options: [
					{ name: 'Fade', value: 'fade' },
					{ name: 'Keep Template’s', value: 'keep' },
					{ name: 'None', value: 'none' },
					{ name: 'Slide Left', value: 'slide-left' },
					{ name: 'Slide Right', value: 'slide-right' },
					{ name: 'Wipe', value: 'wipe' },
					{ name: 'Zoom', value: 'zoom' },
				],
				default: 'keep',
				description: 'The transition into the next page',
			},
			{
				displayName: 'Transition Duration (Seconds)',
				name: 'transitionDuration',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 3, numberPrecision: 2 },
				default: 0,
				description: 'Up to 3 s. 0 uses the default length.',
			},
		],
	},
	{
		name: 'layers',
		displayName: 'Layer Animation',
		values: [
			{
				displayName: 'Layer',
				name: 'layer',
				type: 'string',
				default: '',
				placeholder: 'headline',
				description: 'A variable name or layer ID. `page2@headline` changes it on one page only.',
			},
			{
				displayName: 'Settings',
				name: 'settings',
				type: 'collection',
				placeholder: 'Add Setting',
				default: {},
				options: [
					{
						displayName: 'Ambient Direction',
						name: 'ambientDirection',
						type: 'options',
						options: toOptions([
							['Down', 'down'],
							['In', 'in'],
							['Left', 'left'],
							['Out', 'out'],
							['Right', 'right'],
							['Up', 'up'],
						]),
						default: 'in',
						description: 'Which way Ken Burns moves',
					},
					{
						displayName: 'Ambient Motion',
						name: 'ambientAnim',
						type: 'options',
						options: toOptions([
							['Blink', 'blink'],
							['Bounce', 'bounce'],
							['Breathe', 'breathe'],
							['Drift', 'drift'],
							['Float', 'float'],
							['Ken Burns', 'ken-burns'],
							['None', 'none'],
							['Pulse', 'pulse'],
							['Shake', 'shake'],
							['Slow Rotate', 'slow-rotate'],
							['Wiggle', 'wiggle'],
						]),
						default: 'none',
						description: 'Movement that runs the whole time the layer is on screen',
					},
					{
						displayName: 'Ambient Speed',
						name: 'ambientSpeed',
						type: 'number',
						typeOptions: { minValue: 0.25, maxValue: 4, numberPrecision: 2 },
						default: 1,
					},
					{
						displayName: 'Ambient Strength',
						name: 'ambientStrength',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 3, numberPrecision: 2 },
						default: 1,
					},
					{
						displayName: 'Animation Duration (Seconds)',
						name: 'animDuration',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 10, numberPrecision: 2 },
						default: 0.5,
						description: 'How long the enter and exit animations take',
					},
					{
						displayName: 'Easing',
						name: 'animEasing',
						type: 'options',
						options: toOptions([
							['Back', 'back'],
							['Ease In', 'ease-in'],
							['Ease In Out', 'ease-in-out'],
							['Ease Out', 'ease-out'],
							['Elastic', 'elastic'],
							['Linear', 'linear'],
						]),
						default: 'ease-out',
					},
					{
						displayName: 'Enter Animation',
						name: 'enterAnim',
						type: 'options',
						options: MOTION_KINDS,
						default: 'fade',
					},
					{
						displayName: 'Exit Animation',
						name: 'exitAnim',
						type: 'options',
						options: MOTION_KINDS,
						default: 'fade',
					},
					{
						displayName: 'Hide At (Seconds)',
						name: 'hideAt',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 60, numberPrecision: 2 },
						default: 0,
						description: 'When the layer leaves, from the start of its page',
					},
					{
						displayName: 'Highlight At (Seconds)',
						name: 'highlightAt',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 60, numberPrecision: 2 },
						default: 0,
					},
					{
						displayName: 'Highlight Duration (Seconds)',
						name: 'highlightDuration',
						type: 'number',
						typeOptions: { minValue: 0.1, maxValue: 60, numberPrecision: 2 },
						default: 1,
					},
					{
						displayName: 'Pop At (Seconds)',
						name: 'popAt',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 60, numberPrecision: 2 },
						default: 0,
					},
					{
						displayName: 'Reverse Animation',
						name: 'animReverse',
						type: 'boolean',
						default: false,
						description: 'Whether to play the enter animation in reverse',
					},
					{
						displayName: 'Show At (Seconds)',
						name: 'showAt',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 60, numberPrecision: 2 },
						default: 0,
						description: 'When the layer appears, from the start of its page',
					},
					{
						displayName: 'Text Animation',
						name: 'textAnim',
						type: 'options',
						options: toOptions([
							['Letters', 'letters'],
							['Lines', 'lines'],
							['None', 'none'],
							['Typewriter', 'typewriter'],
							['Words', 'words'],
						]),
						default: 'none',
					},
					{
						displayName: 'Text Animation Duration (Seconds)',
						name: 'textAnimDuration',
						type: 'number',
						typeOptions: { minValue: 0.2, maxValue: 20, numberPrecision: 2 },
						default: 1,
					},
				],
			},
		],
	},
	{
		name: 'raw',
		displayName: 'Raw JSON',
		values: [
			{
				displayName: 'Animation (JSON)',
				name: 'json',
				type: 'json',
				default: '{\n  "pages": {},\n  "layers": {}\n}',
				description:
					'Any other allowed value, e.g. `"hideAt": null` or `"duration": null` (automatic). The fields above win where both set the same key.',
			},
		],
	},
];

/**
 * Turns the Animation field into the API's `animation: { pages, layers }`.
 * Raw JSON goes in first and the form's fields override it key by key;
 * nothing is sent when nothing was set.
 */
function buildAnimation(
	this: IExecuteFunctions,
	input: AnimationInput,
	itemIndex: number,
): JsonObject | undefined {
	const pages: Record<string, JsonObject> = {};
	const layers: Record<string, JsonObject> = {};

	for (const { json } of input.raw ?? []) {
		let parsed: unknown = json;
		if (typeof json === 'string') {
			try {
				parsed = JSON.parse(json);
			} catch {
				throw new NodeOperationError(this.getNode(), 'Animation (JSON) is not valid JSON', {
					itemIndex,
				});
			}
		}
		const raw = (parsed ?? {}) as {
			pages?: Record<string, JsonObject>;
			layers?: Record<string, JsonObject>;
		};
		for (const [key, value] of Object.entries(raw.pages ?? {}))
			pages[key] = { ...pages[key], ...value };
		for (const [key, value] of Object.entries(raw.layers ?? {}))
			layers[key] = { ...layers[key], ...value };
	}

	for (const entry of input.pages ?? []) {
		const key = (entry.page ?? '').trim();
		if (!key) continue;
		const page: JsonObject = {};
		if (entry.duration) page.duration = entry.duration;
		if (entry.transition === 'none') page.transition = null;
		else if (entry.transition && entry.transition !== 'keep') {
			page.transition = {
				kind: entry.transition,
				...(entry.transitionDuration ? { duration: entry.transitionDuration } : {}),
			};
		} else if (entry.transitionDuration) {
			throw new NodeOperationError(
				this.getNode(),
				`Page "${key}": a transition duration needs a transition`,
				{ itemIndex },
			);
		}
		if (Object.keys(page).length) pages[key] = { ...pages[key], ...page };
	}

	for (const entry of input.layers ?? []) {
		const key = (entry.layer ?? '').trim();
		if (!key || !entry.settings || !Object.keys(entry.settings).length) continue;
		layers[key] = { ...layers[key], ...entry.settings };
	}

	const animation: JsonObject = {};
	if (Object.keys(pages).length) animation.pages = pages;
	if (Object.keys(layers).length) animation.layers = layers;
	return Object.keys(animation).length ? animation : undefined;
}

/** Video options for Render and Re-render (mp4 / webm / gif; images ignore them). */
const VIDEO_OPTIONS: INodeProperties[] = [
	{
		displayName: 'Frames per Second',
		name: 'fps',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 60 },
		default: 30,
		description: 'Default 30 (GIF: 15, its maximum)',
	},
	{
		displayName: 'Quality',
		name: 'quality',
		type: 'options',
		options: [
			{ name: 'Small', value: 'small', description: 'Smaller file' },
			{ name: 'Standard', value: 'standard' },
			{ name: 'High', value: 'high', description: 'Sharper, larger file' },
		],
		default: 'standard',
		description: 'MP4 and WebM encoder quality. GIF ignores it.',
	},
	{
		displayName: 'Scale',
		name: 'scale',
		type: 'options',
		options: [
			{ name: 'Half (0.5×)', value: 0.5 },
			{ name: 'Original (1×)', value: 1 },
			{ name: 'Double (2×)', value: 2 },
		],
		default: 1,
		description:
			'Size as a multiple of the design’s. Same price at every size; a GIF is never scaled up.',
	},
];

/**
 * Wait for a queued render (a video answers 202 `{ renderId, status }`) by
 * polling it until it has succeeded or failed.
 */
async function waitForRender(
	this: IExecuteFunctions,
	renderId: string,
	timeoutSeconds: number,
	itemIndex: number,
): Promise<JsonObject> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	for (;;) {
		const render = await getRender.call(this, renderId);
		if (render.status === 'succeeded') return render;
		if (render.status === 'failed') {
			const error = (render.error ?? {}) as { status?: number; body?: string | JsonObject };
			const body = error.body;
			const reason =
				typeof body === 'object' && body !== null
					? [body.code, body.message].filter(Boolean).join(': ')
					: body;
			throw new NodeOperationError(
				this.getNode(),
				`Render ${renderId} failed${reason ? `: ${reason}` : ''}`,
				{ itemIndex },
			);
		}
		if (Date.now() + POLL_INTERVAL_MS > deadline) {
			throw new NodeOperationError(
				this.getNode(),
				`Render ${renderId} was still ${render.status} after ${timeoutSeconds} s`,
				{
					itemIndex,
					description:
						'The render keeps going. Fetch it later with the Get Render operation and this render ID, or raise Timeout.',
				},
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
}

/** A listing video takes minutes (#942): poll it far less often than a render. */
const LISTING_VIDEO_POLL_MS = 15000;
/** Status checks in a row that may fail on the network before the wait gives up. */
const MAX_MISSED_POLLS = 3;

/** No HTTP answer at all (a dropped connection), a 429 or a 5xx. */
function isTransient(error: unknown): boolean {
	const code = Number((error as { httpCode?: string | number }).httpCode);
	return !code || code === 429 || code >= 500;
}

/**
 * Wait for a listing video by polling it until it is ready or failed. Ready
 * means at least one of its three files was made; each output carries its own
 * status and URL.
 */
async function waitForListingVideo(
	this: IExecuteFunctions,
	videoId: string,
	timeoutSeconds: number,
	itemIndex: number,
): Promise<JsonObject> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	let missedPolls = 0;
	for (;;) {
		let video: JsonObject;
		try {
			video = await buildOnceApiRequest.call(this, 'GET', `/v1/listing-videos/${videoId}`);
			missedPolls = 0;
		} catch (error) {
			// A wait lasts minutes, so one dropped connection or a passing 5xx
			// (seen live: a poll that hung up mid-wait) must not lose a video
			// that is still being made. A 4xx is a real answer and is thrown.
			if (!isTransient(error) || ++missedPolls > MAX_MISSED_POLLS) {
				throw error instanceof NodeApiError
					? error
					: new NodeApiError(this.getNode(), error as JsonObject);
			}
			await sleep(LISTING_VIDEO_POLL_MS);
			continue;
		}
		if (video.status === 'ready') return video;
		if (video.status === 'failed') {
			throw new NodeOperationError(
				this.getNode(),
				`Listing video ${videoId} failed${video.error ? `: ${String(video.error)}` : ''}`,
				{ itemIndex },
			);
		}
		if (Date.now() + LISTING_VIDEO_POLL_MS > deadline) {
			throw new NodeOperationError(
				this.getNode(),
				`Listing video ${videoId} was still ${String(video.status)} after ${timeoutSeconds} s`,
				{
					itemIndex,
					description:
						'The video keeps going. Fetch it later with Get Video and this video ID, or raise Timeout.',
				},
			);
		}
		await sleep(LISTING_VIDEO_POLL_MS);
	}
}

/** Photo URLs typed one per line or comma-separated, or an expression giving an array. */
function photoUrlList(value: unknown): string[] {
	const parts = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\n,]/);
	return parts.map((url) => url.trim()).filter(Boolean);
}

export class BuildOnce implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'buildonce.app',
		name: 'buildOnce',
		icon: { light: 'file:buildonce.svg', dark: 'file:buildonce.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Render your buildonce.app templates to images, PDFs and videos',
		defaults: { name: 'buildonce.app' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'buildOnceApi', required: true }],
		properties: [
			// Operation values are unique across resources, so `execute` and every
			// field's displayOptions key on `operation` alone; `resource` only
			// groups them in the UI.
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Listing Video', value: 'listingVideo' },
					{ name: 'Render', value: 'render' },
					{ name: 'Template', value: 'template' },
				],
				default: 'template',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get',
						value: 'getAccount',
						description: 'Get the workspace, plan and credits this API key is bound to',
						action: 'Get the account',
					},
					{
						name: 'Get Activity Log',
						value: 'listActivity',
						description: 'List the workspace’s activity log, newest first',
						action: 'Get the activity log',
					},
				],
				default: 'getAccount',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['template'] } },
				options: [
					{
						name: 'Get',
						value: 'getTemplate',
						description: 'Get a single template’s metadata',
						action: 'Get a template',
					},
					{
						name: 'Get Many',
						value: 'listTemplates',
						description: 'List templates in the workspace',
						action: 'Get many templates',
					},
					{
						name: 'Get Parameters',
						value: 'getTemplateParameters',
						description: 'Get the variables a template accepts',
						action: 'Get template parameters',
					},
					{
						name: 'Render',
						value: 'renderTemplate',
						description: 'Render a template to an image, PDF or video',
						action: 'Render a template',
					},
				],
				default: 'renderTemplate',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['render'] } },
				options: [
					{
						name: 'Get',
						value: 'getRender',
						description: 'Get a render and its files, or check on one still running',
						action: 'Get a render',
					},
					{
						name: 'Get Many',
						value: 'listRenders',
						description: 'List past renders in the workspace',
						action: 'Get many renders',
					},
					{
						name: 'Re-Render',
						value: 'rerender',
						description:
							'Render a render again with new values, from its own saved design (keeps hand edits)',
						action: 'Render a render again with new values',
					},
				],
				default: 'getRender',
			},

			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['listingVideo'] } },
				options: [
					{
						name: 'Create Listing',
						value: 'createListing',
						description:
							'Save a real estate listing from its details and photo URLs, or from the agent’s listing page',
						action: 'Create a listing',
					},
					{
						name: 'Create Video',
						value: 'createListingVideo',
						description: 'Make a listing video: vertical, wide and an unbranded MLS copy',
						action: 'Create a listing video',
					},
					{
						name: 'Estimate Video',
						value: 'estimateListingVideo',
						description: 'Price a listing video in credits without making it',
						action: 'Estimate a listing video',
					},
					{
						name: 'Get Video',
						value: 'getListingVideo',
						description: 'Get a listing video’s status and its three files',
						action: 'Get a listing video',
					},
				],
				default: 'createListing',
			},
			{
				displayName: 'Source',
				name: 'listingSource',
				type: 'options',
				displayOptions: { show: { operation: ['createListing'] } },
				options: [
					{ name: 'Details and Photo URLs', value: 'details' },
					{ name: 'Listing Page Link', value: 'link' },
				],
				default: 'details',
			},
			{
				displayName: 'Listing Page Link',
				name: 'listingLink',
				type: 'string',
				displayOptions: { show: { operation: ['createListing'], listingSource: ['link'] } },
				default: '',
				required: true,
				placeholder: 'https://www.youragency.com/listings/42-maple-street',
				description:
					'The agent’s own listing page (their website, brokerage or IDX page). Zillow and Realtor.com are refused.',
			},
			{
				displayName: 'Photo URLs',
				name: 'photoUrls',
				type: 'string',
				typeOptions: { rows: 4 },
				displayOptions: { show: { operation: ['createListing'], listingSource: ['details'] } },
				default: '',
				description:
					'Public photo links in video order, one per line or comma-separated (up to 60). The first one opens the video.',
			},
			{
				displayName: 'Listing Details',
				name: 'listingDetails',
				type: 'collection',
				placeholder: 'Add Detail',
				displayOptions: { show: { operation: ['createListing'], listingSource: ['details'] } },
				default: {},
				options: [
					{ displayName: 'Address', name: 'address', type: 'string', default: '' },
					{
						displayName: 'Area',
						name: 'area',
						type: 'number',
						default: 0,
						description: 'Living area, in the area unit',
					},
					{
						displayName: 'Area Unit',
						name: 'areaUnit',
						type: 'options',
						options: [
							{ name: 'Square Feet', value: 'sqft' },
							{ name: 'Square Metres', value: 'sqm' },
						],
						default: 'sqft',
					},
					{ displayName: 'Baths', name: 'baths', type: 'number', default: 0 },
					{ displayName: 'Beds', name: 'beds', type: 'number', default: 0 },
					{
						displayName: 'Currency',
						name: 'currency',
						type: 'string',
						default: 'USD',
						description: 'ISO 4217 code, e.g. USD',
					},
					{
						displayName: 'Description',
						name: 'description',
						type: 'string',
						typeOptions: { rows: 4 },
						default: '',
					},
					{
						displayName: 'Features',
						name: 'features',
						type: 'string',
						default: '',
						description: 'Short highlights, comma-separated, e.g. Pool, Two-car garage',
					},
					{ displayName: 'Headline', name: 'headline', type: 'string', default: '' },
					{ displayName: 'Price', name: 'price', type: 'number', default: 0 },
					{ displayName: 'Year Built', name: 'yearBuilt', type: 'number', default: 2000 },
				],
			},
			{
				displayName: 'Listing ID',
				name: 'listingId',
				type: 'string',
				displayOptions: { show: { operation: ['createListingVideo', 'estimateListingVideo'] } },
				default: '',
				required: true,
				placeholder: 'lst_…',
				description: 'The listing to make the video from (the ID Create Listing returns)',
			},
			{
				displayName: 'Style',
				name: 'listingVideoStyle',
				type: 'options',
				displayOptions: { show: { operation: ['createListingVideo', 'estimateListingVideo'] } },
				options: [
					{ name: 'Clean', value: 'clean' },
					{ name: 'Luxury', value: 'luxury' },
					{ name: 'Modern', value: 'modern' },
				],
				default: 'modern',
			},
			{
				displayName: 'Voiceover',
				name: 'listingVideoVoice',
				type: 'boolean',
				displayOptions: { show: { operation: ['createListingVideo', 'estimateListingVideo'] } },
				default: true,
				description: 'Whether to add a spoken voiceover written from the listing',
			},
			{
				displayName: 'Captions',
				name: 'listingVideoCaptions',
				type: 'boolean',
				displayOptions: { show: { operation: ['createListingVideo', 'estimateListingVideo'] } },
				default: true,
				description: 'Whether to show word-by-word captions of the voiceover',
			},
			{
				displayName: 'AI Scenes',
				name: 'listingVideoAiScenes',
				type: 'number',
				displayOptions: { show: { operation: ['createListingVideo', 'estimateListingVideo'] } },
				typeOptions: { minValue: 0, maxValue: 6 },
				default: 0,
				description:
					'How many photos, from the first, get an AI camera move (costs AI credits; a failed one is refunded)',
			},
			{
				displayName: 'Additional Fields',
				name: 'listingVideoOptions',
				type: 'collection',
				placeholder: 'Add Field',
				displayOptions: { show: { operation: ['createListingVideo', 'estimateListingVideo'] } },
				default: {},
				options: [
					{
						displayName: 'Music Track ID',
						name: 'musicTrackId',
						type: 'string',
						default: '',
						placeholder: 'mtr_…',
						description: 'A track from the buildonce.app music library; no music when empty',
					},
					{
						displayName: 'Status Label',
						name: 'statusLabel',
						type: 'string',
						default: '',
						placeholder: 'Just Listed',
						description: 'A chip on the opening, e.g. Just Listed or Open House',
					},
					{
						displayName: 'Voice ID',
						name: 'voiceId',
						type: 'string',
						default: '',
						description: 'A specific voice; the default voice when empty',
					},
				],
			},
			{
				displayName: 'Wait for Completion',
				name: 'listingVideoWait',
				type: 'boolean',
				displayOptions: { show: { operation: ['createListingVideo'] } },
				default: true,
				description:
					'Whether to wait until the video is ready and return its files. When off, returns the video ID straight away; fetch it later with Get Video.',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'listingVideoTimeout',
				type: 'number',
				displayOptions: { show: { operation: ['createListingVideo'], listingVideoWait: [true] } },
				typeOptions: { minValue: 60 },
				default: 900,
				description:
					'How long to wait before giving up. The video keeps going on buildonce.app either way.',
			},
			{
				displayName: 'Video ID',
				name: 'listingVideoId',
				type: 'string',
				displayOptions: { show: { operation: ['getListingVideo'] } },
				default: '',
				required: true,
				placeholder: 'lvd_…',
			},

			// ---------- shared: template picker ----------
			{
				displayName: 'Template Name or ID',
				name: 'templateId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTemplates' },
				displayOptions: {
					show: { operation: ['renderTemplate', 'getTemplate', 'getTemplateParameters'] },
				},
				default: '',
				required: true,
				description:
					'The template to use. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// ---------- Get Render / Re-render ----------
			{
				displayName: 'Render ID',
				name: 'renderId',
				type: 'string',
				displayOptions: { show: { operation: ['getRender', 'rerender'] } },
				default: '',
				required: true,
				placeholder: 'rnd_…',
				description:
					'The render to use: the `renderId` a render returned (`rnd_…`), or one of its file IDs (`ren_…`)',
			},

			// ---------- Re-render ----------
			{
				displayName: 'Modifications',
				name: 'rerenderModifications',
				type: 'fixedCollection',
				displayOptions: { show: { operation: ['rerender'] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Modification',
				description:
					'Variable name → new value. `page2@headline` changes only the 2nd page, `&lt;pageId&gt;@headline` a page by ID; a page-scoped key beats a plain one.',
				default: {},
				options: [
					{
						name: 'modification',
						displayName: 'Modification',
						values: [
							{
								displayName: 'Variable Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'headline or page2@headline',
							},
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Format',
				name: 'rerenderFormat',
				type: 'options',
				displayOptions: { show: { operation: ['rerender'] } },
				options: [
					{ name: 'GIF', value: 'gif' },
					{ name: 'JPEG', value: 'jpeg' },
					{ name: 'MP4', value: 'mp4' },
					{ name: 'PDF', value: 'pdf' },
					{ name: 'PNG', value: 'png' },
					{ name: 'Same as Original', value: 'source' },
					{ name: 'WebM', value: 'webm' },
				],
				default: 'source',
				description:
					'Every page is rendered. Video formats cost 1 credit per started second, at most 60 s.',
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				displayOptions: { show: { operation: ['rerender'] } },
				default: true,
				description:
					'Whether to wait until a video result is ready and return its file (images are always returned at once). When off, a video returns its render ID straight away; fetch it later with Get.',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				displayOptions: { show: { operation: ['rerender'], waitForCompletion: [true] } },
				typeOptions: { minValue: 10 },
				default: 300,
				description:
					'How long to wait for a video before giving up. The render keeps going on buildonce.app either way.',
			},
			{
				displayName: 'Video Options',
				name: 'videoOptions',
				type: 'collection',
				placeholder: 'Add Option',
				displayOptions: { show: { operation: ['rerender'] } },
				default: {},
				description: 'Used only when the result is a video',
				options: VIDEO_OPTIONS,
			},
			{
				displayName: 'Additional Fields',
				name: 'rerenderOptions',
				type: 'collection',
				placeholder: 'Add Field',
				displayOptions: { show: { operation: ['rerender'] } },
				default: {},
				options: [
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						description: 'Lets a retried request avoid a second render and charge',
					},
				],
			},

			// ---------- Render Template ----------
			{
				displayName: 'Format',
				name: 'format',
				type: 'options',
				displayOptions: { show: { operation: ['renderTemplate'] } },
				options: [
					{ name: 'GIF', value: 'gif', description: 'Animated GIF of every page' },
					{ name: 'JPEG', value: 'jpeg' },
					{ name: 'MP4', value: 'mp4', description: 'Video of every page, with animations' },
					{ name: 'PDF', value: 'pdf' },
					{ name: 'PNG', value: 'png' },
					{ name: 'WebM', value: 'webm', description: 'Video of every page, with animations' },
				],
				default: 'png',
				description:
					'Video formats (MP4, WebM, GIF) play every page with its animations and cost 1 credit per started second, at most 60 s',
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				displayOptions: { show: { operation: ['renderTemplate'], format: VIDEO_FORMATS } },
				default: true,
				description:
					'Whether to wait until the video is ready and return its file. When off, returns the render ID straight away; fetch the result later with Get Render.',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				displayOptions: {
					show: {
						operation: ['renderTemplate'],
						format: VIDEO_FORMATS,
						waitForCompletion: [true],
					},
				},
				typeOptions: { minValue: 10 },
				default: 300,
				description:
					'How long to wait before giving up. The render keeps going on buildonce.app either way.',
			},
			{
				displayName: 'Video Options',
				name: 'videoOptions',
				type: 'collection',
				placeholder: 'Add Option',
				displayOptions: { show: { operation: ['renderTemplate'], format: VIDEO_FORMATS } },
				default: {},
				options: VIDEO_OPTIONS,
			},
			{
				displayName: 'Animation',
				name: 'animation',
				type: 'fixedCollection',
				placeholder: 'Add Animation Change',
				displayOptions: { show: { operation: ['renderTemplate'], format: VIDEO_FORMATS } },
				typeOptions: { multipleValues: true },
				description:
					'Change timing and animation for this render only, so one template gives different cuts. The template itself is never changed.',
				default: {},
				options: ANIMATION_OPTIONS,
			},
			{
				displayName: 'Modifications',
				name: 'modifications',
				type: 'fixedCollection',
				displayOptions: { show: { operation: ['renderTemplate'] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Modification',
				description: 'Variable name → replacement value, applied before rendering',
				default: {},
				options: [
					{
						name: 'modification',
						displayName: 'Modification',
						values: [
							{
								displayName: 'Variable Name or ID',
								name: 'name',
								type: 'options',
								typeOptions: { loadOptionsMethod: 'getTemplateParameters' },
								default: '',
								description:
									'The template variable to override. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
							},
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				displayOptions: { show: { operation: ['renderTemplate'] } },
				default: {},
				options: [
					{
						displayName: 'Page ID',
						name: 'pageId',
						type: 'string',
						default: '',
						description: 'Render a specific page by ID. Defaults to the active page.',
					},
					{
						displayName: 'All Pages',
						name: 'allPages',
						type: 'boolean',
						default: false,
						description:
							'Whether to render every page instead of one. For PNG/JPEG this produces one file per page; for PDF, a single multi-page PDF. Ignores Page ID when enabled.',
					},
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						description: 'Lets a retried request avoid a second credit charge',
					},
				],
			},

			// ---------- List Templates ----------
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				displayOptions: { show: { operation: ['listTemplates', 'listRenders', 'listActivity'] } },
				default: false,
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				displayOptions: {
					show: {
						operation: ['listTemplates', 'listRenders', 'listActivity'],
						returnAll: [false],
					},
				},
				typeOptions: { minValue: 1 },
				default: 50,
			},
			{
				displayName: 'Filters',
				name: 'templateFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				displayOptions: { show: { operation: ['listTemplates'] } },
				default: {},
				options: [
					{ displayName: 'Search', name: 'search', type: 'string', default: '' },
					{
						displayName: 'Sort',
						name: 'sort',
						type: 'options',
						options: [
							{ name: 'Last Modified', value: 'updated_at' },
							{ name: 'Date Created', value: 'created_at' },
							{ name: 'Name A-Z', value: 'name' },
							{ name: 'Most Renders', value: 'renders' },
						],
						default: 'updated_at',
					},
					{ displayName: 'Folder ID', name: 'folderId', type: 'string', default: '' },
				],
			},

			// ---------- List Renders ----------
			{
				displayName: 'Filters',
				name: 'renderFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				displayOptions: { show: { operation: ['listRenders'] } },
				default: {},
				options: [
					{
						displayName: 'Format',
						name: 'format',
						type: 'options',
						options: [
							{ name: 'GIF', value: 'gif' },
							{ name: 'JPEG', value: 'jpeg' },
							{ name: 'MP4', value: 'mp4' },
							{ name: 'PDF', value: 'pdf' },
							{ name: 'PNG', value: 'png' },
							{ name: 'WebM', value: 'webm' },
						],
						default: 'png',
					},
					{
						displayName: 'Template ID',
						name: 'templateId',
						type: 'string',
						default: '',
					},
				],
			},

			// ---------- Get Activity Log ----------
			{
				displayName: 'Filters',
				name: 'activityFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				displayOptions: { show: { operation: ['listActivity'] } },
				default: {},
				options: [
					{
						displayName: 'Action',
						name: 'action',
						type: 'string',
						default: '',
						placeholder: 'render.',
						description:
							'Prefix match: `render.` covers every render event, `template.created` just that one',
					},
					{
						displayName: 'From',
						name: 'from',
						type: 'dateTime',
						default: '',
						description:
							'Only entries at or after this time. Read as UTC unless it includes a time zone.',
					},
					{
						displayName: 'Source',
						name: 'source',
						type: 'options',
						options: [
							{ name: 'API', value: 'api' },
							{ name: 'Dashboard', value: 'dashboard' },
							{ name: 'MCP', value: 'mcp' },
							{ name: 'Signed URL', value: 'signed-url' },
							{ name: 'Staff', value: 'staff' },
							{ name: 'System', value: 'system' },
							{ name: 'Webhook', value: 'webhook' },
						],
						default: 'api',
						description: 'Where the activity came from',
					},
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						options: [
							{ name: 'Failure', value: 'failure' },
							{ name: 'Success', value: 'success' },
						],
						default: 'success',
					},
					{
						displayName: 'To',
						name: 'to',
						type: 'dateTime',
						default: '',
						description:
							'Only entries at or before this time. Read as UTC unless it includes a time zone.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const items = await buildOnceApiRequestAllItems.call(this, '/v1/templates', {
					sort: 'name',
				});
				return items.map((template) => ({
					name: template.name as string,
					value: template.id as string,
				}));
			},

			async getTemplateParameters(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const templateId = this.getCurrentNodeParameter('templateId') as string;
				if (!templateId) return [];
				const response = await buildOnceApiRequest.call(
					this,
					'GET',
					`/v1/templates/${templateId}/parameters`,
				);
				const parameters = (response.parameters ?? []) as Array<{
					key: string;
					label: string | null;
				}>;
				return parameters.map((param) => ({ name: param.label ?? param.key, value: param.key }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			let responseData: JsonObject;
			// Set once a render is queued, so a failed or timed-out wait still
			// hands the ID on (with Continue On Fail) for a later Get Render.
			let queuedRenderId: string | undefined;

			try {
				if (operation === 'renderTemplate') {
					const templateId = this.getNodeParameter('templateId', i) as string;
					const format = this.getNodeParameter('format', i) as string;
					const modificationsInput = this.getNodeParameter('modifications', i) as {
						modification?: Array<{ name: string; value: string }>;
					};
					const additionalFields = this.getNodeParameter('additionalFields', i) as {
						pageId?: string;
						allPages?: boolean;
						idempotencyKey?: string;
					};

					const modifications: Record<string, string> = {};
					for (const mod of modificationsInput.modification ?? []) {
						if (mod.name) modifications[mod.name] = mod.value;
					}

					const body: JsonObject = { format, modifications, ...additionalFields };
					const isVideo = VIDEO_FORMATS.includes(format);
					if (isVideo) {
						const video = this.getNodeParameter('videoOptions', i, {}) as JsonObject;
						if (Object.keys(video).length) body.video = video;
						const animation = buildAnimation.call(
							this,
							this.getNodeParameter('animation', i, {}) as AnimationInput,
							i,
						);
						if (animation) body.animation = animation;
					}

					responseData = await buildOnceApiRequest.call(
						this,
						'POST',
						`/v1/templates/${templateId}/render`,
						body,
					);
				} else if (operation === 'rerender') {
					const renderId = (this.getNodeParameter('renderId', i) as string).trim();
					const format = this.getNodeParameter('rerenderFormat', i) as string;
					const modificationsInput = this.getNodeParameter('rerenderModifications', i) as {
						modification?: Array<{ name: string; value: string }>;
					};
					const options = this.getNodeParameter('rerenderOptions', i, {}) as JsonObject;

					const modifications: Record<string, string> = {};
					for (const mod of modificationsInput.modification ?? []) {
						if (mod.name) modifications[mod.name.trim()] = mod.value;
					}

					const body: JsonObject = { modifications, ...options };
					if (format !== 'source') body.format = format;
					// Sent whatever the format: with "Same as Original" only the API knows
					// whether the result is a video, and an image ignores these.
					const video = this.getNodeParameter('videoOptions', i, {}) as JsonObject;
					if (Object.keys(video).length) body.video = video;

					responseData = withFileUrl(
						await buildOnceApiRequest.call(this, 'POST', `/v1/renders/${renderId}/rerender`, body),
					);
				} else if (operation === 'getRender') {
					const renderId = (this.getNodeParameter('renderId', i) as string).trim();
					responseData = await getRender.call(this, renderId);
				} else if (operation === 'getTemplate') {
					const templateId = this.getNodeParameter('templateId', i) as string;
					responseData = await buildOnceApiRequest.call(this, 'GET', `/v1/templates/${templateId}`);
				} else if (operation === 'getTemplateParameters') {
					const templateId = this.getNodeParameter('templateId', i) as string;
					responseData = await buildOnceApiRequest.call(
						this,
						'GET',
						`/v1/templates/${templateId}/parameters`,
					);
				} else if (operation === 'listTemplates' || operation === 'listRenders') {
					const isTemplates = operation === 'listTemplates';
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const filters = this.getNodeParameter(
						isTemplates ? 'templateFilters' : 'renderFilters',
						i,
					) as JsonObject;
					const max = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);
					const items = await buildOnceApiRequestAllItems.call(
						this,
						isTemplates ? '/v1/templates' : '/v1/renders',
						filters,
						max,
					);
					responseData = { items } as unknown as JsonObject;
				} else if (operation === 'getAccount') {
					responseData = withRemainingCredits(
						await buildOnceApiRequest.call(this, 'GET', '/v1/me'),
					);
				} else if (operation === 'listActivity') {
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const filters = this.getNodeParameter('activityFilters', i) as JsonObject;
					const qs: JsonObject = {};
					for (const [key, value] of Object.entries(filters)) {
						if (value === '' || value === undefined) continue;
						if (key !== 'from' && key !== 'to') {
							qs[key] = value;
							continue;
						}
						// n8n's date picker gives a time without a zone. Read that as UTC
						// rather than the server's own zone, so the window doesn't move
						// with where n8n runs.
						const text = String(value);
						const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(text);
						const date = new Date(hasZone || !text.includes('T') ? text : `${text}Z`);
						if (Number.isNaN(date.getTime())) {
							throw new NodeOperationError(
								this.getNode(),
								`"${key}" is not a valid date: ${text}`,
								{
									itemIndex: i,
								},
							);
						}
						qs[key] = date.toISOString();
					}
					const max = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);
					const items = await buildOnceApiRequestAllItems.call(this, '/v1/workspace/logs', qs, max);
					responseData = { items } as unknown as JsonObject;
				} else if (operation === 'createListing') {
					const source = this.getNodeParameter('listingSource', i) as string;
					let body: JsonObject;
					if (source === 'link') {
						body = { link: (this.getNodeParameter('listingLink', i) as string).trim() };
					} else {
						const details = this.getNodeParameter('listingDetails', i, {}) as JsonObject;
						body = {};
						for (const [key, value] of Object.entries(details)) {
							if (value === '' || value === undefined || value === null) continue;
							body[key] =
								key === 'features'
									? String(value)
											.split(',')
											.map((f) => f.trim())
											.filter(Boolean)
									: value;
						}
						const photoUrls = photoUrlList(this.getNodeParameter('photoUrls', i, ''));
						if (photoUrls.length) body.photoUrls = photoUrls;
					}
					responseData = await buildOnceApiRequest.call(this, 'POST', '/v1/listings', body);
				} else if (operation === 'createListingVideo' || operation === 'estimateListingVideo') {
					const options = this.getNodeParameter('listingVideoOptions', i, {}) as JsonObject;
					const body: JsonObject = {
						listingId: (this.getNodeParameter('listingId', i) as string).trim(),
						style: this.getNodeParameter('listingVideoStyle', i) as string,
						voice: this.getNodeParameter('listingVideoVoice', i) as boolean,
						captions: this.getNodeParameter('listingVideoCaptions', i) as boolean,
						aiScenes: this.getNodeParameter('listingVideoAiScenes', i) as number,
					};
					for (const [key, value] of Object.entries(options)) {
						if (typeof value === 'string' && value.trim()) body[key] = value.trim();
					}
					const isEstimate = operation === 'estimateListingVideo';
					responseData = await buildOnceApiRequest.call(
						this,
						'POST',
						isEstimate ? '/v1/listing-videos/estimate' : '/v1/listing-videos',
						body,
					);
					if (!isEstimate && this.getNodeParameter('listingVideoWait', i, true)) {
						queuedRenderId = responseData.id as string;
						responseData = await waitForListingVideo.call(
							this,
							queuedRenderId,
							this.getNodeParameter('listingVideoTimeout', i, 900) as number,
							i,
						);
					}
				} else if (operation === 'getListingVideo') {
					const videoId = (this.getNodeParameter('listingVideoId', i) as string).trim();
					responseData = await buildOnceApiRequest.call(
						this,
						'GET',
						`/v1/listing-videos/${videoId}`,
					);
				} else {
					throw new NodeApiError(this.getNode(), {
						message: `Unknown operation: ${operation}`,
					} as JsonObject);
				}

				// A video (render or re-render) is always queued: the API answers
				// `{ renderId, status }`. Wait for it unless asked not to.
				const pending = responseData.status === 'queued' || responseData.status === 'processing';
				const canWait = operation === 'renderTemplate' || operation === 'rerender';
				if (canWait && pending && this.getNodeParameter('waitForCompletion', i, true)) {
					queuedRenderId = responseData.renderId as string;
					responseData = await waitForRender.call(
						this,
						queuedRenderId,
						this.getNodeParameter('timeout', i, 300) as number,
						i,
					);
				}
			} catch (error) {
				if (this.continueOnFail()) {
					const json: JsonObject = { error: (error as Error).message };
					if (queuedRenderId) {
						// A listing video's id is lvd_…; a render's is rnd_….
						json[queuedRenderId.startsWith('lvd_') ? 'videoId' : 'renderId'] = queuedRenderId;
					}
					returnData.push({ json, pairedItem: { item: i } });
					continue;
				}
				// n8n's own errors carry the HTTP context its UI shows, so they pass
				// through; anything else is wrapped and tied to the failing item.
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				throw nodeError;
			}

			const items_ = (responseData.items ?? responseData) as JsonObject | JsonObject[];
			if (Array.isArray(items_)) {
				for (const item of items_) {
					returnData.push({ json: item, pairedItem: { item: i } });
				}
			} else {
				returnData.push({ json: responseData, pairedItem: { item: i } });
			}
		}

		return [returnData];
	}
}
