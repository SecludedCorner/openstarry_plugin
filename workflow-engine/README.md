# @openstarry-plugin/workflow-engine

Declarative multi-step workflow orchestration plugin for OpenStarry (MVP).

## Features

- **YAML-based workflow definitions** with Zod schema validation
- **4 step types**: `tool`, `service`, `llm`, `command` (command not supported in MVP)
- **Sequential execution** (parallel execution deferred to v0.18.1)
- **Mustache-style variable interpolation** (`{{ inputs.foo }}`, `{{ steps.bar }}`)
- **EventBus observability** (lifecycle events for monitoring)
- **Multiple interfaces**: IPluginService, ITool (`workflow:execute`), SlashCommand (`/workflow`)

## Installation

```bash
pnpm add @openstarry-plugin/workflow-engine
```

## Usage

### Plugin Registration

```typescript
import { createWorkflowEnginePlugin } from "@openstarry-plugin/workflow-engine";

const plugin = createWorkflowEnginePlugin();
// Register with OpenStarry agent
```

### Workflow YAML Format

```yaml
name: "my-workflow"
version: "1.0.0"
description: "Optional description"

inputs:
  paramName:
    type: string|number|boolean|object|array
    required: true|false
    default: "optional default value"

steps:
  - name: "step-name"
    type: tool|service|llm|command
    # ... type-specific fields
    output: "optional-output-variable-name"

outputs:
  resultKey: "{{ steps.step-name }}"
```

### Step Types

#### Tool Step
Invokes a registered ITool.

```yaml
- name: "read-file"
  type: tool
  tool: "fs:read"
  arguments:
    path: "{{ inputs.filePath }}"
```

#### Service Step
Calls a plugin service method.

```yaml
- name: "parse-data"
  type: service
  service: "skill-parser"
  method: "parse"
  arguments:
    - "{{ steps.read-file }}"
    - "csv"
```

#### LLM Step
Direct LLM provider invocation.

```yaml
- name: "analyze"
  type: llm
  provider: "anthropic"
  prompt: "Analyze this: {{ steps.parse-data }}"
  model: "claude-opus-4-6"  # optional
  temperature: 0.5          # optional
  maxTokens: 1000           # optional
```

#### Command Step (NOT SUPPORTED in MVP)
Throws `CommandStepNotSupportedError`. Planned for v0.18.1.

```yaml
- name: "run-command"
  type: command
  command: "echo"
  args: "Hello"
```

### Variable Interpolation

Use Mustache-style `{{ }}` syntax:

- **Inputs**: `{{ inputs.paramName }}`
- **Step outputs**: `{{ steps.step-name }}`
- **Nested paths**: `{{ steps.parse-data.rows.0.name }}`

### Programmatic API (IWorkflowService)

```typescript
import type { IWorkflowService } from "@openstarry-plugin/workflow-engine";

// Get service from plugin context
const workflowService = ctx.services.get<IWorkflowService>("workflow-engine");

// Load workflow from file
const definition = await workflowService.load("./my-workflow.yaml");

// Execute workflow
const result = await workflowService.execute("./my-workflow.yaml", {
  paramName: "value",
});

// Check execution status
const status = workflowService.getStatus(result.executionId);

// List loaded workflows
const workflows = workflowService.list();
```

### Tool Interface

LLMs can invoke workflows using the `workflow:execute` tool:

```json
{
  "workflowPath": "./my-workflow.yaml",
  "inputs": {
    "paramName": "value"
  }
}
```

### Slash Command

```bash
/workflow ./my-workflow.yaml paramName=value threshold=10
```

## Events

Emitted via EventBus:

- `workflow:started` — Workflow execution begins
- `workflow:step_started` — Step starts
- `workflow:step_completed` — Step completes
- `workflow:step_failed` — Step fails
- `workflow:completed` — Workflow completes successfully
- `workflow:error` — Workflow fails

## MVP Limitations

- **Sequential execution only** — No parallel steps
- **No conditional branching** — No if/else logic
- **No loops** — No iteration
- **Ephemeral state** — No workflow persistence (in-memory cache only, LRU 100 entries)
- **No auto-discovery** — Workflows must be explicitly loaded
- **Command steps not supported** — Requires `ctx.commands` accessor (planned for v0.18.1)

## Error Handling

Custom error types:

- `WorkflowLoadError` — YAML parse or validation failure
- `WorkflowExecutionError` — Step execution failure
- `VariableInterpolationError` — Template interpolation failure
- `CommandStepNotSupportedError` — Command step encountered (not supported in MVP)

## Dependencies

- `zod` — Schema validation
- `yaml` — YAML parsing
- `mustache` — Variable interpolation

## Examples

See `examples/` directory:

- `data-analysis.workflow.yaml` — CSV data pipeline
- `api-integration.workflow.yaml` — User onboarding flow

## License

MIT
