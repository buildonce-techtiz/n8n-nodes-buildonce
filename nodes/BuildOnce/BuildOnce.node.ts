import {
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
} from 'n8n-workflow';

/**
 * Every BuildOnce response is wrapped as `{ success: true, data }` (or
 * `{ success: false, code, message }` for errors, which never reaches here —
 * a non-2xx throws before this runs). Unwrap once, centrally, rather than at
 * every call site.
 */
async function buildOnceApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: 'GET' | 'POST',
	endpoint: string,
	body: JsonObject = {},
	qs: JsonObject = {},
) {
	const credentials = await this.getCredentials('buildOnceApi');
	const options = {
		method,
		body,
		qs,
		url: `${credentials.domain}${endpoint}`,
		json: true,
	};
	try {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'buildOnceApi',
			options,
		);
		return (response as { data: JsonObject }).data;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

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
 * `GET /v1/renders/:renderId`, with `url` set to the first file of a finished
 * render so it reads like an image render's response downstream.
 */
async function getRender(this: IExecuteFunctions, renderId: string): Promise<JsonObject> {
	const render = await buildOnceApiRequest.call(this, 'GET', `/v1/renders/${renderId}`);
	if (render.status !== 'succeeded') return render;
	const files = (render.files ?? []) as JsonObject[];
	return { ...render, url: files[0]?.url ?? null };
}

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

			// ---------- Get Render ----------
			{
				displayName: 'Render ID',
				name: 'renderId',
				type: 'string',
				displayOptions: { show: { operation: ['getRender'] } },
				default: '',
				required: true,
				placeholder: 'rnd_…',
				description:
					'The render to fetch: the `renderId` a render returned (`rnd_…`), or one of its file IDs (`ren_…`)',
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
				options: [
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
				],
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
				displayOptions: { show: { operation: ['listTemplates', 'listRenders'] } },
				default: false,
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				displayOptions: {
					show: { operation: ['listTemplates', 'listRenders'], returnAll: [false] },
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
					}

					responseData = await buildOnceApiRequest.call(
						this,
						'POST',
						`/v1/templates/${templateId}/render`,
						body,
					);

					// A video is always queued: the API answers `{ renderId, status }`.
					const pending = responseData.status === 'queued' || responseData.status === 'processing';
					if (pending && this.getNodeParameter('waitForCompletion', i, true)) {
						queuedRenderId = responseData.renderId as string;
						responseData = await waitForRender.call(
							this,
							responseData.renderId as string,
							this.getNodeParameter('timeout', i, 300) as number,
							i,
						);
					}
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
				} else {
					throw new NodeApiError(this.getNode(), {
						message: `Unknown operation: ${operation}`,
					} as JsonObject);
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
