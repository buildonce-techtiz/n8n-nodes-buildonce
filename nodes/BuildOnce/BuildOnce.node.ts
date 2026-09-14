import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import type { JsonObject } from 'n8n-workflow';

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
		return await this.helpers.httpRequestWithAuthentication.call(this, 'buildOnceApi', options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

export class BuildOnce implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BuildOnce',
		name: 'buildOnce',
		icon: { light: 'file:buildonce.svg', dark: 'file:buildonce.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Render templates and images with BuildOnce',
		defaults: { name: 'BuildOnce' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'buildOnceApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get Template',
						value: 'getTemplate',
						description: 'Get a single template’s metadata',
						action: 'Get a template',
					},
					{
						name: 'Get Template Parameters',
						value: 'getTemplateParameters',
						description: 'Get the variables a template accepts',
						action: 'Get template parameters',
					},
					{
						name: 'List Renders',
						value: 'listRenders',
						description: 'List past renders in the workspace',
						action: 'List renders',
					},
					{
						name: 'List Templates',
						value: 'listTemplates',
						description: 'List templates in the workspace',
						action: 'List templates',
					},
					{
						name: 'Render Template',
						value: 'renderTemplate',
						description: 'Rasterize a template to an image or PDF',
						action: 'Render a template',
					},
				],
				default: 'renderTemplate',
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
				description: 'The template to use. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// ---------- Render Template ----------
			{
				displayName: 'Format',
				name: 'format',
				type: 'options',
				displayOptions: { show: { operation: ['renderTemplate'] } },
				options: [
					{ name: 'PNG', value: 'png' },
					{ name: 'JPEG', value: 'jpeg' },
					{ name: 'PDF', value: 'pdf' },
				],
				default: 'png',
			},
			{
				displayName: 'Modifications',
				name: 'modifications',
				type: 'fixedCollection',
				displayOptions: { show: { operation: ['renderTemplate'] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Modification',
				description:
					'Variable name → replacement value, applied before rendering. Use "Get Template Parameters" to see the variable names this template accepts.',
				default: {},
				options: [
					{
						name: 'modification',
						displayName: 'Modification',
						values: [
							{ displayName: 'Variable Name', name: 'name', type: 'string', default: '' },
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
							{ name: 'PNG', value: 'png' },
							{ name: 'JPEG', value: 'jpeg' },
							{ name: 'PDF', value: 'pdf' },
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
				const response = await buildOnceApiRequest.call(this, 'GET', '/v1/templates', {}, { limit: 100 });
				const items = (response.items ?? response) as Array<{ id: string; name: string }>;
				return items.map((template) => ({ name: template.name, value: template.id }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			let responseData: JsonObject;

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

				responseData = await buildOnceApiRequest.call(
					this,
					'POST',
					`/v1/templates/${templateId}/render`,
					{ format, modifications, ...additionalFields },
				);
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
			} else if (operation === 'listTemplates') {
				const returnAll = this.getNodeParameter('returnAll', i) as boolean;
				const filters = this.getNodeParameter('templateFilters', i) as JsonObject;
				const qs: JsonObject = { ...filters };
				if (!returnAll) qs.limit = this.getNodeParameter('limit', i) as number;
				else qs.limit = 100;
				responseData = await buildOnceApiRequest.call(this, 'GET', '/v1/templates', {}, qs);
			} else if (operation === 'listRenders') {
				const returnAll = this.getNodeParameter('returnAll', i) as boolean;
				const filters = this.getNodeParameter('renderFilters', i) as JsonObject;
				const qs: JsonObject = { ...filters };
				if (!returnAll) qs.limit = this.getNodeParameter('limit', i) as number;
				else qs.limit = 100;
				responseData = await buildOnceApiRequest.call(this, 'GET', '/v1/renders', {}, qs);
			} else {
				throw new NodeApiError(this.getNode(), {
					message: `Unknown operation: ${operation}`,
				} as JsonObject);
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
