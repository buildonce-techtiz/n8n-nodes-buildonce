import {
	type IExecuteFunctions,
	type IHookFunctions,
	type IHttpRequestMethods,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type JsonObject,
	NodeApiError,
} from 'n8n-workflow';

/**
 * Every BuildOnce response is wrapped as `{ success: true, data }` (or
 * `{ success: false, code, message }` for errors, which never reaches here —
 * a non-2xx throws before this runs). Unwrap once, centrally, rather than at
 * every call site. Shared by the BuildOnce node and its trigger.
 */
export async function buildOnceApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: JsonObject = {},
	qs: JsonObject = {},
) {
	const credentials = await this.getCredentials('buildOnceApi');
	const options: IHttpRequestOptions = {
		method,
		qs,
		url: `${credentials.domain}${endpoint}`,
		json: true,
	};
	if (method === 'POST' || method === 'PATCH' || method === 'PUT') options.body = body;
	try {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'buildOnceApi',
			options,
		);
		return ((response as { data?: JsonObject } | undefined)?.data ?? {}) as JsonObject;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}
