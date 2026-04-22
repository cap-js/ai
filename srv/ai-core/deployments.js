import cds from '@sap/cds';
import { getProperty, parseResponse } from '../../lib/handlers/utils.js';
const LOG = cds.log('@cap-js/ai');

export async function createDeployment(req) {
	const token = await this._getToken();
	const aiCore = cds.env.requires.AICore;
	const resourceGroupId = await this.resourceGroupForTenant({ tenant: cds.context.tenant });
	const response = await fetch(`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/deployments`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			'AI-Resource-Group': resourceGroupId
		},
		body: JSON.stringify(req.data)
	});
	return parseResponse(req, response);
}

export async function readDeployments(req) {
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
			`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/deployments/${deploymentId}`,
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
		// TODO: support other query options
		let url = `${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/deployments`;
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

export async function upsertDeployment(req) {
	const token = await this._getToken();
	const aiCore = cds.env.requires.AICore;
	const where = req.query.UPSERT.entity.ref.at(-1)?.where || req.query.UPSERT.where || [];
	const resourceGroupId =
		getProperty(where, 'resourceGroup') ??
		(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
	let deploymentId = getProperty(where, 'id') ?? req.data.id;
	let response;
	if (deploymentId) {
		response = await fetch(
			`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/deployments/${deploymentId}`,
			{
				method: 'GET',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'AI-Resource-Group': resourceGroupId
				}
			}
		);
		if (response.ok) {
			response = await fetch(
				`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/deployments/${deploymentId}`,
				{
					method: 'PATCH',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
						'AI-Resource-Group': resourceGroupId
					},
					body: JSON.stringify(req.data)
				}
			);
		} else {
			response = null;
		}
	}
	if (!response) {
		response = await fetch(`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/deployments`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				'AI-Resource-Group': resourceGroupId
			},
			body: JSON.stringify(req.data)
		});
	}
	return parseResponse(req, response);
}

export async function updateDeployment(req) {
	const token = await this._getToken();
	const aiCore = cds.env.requires.AICore;
	const where = req.query.UPDATE.entity.ref.at(-1)?.where || req.query.UPDATE.where;
	const resourceGroupId =
		getProperty(where, 'resourceGroup') ??
		(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
	let deploymentId = getProperty(where, 'id');
	const response = await fetch(
		`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/deployments/${deploymentId}`,
		{
			method: 'PATCH',
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

export async function stopDeployment(req) {
	req.data = {
		targetStatus: 'STOPPED'
	};
	req.query = {
		UPDATE: {
			entity: { ref: [req.target.name] },
			where: [{ ref: ['id'] }, '=', { val: req.params[0].id }]
		}
	};
	return updateDeployment.call(this, req);
}

export async function deleteDeployment(req) {
	const token = await this._getToken();
	const aiCore = cds.env.requires.AICore;
	const where = req.query.DELETE.from.ref.at(-1)?.where || req.query.DELETE.where;
	const resourceGroupId =
		getProperty(where, 'resourceGroup') ??
		(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
	let deploymentId = getProperty(where, 'id');
	const response = await fetch(
		`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/deployments/${deploymentId}`,
		{
			method: 'DELETE',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				'AI-Resource-Group': resourceGroupId
			}
		}
	);
	return parseResponse(req, response);
}

export async function rpt1ForResourceGroup(req) {
	const { deployments, configurations } = this.entities;
	const resourceGroupId =
		req.params[0].resourceGroupId ??
		(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
	if (this.resourceRPTMappings.get(resourceGroupId)) {
		return this.resourceRPTMappings.get(resourceGroupId);
	}
	const deploymentsList = await this.run(
		SELECT.from(deployments).where({ 'resourceGroup.resourceGroupId': resourceGroupId })
	);
	let deployment = deploymentsList?.find((r) => r.configurationName.match(/rpt-1/));
	if (!deployment || (deployment.status !== 'RUNNING' && deployment.status !== 'PENDING')) {
		// Create RPT-1 deployment on demand if the resource group is missing it
		const configurationsList = await this.run(
			SELECT.from(configurations)
				.where({ 'resourceGroup.resourceGroupId': resourceGroupId })
				.search('rpt-1')
		);
		let configuration = configurationsList[0];
		if (!configuration) {
			configuration = await this.run(
				INSERT.into(configurations).entries({
					scenarioId: 'foundation-models',
					name: 'sap-rpt-1-small',
					executableId: 'aicore-sap',
					parameterBindings: [
						{ key: 'modelName', value: 'sap-rpt-1-small' },
						{ key: 'modelVersion', value: 'latest' }
					]
				})
			);
		}
		deployment = await this.run(
			INSERT.into(deployments).entries({ configurationId: configuration.id })
		);
		// Poll until the deployment reaches RUNNING status
		for (let i = 0; i < 10 && deployment.status !== 'RUNNING'; i++) {
			const delay = 300 * Math.pow(2, i);
			LOG.debug(
				`Waiting for RPT-1 deployment ${deployment.id} to reach RUNNING (current: ${deployment.status}, retry ${i + 1}/10, next in ${delay}ms)`
			);
			// eslint-disable-next-line no-await-in-loop
			await new Promise((resolve) => setTimeout(resolve, delay));
			// eslint-disable-next-line no-await-in-loop
			const getDeployment = await this.run(
				SELECT.one
					.from(deployments)
					.where({ 'resourceGroup.resourceGroupId': resourceGroupId, id: deployment.id })
			);
			if (getDeployment?.id) {
				deployment = getDeployment;
			}
		}
	}
	this.resourceRPTMappings.set(resourceGroupId, deployment.id);
	return deployment.id;
}

export async function orchestrationForResourceGroup(req) {
	const { deployments, configurations } = this.entities;
	const resourceGroupId =
		req.params[0].resourceGroupId ??
		(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
	if (this.resourceOrchestrationMappings.get(resourceGroupId)) {
		return this.resourceOrchestrationMappings.get(resourceGroupId);
	}
	const resources = await this.run(
		SELECT.from(deployments).where({ 'resourceGroup.resourceGroupId': resourceGroupId })
	);
	let deployment = resources.find((r) => r.configurationName.match(/orchestration/));
	if (!deployment || (deployment.status !== 'RUNNING' && deployment.status !== 'PENDING')) {
		// Create orchestration deployment on demand if the resource group is missing it
		const resources = await this.run(
			SELECT.from(configurations)
				.where({ 'resourceGroup.resourceGroupId': resourceGroupId })
				.search('orchestration')
		);
		const configuration = resources[0];
		deployment = await this.run(
			INSERT.into(deployments).entries({ configurationId: configuration.id })
		);
	}
	this.resourceOrchestrationMappings.set(resourceGroupId, deployment.id);
	return deployment.id;
}
