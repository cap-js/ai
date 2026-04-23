// REVISIT: Is that model required at runtime at all?
// If not, we should move it to a separate file that is only used for compilation tasks.

@impl: './AICoreService.js'
@protocol: 'none'
service AICore {

  @cds.persistence.skip
  entity resourceGroups {
        /**
         * resource group id
         */
    key resourceGroupId : String;

        /**
         * tenant id
         */
        tenantId        : String;

        /**
         * zone id
         */
        zoneId          : String;

        /**
         * Timestamp of resource group creation
         */
        @readonly
        createdAt       : Timestamp;
        labels          : BckndResourceGroupLabels;

        /**
         * aggregated status of the onboarding process
         */
        @assert.range: true
        @readonly
        status          : String enum {
          PROVISIONED;
          ERROR;
          PROVISIONING;
        };

        /**
         * status message
         */
        statusMessage   : String;

        /**
         * service plan
         */
        servicePlan     : String;
  } actions {
    /**
     * Returns the deployment ID for RPT-1. If no RPT-1 deployment exists, creates one
     * for the resource group
     */
    function rpt1DeploymentId() returns String;
  }

  /**
   * Detailed data about a deployment
   */
  @cds.persistence.skip
  entity deployments {
        /**
         * ID of the deployment
         */
        @assert.format: '^[\w.-]{4,64}$'
    key id                           : String;
        deploymentUrl                : String;

        /**
         * ID of the configuration
         */
        @mandatory: true
        @assert.format: '^[\w.-]{4,64}$'
        configurationId              : String;

        @assert.format: '^[\w\s.!?,;:\[\](){}<>"''=+*/\\^&%@~$#|-]*$'
        configurationName            : String(256);

        /**
         * ID of the executable
         */
        @assert.format: '^[\w.-]{4,64}$'
        executableId                 : String;

        /**
         * ID of the scenario
         */
        @assert.format: '^[\w.-]{4,64}$'
        scenarioId                   : String;

        @readonly
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

        /**
         * Deployment target status
         */
        @assert.range: true
        targetStatus                 : String enum {
          running;
          STOPPED;
          deleted;
        };

        /**
         * Last operation applied to this deployment.
         */
        lastOperation                : String;

        /**
         * configurationId that was running before a PATCH operation has modified the
         * configurationId of the deployment. This can be used for a manual rollback in
         * case the new configurationId results in a DEAD deployment
         */
        @assert.format: '^[\w.-]{4,64}$'
        @Core.Example.$Type: 'Core.PrimitiveExampleValue'
        @Core.Example.Value: 'aa97b177-9383-4934-8543-0f91a7a0283a'
        latestRunningConfigurationId : String;

        /**
         * Time to live for a deployment. Its value can be either null or a number followed
         * by the unit (any of following values, minutes(m|M), hours(h|H) or days(d|D))
         */
        @assert.format: '^[0-9]+[m,M,h,H,d,D]$'
        ttl                          : String;
        details                      : AiDeploymentDetails;

        /**
         * Timestamp of resource creation
         */
        @readonly
        createdAt                    : Timestamp;

        /**
         * Timestamp of latest resource modification
         */
        modifiedAt                   : Timestamp;

        /**
         * Timestamp of job submitted
         */
        submissionTime               : Timestamp;

        /**
         * Timestamp of job status changed to RUNNING
         */
        startTime                    : Timestamp;

        /**
         * Timestamp of job status changed to COMPLETED/DEAD/STOPPED
         */
        completionTime               : Timestamp;

        // So that where clauses can be properly expressed
        resourceGroup                : Association to one resourceGroups
                                         on 1 = 1;
  } actions {
    action stop();
  };

  @cds.persistence.skip
  entity configurations {
        /**
         * Name of the configuration
         */
        @mandatory: true
        @assert.format: '^[\w\s.!?,;:\[\](){}<>"''=+*/\\^&%@~$#|-]*$'
        name                  : String(256);

        /**
         * ID of the executable
         */
        @mandatory: true
        @assert.format: '^[\w.-]{4,64}$'
        executableId          : String;

        /**
         * ID of the scenario
         */
        @mandatory: true
        @assert.format: '^[\w.-]{4,64}$'
        scenarioId            : String;
        parameterBindings     : ParameterArgumentBindingList;
        inputArtifactBindings : ArtifactArgumentBindingList;

        /**
         * ID of the configuration
         */
        @assert.format: '^[\w.-]{4,64}$'
    key id                    : String;

        /**
         * Timestamp of resource creation
         */
        @readonly
        createdAt             : Timestamp;

        @openapi.anyOf: '[{"$ref":"#/components/schemas/AiScenario"},{}]'
        @open: true
        scenario              : {};

        // So that where clauses can be properly expressed
        resourceGroup         : Association to one resourceGroups
                                  on 1 = 1;
  };

  action   fetchPredictions(predictionColumns: array of String,
                            /**
                             * CDS Entity name used for the data schema parameter for RPT-1
                             */
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

  /**
   * Arbitrary labels as meta information
   */
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

  /**
   * backend-specific details of the deployment
   */
  type AiBackendDetails {};

  /**
   * Scaling details of a deployment
   */
  type AiScalingDetails {
    backendDetails : AiBackendDetails;
  };

  /**
   * Resources details of a deployment
   */
  type AiResourcesDetails {
    backendDetails : AiBackendDetails;
  };

  /**
   * Detail information about a deployment (including predefined sections: `scaling`
   * and `resources`). JSON String representation of this object is limited to 5000
   * characters
   */
  type AiDeploymentDetails {
    scaling   : AiScalingDetails;
    resources : AiResourcesDetails;
  };

  /**
   * Required for execution. Result of activation
   */

  type ParameterArgumentBinding {
    @mandatory: true
    ![key] : String(256);

    @mandatory: true
    value  : String(5000);
  };

  type ParameterArgumentBindingList : many ParameterArgumentBinding;

  /**
   * Required for execution. Result of activation
   */

  type ArtifactArgumentBinding {
    @mandatory: true
    ![key]     : String(256);

    /**
     * ID of the artifact
     */
    @mandatory: true
    @assert.format: '^[\w.-]{4,64}$'
    artifactId : String;
  };

  type ArtifactArgumentBindingList  : many ArtifactArgumentBinding;

}
