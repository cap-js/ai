import cds from '@sap/cds';
import { getProperty } from '../lib/handlers/utils.js';
const LOG = cds.log('@cap-js/ai');

const CDS_TO_PYTHON_DTYPE = {
	'cds.String': 'string',
	'cds.LargeString': 'string',
	'cds.UUID': 'string',
	'cds.Integer': 'numeric',
	'cds.Integer64': 'numeric',
	'cds.Int16': 'numeric',
	'cds.Int32': 'numeric',
	'cds.Int64': 'numeric',
	'cds.UInt8': 'numeric',
	'cds.Decimal': 'numeric',
	'cds.Double': 'numeric',
	'cds.Boolean': 'bool',
	'cds.Date': 'date',
	'cds.Time': 'string',
	'cds.DateTime': 'datetime',
	'cds.Timestamp': 'datetime'
};

function cdsToPythonDtype(cdsType) {
	return CDS_TO_PYTHON_DTYPE[cdsType];
}

export default class AICore extends cds.ApplicationService {
	init() {
		this.on('fetchPredictions', this._fetchPrediction);
		this.on('predictRowColumns', this._predictRowColumns);

		this.on('*', 'resourceGroups', this.handleResourceGroups);
		this.on('rpt1DeploymentId', 'resourceGroups', this.rpt1ForResourceGroup);
		this.on('*', 'deployments', this.handleDeployments);
		this.on('*', 'configurations', this.handleConfigurations);

		this.on('resourceGroupForTenant', this.handleResourceGroupsForTenant);
		return super.init();
	}

