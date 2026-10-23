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
					if (queuedRenderId) json.renderId = queuedRenderId;
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
