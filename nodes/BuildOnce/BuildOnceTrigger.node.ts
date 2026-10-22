import { createHmac, timingSafeEqual } from 'node:crypto';
import {
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
	type JsonObject,
	NodeApiError,
	NodeConnectionTypes,
} from 'n8n-workflow';

import { buildOnceApiRequest } from './GenericFunctions';

/** The test event buildonce.app sends from "Send test event". */
const TEST_EVENT = 'webhook.test';

/** A delivery older than this is refused, so a captured request can't be replayed later. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Checks `BuildOnce-Signature: t=<unix>,v1=<hex>`, where v1 is
 * HMAC-SHA256(secret, `${t}.${body}`) over the exact bytes received.
 */
function isValidSignature(header: string | undefined, rawBody: Buffer, secret: string): boolean {
	if (!header) return false;
	const parts = new Map(
		header.split(',').map((part) => {
			const [key, ...rest] = part.trim().split('=');
			return [key, rest.join('=')] as const;
		}),
	);
	const timestamp = Number(parts.get('t'));
	const signature = parts.get('v1') ?? '';
	if (!Number.isFinite(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return false;
	if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

	const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
	return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/**
 * For requests about an endpoint someone may already have deleted in
 * buildonce.app: a 404 resolves to null, anything else still fails. The
 * helper wraps every API error in a NodeApiError, so that is what rejects.
 */
async function unlessNotFound(request: Promise<JsonObject>): Promise<JsonObject | null> {
	return await request.catch((error: NodeApiError) => {
		if (error.httpCode === '404') return null;
		throw error;
	});
}

function sameEvents(a: unknown, b: string[]): boolean {
	if (!Array.isArray(a) || a.length !== b.length) return false;
	const wanted = new Set(b);
	return a.every((event) => wanted.has(event as string));
}

export class BuildOnceTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'buildonce.app Trigger',
		name: 'buildOnceTrigger',
		icon: { light: 'file:buildonce.svg', dark: 'file:buildonce.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			'Starts the workflow when renders, templates, social posts or credits change in buildonce.app',
		defaults: { name: 'buildonce.app Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'buildOnceApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'buildonce.app must be able to reach this n8n over public HTTPS. Each active trigger uses one of the workspace’s 10 webhook endpoints.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: [],
				description: 'The events that start this workflow',
				options: [
					{
						name: 'Credits Running Low',
						value: 'credits.low',
						description: '80% of the plan’s credits used',
					},
					{
						name: 'Credits Used Up',
						value: 'credits.exhausted',
						description: '100% of the plan’s credits used',
					},
					{ name: 'Post Failed', value: 'post.failed' },
					{ name: 'Post Published', value: 'post.published' },
					{ name: 'Post Scheduled', value: 'post.scheduled' },
					{ name: 'Render Completed', value: 'render.completed' },
					{
						name: 'Render Edited',
						value: 'render.edited',
						description: 'A render was edited and saved in the embedded editor',
					},
					{ name: 'Render Failed', value: 'render.failed' },
					{ name: 'Template Created', value: 'template.created' },
					{ name: 'Template Deleted', value: 'template.deleted' },
					{ name: 'Template Updated', value: 'template.updated' },
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Include Test Events',
						name: 'includeTestEvents',
						type: 'boolean',
						default: false,
						description:
							'Whether "Send test event" in buildonce.app (event `webhook.test`) also starts the workflow',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			// Runs when the workflow is activated (n8n does not re-check on restart):
			// keep the endpoint registered earlier only if it still exists with this
			// URL and these events. Anything else (deleted in buildonce.app, events
			// changed, turned off) is cleaned up and created again.
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				const endpointId = data.endpointId as string | undefined;
				if (!endpointId || !data.secret) return false;

				const endpoint = await unlessNotFound(
					buildOnceApiRequest.call(this, 'GET', `/v1/webhooks/${endpointId}`),
				);
				if (!endpoint) {
					delete data.endpointId;
					delete data.secret;
					return false;
				}

				const events = this.getNodeParameter('events') as string[];
				if (
					endpoint.url === this.getNodeWebhookUrl('default') &&
					sameEvents(endpoint.events, events) &&
					endpoint.enabled !== false
				) {
					return true;
				}
				await unlessNotFound(
					buildOnceApiRequest.call(this, 'DELETE', `/v1/webhooks/${endpointId}`),
				);
				delete data.endpointId;
				delete data.secret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const events = this.getNodeParameter('events') as string[];
				const endpoint = await buildOnceApiRequest.call(this, 'POST', '/v1/webhooks', {
					url: this.getNodeWebhookUrl('default') as string,
					events,
					description: `n8n: ${this.getWorkflow().name ?? this.getWorkflow().id}`.slice(0, 200),
				});
				if (!endpoint.id || !endpoint.secret) return false;
				// The signing secret is only ever shown in this response.
				const data = this.getWorkflowStaticData('node');
				data.endpointId = endpoint.id;
				data.secret = endpoint.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				const endpointId = data.endpointId as string | undefined;
				if (endpointId) {
					await unlessNotFound(
						buildOnceApiRequest.call(this, 'DELETE', `/v1/webhooks/${endpointId}`),
					);
				}
				delete data.endpointId;
				delete data.secret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const response = this.getResponseObject();
		const secret = this.getWorkflowStaticData('node').secret as string | undefined;
		const headers = this.getHeaderData();
		const signature = headers['buildonce-signature'] as string | undefined;

		if (!secret || !isValidSignature(signature, request.rawBody, secret)) {
			response.status(401).send('Invalid signature');
			return { noWebhookResponse: true };
		}

		const body = this.getBodyData();
		const event = body.type as string;
		const events = this.getNodeParameter('events') as string[];
		const { includeTestEvents } = this.getNodeParameter('options', {}) as {
			includeTestEvents?: boolean;
		};
		const wanted = events.includes(event) || (event === TEST_EVENT && includeTestEvents === true);
		if (!wanted) {
			// Acknowledge it so buildonce.app doesn't retry, but don't start the workflow.
			return { webhookResponse: 'ignored', workflowData: undefined };
		}

		const item: IDataObject = {
			...body,
			deliveryId: headers['buildonce-delivery-id'] ?? null,
		};
		return { workflowData: [this.helpers.returnJsonArray(item)] };
	}
}
