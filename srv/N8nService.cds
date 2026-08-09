/**
 * N8nService – CAP-native workflow execution engine.
 *
 * The n8n UI is used as a visual designer only; CAP owns execution entirely.
 * Workflow definitions (nodes + connections JSON) are stored in
 * cap.ai.n8n.WorkflowDefinitions and executed in-process via cds.emit.
 *
 * Entities live in db/n8n.cds under the cap.ai.n8n namespace.
 */

@impl: './N8nService.js'
@n8n: '/n8n'
service n8n {

  action triggerWorkflow(
    workflowId      : String,
    data            : LargeString,   // JSON input
    destinationNode : String,        // optional: stop execution after this node
    destinationMode : String,        // optional: 'inclusive' (run dest node) or 'exclusive' (stop before)
    startNodeIds    : LargeString,   // optional: JSON array of node IDs to start from
    pinData         : LargeString,   // optional: JSON { nodeName: [items] } overrides stored pin data
    runData         : LargeString    // optional: JSON { nodeName: [taskData] } cached outputs for partial runs
  ) returns {
    executionId : UUID;
    status      : String;
  };

  action stopExecution(id : UUID) returns {
    id     : UUID;
    status : String;
  };

  // Await completion of a running execution. Returns when execution finishes or times out.
  // Used by the chat trigger HTTP route to get synchronous output.
  action awaitExecution(
    id        : UUID,
    timeoutMs : Integer  // default 30000
  ) returns LargeString; // JSON { status, nodeOutputs }

  // Internal: fired on an interval to clean up stale executions.
  // Goes through the CAP event queue so it only fires once in scale-out.
  action cleanupStaleExecutions() returns { cleaned: Integer };

  function getExecution(id : UUID) returns {
    id           : UUID;
    status       : String;
    outputData   : LargeString;
    error        : LargeString;
    finishedAt   : Timestamp;
  };
}
