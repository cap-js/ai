import cds from '@sap/cds';
import { getProperty, parseResponse } from '../../lib/handlers/utils.js';

export async function readConfigurations(req) {
	const token = await this._getToken();
	const aiCore = cds.env.requires.AICore;
	const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where;
	const resourceGroupId =
		getProperty(where, 'resourceGroup') ??
		(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
	let deploymentId = getProperty(where, 'id');
	let response;
	if (deploymentId) {
		response = await fetch(
			`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/configurations/${deploymentId}`,
			{
				method: 'GET',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'AI-Resource-Group': resourceGroupId
				}
			}
		);
	} else {
		const queryOptions = [];
		if (req.query.SELECT.limit?.rows?.val) {
			queryOptions.push(`$top=${req.query.SELECT.limit.rows.val}`);
		}
		if (req.query.SELECT.limit?.offset?.val) {
			queryOptions.push(`$skip=${req.query.SELECT.limit.offset.val}`);
		}
		if (req.query.SELECT.search) {
			queryOptions.push(`$search=${req.query.SELECT.search[0].val}`);
		}
		// TODO: support other query options
		let url = `${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/configurations`;
		if (queryOptions.length) {
			url += `?${queryOptions.join('&')}`;
		}
		response = await fetch(url, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				'AI-Resource-Group': resourceGroupId
			}
		});
	}
	return parseResponse(req, response);
}

export async function createConfiguration(req) {
	const token = await this._getToken();
	const aiCore = cds.env.requires.AICore;
	const resourceGroupId = await this.resourceGroupForTenant({ tenant: cds.context.tenant });
	const response = await fetch(
		`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/configurations`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				'AI-Resource-Group': resourceGroupId
			},
			body: JSON.stringify(req.data)
		}
	);
	return parseResponse(req, response);
}
