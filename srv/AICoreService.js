import cds from '@sap/cds';
import {
  createResourceGroup,
  readResourceGroups,
  upsertResourceGroup,
  updateResourceGroup,
  deleteResourceGroup,
  handleResourceGroupsForTenant
} from './ai-core/resourceGroups.js';
import {
  createDeployment,
  readDeployments,
  upsertDeployment,
  updateDeployment,
  stopDeployment,
  deleteDeployment,
  rpt1ForResourceGroup
} from './ai-core/deployments.js';
import { createConfiguration, readConfigurations } from './ai-core/configurations.js';

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

    this.on('CREATE', 'resourceGroups', createResourceGroup);
    this.on('READ', 'resourceGroups', readResourceGroups);
    this.on('UPSERT', 'resourceGroups', upsertResourceGroup);
    this.on('UPDATE', 'resourceGroups', updateResourceGroup);
    this.on('DELETE', 'resourceGroups', deleteResourceGroup);
    this.on('rpt1DeploymentId', 'resourceGroups', rpt1ForResourceGroup);

    this.on('CREATE', 'deployments', createDeployment);
    this.on('READ', 'deployments', readDeployments);
    this.on('UPSERT', 'deployments', upsertDeployment);
    this.on('UPDATE', 'deployments', updateDeployment);
    this.on('DELETE', 'deployments', deleteDeployment);
    this.on('stop', 'deployments', stopDeployment);

    this.on('CREATE', 'configurations', createConfiguration);
    this.on('READ', 'configurations', readConfigurations);

    this.on('resourceGroupForTenant', handleResourceGroupsForTenant);
    return super.init();
  }

  tenantResourceGroups = new Map();
  resourceRPTMappings = new Map();
  resourceOrchestrationMappings = new Map();

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
    const { resourceGroups } = this.entities;
    const token = await this._getToken();
    const aiCore = cds.env.requires.AICore;
    const resourceGroup = cds.env.requires.multitenancy
      ? await this.resourceGroupForTenant({ tenant: cds.context.tenant })
      : cds.env.requires['AICore']?.resourceGroup;
    const deploymentID = await this.rpt1DeploymentId(resourceGroups, resourceGroup);
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
}