	/**
	 * Because AI Core is not tenant specific, the token is cached in this.token. Based on this.expiration_date
	 * the function will return the existing token or generate a new one for AI Core.
	 * @returns OAuth Token
	 */
	async _getToken() {
		if (this.token && this.expiration_date.toISOString() > new Date().toISOString()) {
			return this.token;
		}
		const aiCore = cds.env.requires['AICore'];
		const response = await fetch(`${aiCore.credentials.url}/oauth/token`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				client_id: aiCore.credentials.clientid,
				client_secret: aiCore.credentials.clientsecret,
				grant_type: 'client_credentials'
			})
		});
		const data = await response.json();
		this.expiration_date = new Date();
		this.expiration_date.setSeconds(this.expiration_date.getSeconds() + data.expires_in);
		this.token = data.access_token;
		return data.access_token;
	}

	async _fetchPrediction(req) {
		const { rows, entity: entityName, predictionColumns } = req.data;
		const entity = (cds.context?.model ?? cds.model).definitions[entityName];
		const dataSchema = entity
			? Object.keys(entity.elements).reduce((acc, ele) => {
					if (rows[0][ele] !== undefined) {
						const dtype = cdsToPythonDtype(entity.elements[ele].type);
						if (dtype) acc[ele] = { dtype };
					}
					return acc;
				}, {})
			: undefined;
		if (dataSchema && rows[0].SAP_RECOMMENDATIONS_ID) {
			dataSchema['SAP_RECOMMENDATIONS_ID'] = { dtype: 'string' };
		}
		const response = await this._predictRowColumns({
			data: {
				data_schema: dataSchema,
				prediction_config: {
					target_columns: predictionColumns.map((c) => ({
						name: c,
						prediction_placeholder: '[PREDICT]',
						task_type: 'classification'
					}))
				},
				// SAP_RECOMMENDATIONS_ID is generated in case the entity has composed keys or a key not named ID
				index_column: rows[0]['SAP_RECOMMENDATIONS_ID'] ? 'SAP_RECOMMENDATIONS_ID' : 'ID',
				rows
			}
		});
		return response;
	}

	async _predictRowColumns(req) {
		const token = await this._getToken();
		const aiCore = cds.env.requires.AICore
		const resourceGroup = cds.env.requires.multitenancy
			? await this.resourceGroupForTenant({ tenant: cds.context.tenant })
			: cds.env.requires['AICore']?.resourceGroup;
		const deploymentID = await this.rpt1DeploymentId(this.entities.resourceGroups, resourceGroup);
		LOG.debug(
			`Fetching predictions from ${aiCore.credentials.serviceurls.AI_API_URL} for deployment ${deploymentID} and resource group ${resourceGroup}`
		);
		const response = await fetch(
			`${aiCore.credentials.serviceurls.AI_API_URL}/v2/inference/deployments/${deploymentID}/predict`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'AI-Resource-Group': resourceGroup
				},
				body: JSON.stringify(req.data)
			}
		);
		if (response.ok) {
			return response.json();
		} else {
			LOG.error(
				'Error when fetching predictions: ',
				response.status,
				response.headers.get('content-type').match('json')
					? JSON.stringify(await response.json())
					: response.status
			);
			return {};
		}
	}

	//
	// AI Core Resource group handling
	//

	async handleResourceGroups(req, next) {
		const token = await this._getToken();
		const aiCore = cds.env.requires.AICore
		let response;
		if (req.event === 'CREATE') {
			if (!req.data.resourceGroupId) {
				req.data.resourceGroupId = cds.utils.uuid();
			}
			// REVISIT: map req.data.tenantId to the CDS_TENANT_ID?!
			if (
				!req.data.labels ||
				!req.data.labels.some((l) => l.key === 'ext.ai.sap.com/CDS_TENANT_ID')
			) {
				req.data.labels ??= [];
				req.data.labels.push({
					key: 'ext.ai.sap.com/CDS_TENANT_ID',
					value: cds.context.tenant
				});
			}
			response = await fetch(
				`${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						resourceGroupId: req.data.resourceGroupId,
						labels: req.data.labels
					})
				}
			);
		} else if (req.event === 'DELETE') {
			const where = req.query.DELETE.from.ref.at(-1)?.where || req.query.DELETE.where;
			let resourceGroupId = getProperty(where, 'resourceGroupId');
			if (!resourceGroupId) {
				const tenantId = getProperty(where, 'tenantId');
				const resourceGroup = await this.run(
					SELECT.one.from('AICore.resourceGroups').where({ tenantId })
				);
				resourceGroupId = resourceGroup.resourceGroupId;
			}
			response = await fetch(
				`${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups/${resourceGroupId}`,
				{
					method: 'DELETE',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json'
					}
				}
			);
		} else if (req.event === 'READ') {
			const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where;
			let resourceGroupId = getProperty(where, 'resourceGroupId');
			if (resourceGroupId) {
				response = await fetch(
					`${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups/${resourceGroupId}`,
					{
						method: 'GET',
						headers: {
							Authorization: `Bearer ${token}`,
							'Content-Type': 'application/json'
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
				let tenantId = getProperty(where, 'tenantId');
				if (tenantId) {
					queryOptions.push(`labelSelector=ext.ai.sap.com/CDS_TENANT_ID=${tenantId}`);
				}
				// TODO: support labelSelector for where clause (e.g. exists on labels)
				let url = `${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups`;
				if (queryOptions.length) {
					url += `?${queryOptions.join('&')}`;
				}
				response = await fetch(url, {
					method: 'GET',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json'
					}
				});
			}
		} else if (req.event === 'UPSERT') {
			let resourceGroupId = getProperty(req.query.UPSERT.entries, 'resourceGroupId');
			if (resourceGroupId) {
				const resourceGroup = await this.run(SELECT.from('AICore.resourceGroups', resourceGroupId));
				if (resourceGroup) {
					return await this.run(
						UPDATE.entity('AICore.resourceGroups', resourceGroupId).with(req.data)
					);
				} else {
					return await this.run(INSERT.into('AICore.resourceGroups').entries(req.data));
				}
			} else {
				return await this.run(INSERT.into('AICore.resourceGroups').entries(req.data));
			}
		} else if (req.event === 'UPDATE') {
			const where = req.query.UPDATE.entity.ref.at(-1)?.where || req.query.UPDATE.where;
			let resourceGroupId = getProperty(where, 'resourceGroupId');
			if (!resourceGroupId) {
				const tenantId = getProperty(where, 'tenantId');
				const resourceGroup = await this.run(
					SELECT.one.from('AICore.resourceGroups').where({ tenantId })
				);
				resourceGroupId = resourceGroup.resourceGroupId;
			}
			response = await fetch(
				`${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups/${resourceGroupId}`,
				{
					method: 'PATCH',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(req.data)
				}
			);
		} else {
			return next();
		}

		if (response.ok) {
			let res = await response.json();
			if (res.resources) {
				res.resources['$odata.count'] = res.count;
				res = res.resources;
			}
			if (req.query.SELECT?.one) {
				res = Array.isArray(res) ? res[0] : res;
			}
			return res;
		} else {
			LOG.error(
				'Error when requesting resourceGroups from AI Core for tenant: ',
				cds.context.tenant,
				req.event,
				req.query,
				response.headers.get('content-type').match('json')
					? JSON.stringify(await response.json())
					: response.status
			);
			return {};
		}
	}

	tenantResourceGroups = new Map();

	async handleResourceGroupsForTenant(req) {
		// Early return if multi tenancy is disabled
		if (!cds.env.requires.multitenancy && !cds.env.profiles.includes('mtx-sidecar'))
			return cds.env.requires['AICore']?.resourceGroup;

		const tenantId = req.data.tenant;
		if (this.tenantResourceGroups.get(tenantId)) {
			return this.tenantResourceGroups.get(tenantId);
		}
		const resources = await this.run(SELECT.from('AICore.resourceGroups').where({ tenantId }));
		if (resources.length) {
			this.tenantResourceGroups.set(tenantId, resources[0].resourceGroupId);
			return resources[0].resourceGroupId;
		} else {
			const { resourceGroupId } = await this.run(
				INSERT.into('AICore.resourceGroups').entries({ tenantId })
			);
			return resourceGroupId;
		}
	}

	async handleDeployments(req, next) {
		const token = await this._getToken();
		const aiCore = cds.env.requires.AICore
		let response;
		if (req.event === 'UPSERT') {
			const where = req.query.UPSERT.entity.ref.at(-1)?.where || req.query.UPSERT.where || [];
			const resourceGroupId =
				getProperty(where, 'resourceGroup') ??
				(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
			let deploymentId = getProperty(where, 'id') ?? req.data.id;
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
		} else if (req.event === 'CREATE') {
			const resourceGroupId = await this.resourceGroupForTenant({ tenant: cds.context.tenant });
			response = await fetch(`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/deployments`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'AI-Resource-Group': resourceGroupId
				},
				body: JSON.stringify(req.data)
			});
		} else if (req.event === 'READ') {
			const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where;
			const resourceGroupId =
				getProperty(where, 'resourceGroup') ??
				(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
			let deploymentId = getProperty(where, 'id');
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
		} else if (req.event === 'UPDATE' || req.event === 'stop') {
			if (req.event === 'stop') {
				req.data = {
					targetStatus: 'STOPPED'
				};
				req.query = {
					UPDATE: {
						entity: { ref: [req.target.name] },
						where: [{ ref: ['id'] }, '=', { val: req.params[0].id }]
					}
				};
			}
			const where = req.query.UPDATE.entity.ref.at(-1)?.where || req.query.UPDATE.where;
			const resourceGroupId =
				getProperty(where, 'resourceGroup') ??
				(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
			let deploymentId = getProperty(where, 'id');
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
		} else if (req.event === 'DELETE') {
			const where = req.query.DELETE.from.ref.at(-1)?.where || req.query.DELETE.where;
			const resourceGroupId =
				getProperty(where, 'resourceGroup') ??
				(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
			let deploymentId = getProperty(where, 'id');
			response = await fetch(
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
		} else {
			return next();
		}

		if (response.ok) {
			let res = await response.json();
			if (res.resources) {
				res.resources['$odata.count'] = res.count;
				res = res.resources;
			}
			if (req.query.SELECT?.one) {
				res = Array.isArray(res) ? res[0] : res;
			}
			return res;
		} else {
			LOG.error(
				'Error when requesting deployments from AI Core for tenant: ',
				cds.context.tenant,
				req.event,
				req.query,
				response.headers.get('content-type').match('json')
					? JSON.stringify(await response.json())
					: response.status
			);
			return {};
		}
	}

	async handleConfigurations(req, next) {
		const token = await this._getToken();
		const aiCore = cds.env.requires.AICore
		let response;
		if (req.event === 'READ') {
			const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where;
			const resourceGroupId =
				getProperty(where, 'resourceGroup') ??
				(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
			let deploymentId = getProperty(where, 'id');
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
		} else if (req.event === 'CREATE') {
			const resourceGroupId = await this.resourceGroupForTenant({ tenant: cds.context.tenant });
			response = await fetch(`${aiCore.credentials.serviceurls.AI_API_URL}/v2/lm/configurations`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'AI-Resource-Group': resourceGroupId
				},
				body: JSON.stringify(req.data)
			});
		} else {
			return next();
		}

		if (response.ok) {
			let res = await response.json();
			if (res.resources) {
				res.resources['$odata.count'] = res.count;
				res = res.resources;
			}
			if (req.query.SELECT?.one) {
				res = Array.isArray(res) ? res[0] : res;
			}
			return res;
		} else {
			const body = JSON.stringify(await response.json());
			LOG.error(
				'Error when requesting configurations from AI Core for tenant: ',
				cds.context.tenant,
				req.event,
				req.query,
				response.headers.get('content-type').match('json') ? body : response.status
			);
			return response.headers.get('content-type').match('json') ? body : response.status;
		}
	}

	resourceRPTMappings = new Map();

	async rpt1ForResourceGroup(req) {
		const resourceGroupId =
			req.params[0].resourceGroupId ??
			(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
		if (this.resourceRPTMappings.get(resourceGroupId)) {
			return this.resourceRPTMappings.get(resourceGroupId);
		}
		const deployments = await this.run(
			SELECT.from('AICore.deployments').where({ 'resourceGroup.resourceGroupId': resourceGroupId })
		);
		let deployment = deployments?.find((r) => r.configurationName.match(/rpt-1/));
		if (!deployment || (deployment.status !== 'RUNNING' && deployment.status !== 'PENDING')) {
			// Create RPT-1 deployment on demand if the resource group is missing it
			const configurations = await this.run(
				SELECT.from('AICore.configurations')
					.where({ 'resourceGroup.resourceGroupId': resourceGroupId })
					.search('rpt-1')
			);
			let configuration = configurations[0];
			if (!configuration) {
				configuration = await this.run(
					INSERT.into('AICore.configurations').entries({
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
				INSERT.into('AICore.deployments').entries({ configurationId: configuration.id })
			);
			// Poll until the deployment reaches RUNNING status
			for (let i = 0; i < 10 && deployment.status !== 'RUNNING'; i++) {
				const delay = 300 * Math.pow(2, i);
				LOG.debug(
					`Waiting for RPT-1 deployment ${deployment.id} to reach RUNNING (current: ${deployment.status}, retry ${i + 1}/5, next in ${delay}ms)`
				);
				// eslint-disable-next-line no-await-in-loop
				await new Promise((resolve) => setTimeout(resolve, delay));
				// eslint-disable-next-line no-await-in-loop
				const getDeployment = await this.run(
					SELECT.one
						.from('AICore.deployments')
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

	resourceOrchestrationMappings = new Map();

	async orchestrationForResourceGroup(req) {
		const resourceGroupId =
			req.params[0].resourceGroupId ??
			(await this.resourceGroupForTenant({ tenant: cds.context.tenant }));
		if (this.resourceOrchestrationMappings.get(resourceGroupId)) {
			return this.resourceOrchestrationMappings.get(resourceGroupId);
		}
		const resources = await this.run(
			SELECT.from('AICore.deployments').where({ 'resourceGroup.resourceGroupId': resourceGroupId })
		);
		let deployment = resources.find((r) => r.configurationName.match(/orchestration/));
		if (!deployment || (deployment.status !== 'RUNNING' && deployment.status !== 'PENDING')) {
			// Create RPT-1 deployment on demand if the resource group is missing it
			const resources = await this.run(
				SELECT.from('AICore.configurations')
					.where({ 'resourceGroup.resourceGroupId': resourceGroupId })
					.search('orchestration')
			);
			const configuration = resources[0];
			deployment = await this.run(
				INSERT.into('AICore.deployments').entries({ configurationId: configuration.id })
			);
		}
		this.resourceOrchestrationMappings.set(resourceGroupId, deployment.id);
		return deployment.id;
	}
}
