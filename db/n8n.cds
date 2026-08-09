namespace cap.ai.n8n;

entity WorkflowDefinitions {
  key ID           : String(36);
  name             : String(255);
  active           : Boolean default false;
  nodes            : LargeString;
  connections      : LargeString;
  settings         : LargeString;
  staticData       : LargeString;
  pinData          : LargeString;   // JSON: { "NodeName": [{json:{...}},...] }
  versionId        : UUID;
  versionCounter   : Integer default 1;
  createdAt        : Timestamp @cds.on.insert: $now;
  updatedAt        : Timestamp @cds.on.update: $now;
}

entity WorkflowExecutions {
  key ID        : UUID;
  workflow      : Association to WorkflowDefinitions;
  status        : String(20); // 'running' | 'success' | 'error' | 'waiting'
  startedAt     : Timestamp @cds.on.insert: $now;
  finishedAt    : Timestamp;
  mode          : String(20); // 'manual' | 'trigger' | 'message'
  data          : LargeString; // JSON: initial input data
  error         : LargeString; // JSON: error details if failed
}

entity WorkflowStepResults {
  key executionID : UUID;
  key nodeID      : String(100);
  key runIndex    : Integer default 0;
  executionIndex  : Integer;           // global step counter within this execution, for ordering
  status          : String(20); // 'success' | 'error' | 'waiting'
  output          : LargeString; // JSON: node output items
  executedAt      : Timestamp @cds.on.insert: $now;
  error           : LargeString;
}
