import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const CorrelationId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
  const header = request.headers["x-correlation-id"];
  return typeof header === "string" && SAFE_ID.test(header) ? header : crypto.randomUUID();
});
