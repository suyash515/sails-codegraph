/** Error types mapped to CLI exit codes and MCP error payloads. */
export class UserInputError extends Error {
  readonly exitCode = 2;
  constructor(message: string, readonly hint?: string, readonly details?: unknown) {
    super(message);
  }
}

export class OperationalError extends Error {
  readonly exitCode = 1;
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}
