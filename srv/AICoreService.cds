@impl: './AICoreService.js'
@protocol: 'none'
service AICore {

  @cds.persistence.skip
  entity resourceGroups {
        @description: 'resource group id'
        @mandatory: true
    key resourceGroupId : String;

        @description: 'tenant id'
        tenantId        : String;

        @description: 'zone id'
        zoneId          : String;

        @description: 'Timestamp of resource group creation'
        @mandatory: true
        createdAt       : Timestamp;
        labels          : BckndResourceGroupLabels;

        @description: 'aggregated status of the onboarding process'
        @assert.range: true
        @mandatory: true
        status          : String enum {
          PROVISIONED;
          ERROR;
          PROVISIONING;
        };

        @description: 'status message'
        statusMessage   : String;

        @description: 'service plan'
        servicePlan     : String;
  } actions {
    /**
     * Returns the resource group If no RPT-1 deployment exists, creates one for the
     * resource group
     */
    function rpt1DeploymentId() returns String;
  }

  @description: 'Detailed data about a deployment'
  @cds.persistence.skip
  entity deployments {
        @description: 'ID of the deployment'
        @assert.format: '^[\w.-]{4,64}$'
    key id                           : String;
        deploymentUrl                : String;

        @mandatory: true
        @description: 'ID of the configuration'
        @assert.format: '^[\w.-]{4,64}$'
        configurationId              : String;

        @assert.format: '^[\w\s.!?,;:\[\](){}<>"''=+*/\\^&%@~$#|-]*$'
        configurationName            : String(256);

        @description: 'ID of the executable'
        @assert.format: '^[\w.-]{4,64}$'
        executableId                 : String;

        @description: 'ID of the scenario'
        @assert.format: '^[\w.-]{4,64}$'
        scenarioId                   : String;

        status                       : String enum {
          PENDING;
          RUNNING;
          COMPLETED;
          DEAD;
          STOPPING;
          STOPPED;
          UNKNOWN;
        };

        statusMessage                : String(256);

        @description: 'Deployment target status'
        @assert.range: true
        targetStatus                 : String enum {
          running;
          STOPPED;
          deleted;
        };

        @description: 'Last operation applied to this deployment.'
        lastOperation                : String;

        @description: 'configurationId that was running before a PATCH operation has modified the configurationId of the deployment. This can be used for a manual rollback in case the new configurationId results in a DEAD deployment'
        @assert.format: '^[\w.-]{4,64}$'
        @Core.Example.$Type: 'Core.PrimitiveExampleValue'
        @Core.Example.Value: 'aa97b177-9383-4934-8543-0f91a7a0283a'
        latestRunningConfigurationId : String;

        @description: 'Time to live for a deployment. Its value can be either null or a number followed by the unit (any of following values, minutes(m|M), hours(h|H) or days(d|D))'
        @assert.format: '^[0-9]+[m,M,h,H,d,D]$'
        ttl                          : String;
        details                      : AiDeploymentDetails;

        @description: 'Timestamp of resource creation'
        createdAt                    : Timestamp;

        @description: 'Timestamp of latest resource modification'
        modifiedAt                   : Timestamp;

        @description: 'Timestamp of job submitted'
        submissionTime               : Timestamp;

        @description: 'Timestamp of job status changed to RUNNING'
        startTime                    : Timestamp;

        @description: 'Timestamp of job status changed to COMPLETED/DEAD/STOPPED'
        completionTime               : Timestamp;

        // So that where clauses can be properly expressed
        resourceGroup                : Association to one resourceGroups
                                         on 1 = 1;
  } actions {
    action stop();
  };

  @cds.persistence.skip
  entity configurations {
        @mandatory: true
        @description: 'Name of the configuration'
        @assert.format: '^[\w\s.!?,;:\[\](){}<>"''=+*/\\^&%@~$#|-]*$'
        name                  : String(256);

        @mandatory: true
        @description: 'ID of the executable'
        @assert.format: '^[\w.-]{4,64}$'
        executableId          : String;

        @mandatory: true
        @description: 'ID of the scenario'
        @assert.format: '^[\w.-]{4,64}$'
        scenarioId            : String;
        parameterBindings     : ParameterArgumentBindingList;
        inputArtifactBindings : ArtifactArgumentBindingList;

        @description: 'ID of the configuration'
        @assert.format: '^[\w.-]{4,64}$'
    key id                    : String;

        @description: 'Timestamp of resource creation'
        createdAt             : Timestamp;

        @openapi.anyOf: '[{"$ref":"#/components/schemas/AiScenario"},{}]'
        @open: true
        scenario              : {};

        // So that where clauses can be properly expressed
        resourceGroup         : Association to one resourceGroups
                                  on 1 = 1;
  };

  action   fetchPredictions(predictionColumns: array of String,
                            @description: 'CDS Entity name used for the data schema parameter for RPT-1'
                            entity: String,
                            @open
                            rows: array of Map, );

  action   predictRowColumns(prediction_config: {
    target_columns : array of {
      name                   : String;
      prediction_placeholder : String;
      task_type              : String enum {
        classification = 'classification'
      }
    }
  },
                             index_column: String,
                             @open
                             rows: array of Map, );

  /**
   * Returns a resource group ID for a CDS tenant ID
   */
  function resourceGroupForTenant(tenant: String) returns String;

  @description: 'Arbitrary labels as meta information'
  type BckndResourceGroupLabels     : many BckndResourceGroupLabel;

  type BckndResourceGroupLabel {
    @assert.format: '^ext.ai.sap.com/(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]){1,48}$'
    @Core.Example.$Type: 'Core.PrimitiveExampleValue'
    @Core.Example.Value: 'ext.ai.sap.com/my-label'
    @mandatory: true
    ![key] : String(63);

    @mandatory: true
    value  : String(5000);
  };

  @description: 'backend-specific details of the deployment'
  type AiBackendDetails {};

  @description: 'Scaling details of a deployment'
  type AiScalingDetails {
    backendDetails : AiBackendDetails;
  };

  @description: 'Resources details of a deployment'
  type AiResourcesDetails {
    backendDetails : AiBackendDetails;
  };

  @description: `Detail information about a deployment (including predefined sections: \`scaling\` and \`resources\`).
JSON String representation of this object is limited to 5000 characters
`
  type AiDeploymentDetails {
    scaling   : AiScalingDetails;
    resources : AiResourcesDetails;
  };

  @description: `Required for execution
Result of activation
`
  type ParameterArgumentBinding {
    @mandatory: true
    ![key] : String(256);

    @mandatory: true
    value  : String(5000);
  };

  type ParameterArgumentBindingList : many ParameterArgumentBinding;

  @description: `Required for execution
Result of activation
`
  type ArtifactArgumentBinding {
    @mandatory: true
    ![key]     : String(256);

    @mandatory: true
    @description: 'ID of the artifact'
    @assert.format: '^[\w.-]{4,64}$'
    artifactId : String;
  };

  type ArtifactArgumentBindingList  : many ArtifactArgumentBinding;

}
